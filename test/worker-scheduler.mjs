import { fileURLToPath } from "node:url";
import path from "node:path";
import { PowerShellWorker } from "../worker-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeWorker = path.join(here, "fake-json-worker.mjs");

function createWorker(queueTimeoutMs = 100) {
  return new PowerShellWorker({
    command: process.execPath,
    args: [fakeWorker],
    cwd: here,
    windowsHide: true,
    stderrPrefix: "[fake-worker]",
    defaultQueueTimeoutMs: queueTimeoutMs
  });
}

async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (!pattern.test(error.message)) {
      throw new Error(`Unexpected rejection: ${error.message}`);
    }
    return error;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}

let worker = createWorker(500);
try {
  const initial = await worker.call("health", {}, 1_000);
  const slow = worker.call("delay", { delayMs: 180 }, 1_000, 500);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const queuedShortExecution = worker.call("health", {}, 40, 500);
  const [slowResult, queuedResult] = await Promise.all([slow, queuedShortExecution]);
  if (slowResult.pid !== initial.pid || queuedResult.pid !== initial.pid) {
    throw new Error("dispatch-time timeout test did not reuse one worker");
  }

  const active = worker.call("commit_job", { delayMs: 180 }, 1_000, 500);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const busyStarted = performance.now();
  await expectReject(worker.call("health", {}, 1_000, 30), /WorkerBusy|not started/i);
  const busyElapsedMs = performance.now() - busyStarted;
  if (busyElapsedMs > 150) {
    throw new Error(`queued busy response was too slow: ${busyElapsedMs}ms`);
  }
  await active;
  const afterBusy = await worker.call("health", {}, 1_000);
  if (afterBusy.pid !== initial.pid) {
    throw new Error("queued timeout killed the active worker");
  }

  const progressEvents = [];
  const progressResult = await worker.call(
    "progress",
    {},
    1_000,
    500,
    (event) => progressEvents.push(event)
  );
  if (
    progressResult.method !== "progress" ||
    progressEvents.map((event) => event.phase).join(",") !== "one,two"
  ) {
    throw new Error(`worker progress sideband mismatch: ${JSON.stringify(progressEvents)}`);
  }
} finally {
  await worker.close();
}

worker = createWorker(500);
let timedOutPid;
try {
  timedOutPid = (await worker.call("health", {}, 1_000)).pid;
  await expectReject(
    worker.call("commit_job", { delayMs: 250 }, 30),
    /ControllerWriteUnknown.*method timed out after 30 ms/i
  );
  if (!worker.closed) throw new Error("active execution timeout did not close the worker");
} finally {
  await worker.close();
}

const replacement = createWorker(500);
try {
  const replacementHealth = await replacement.call("health", {}, 1_000);
  if (replacementHealth.pid === timedOutPid) {
    throw new Error("replacement worker did not get a new process");
  }
} finally {
  await replacement.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dispatchTimeoutStartsWhenActive: true,
      queuedBusyDoesNotKillActive: true,
      activeTimeoutRecyclesWorker: true,
      progressSideband: true
    },
    null,
    2
  )
);
