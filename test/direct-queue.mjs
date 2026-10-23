import assert from "node:assert/strict";

import { DirectRwsService } from "../direct-rws/service.mjs";

const registryPath = new URL(
  "../controller-registry.example.json",
  import.meta.url
).pathname;
const service = new DirectRwsService({ registryPath, maxSockets: 4 });

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let readInvocations = 0;
let activeReads = 0;
let maximumActiveReads = 0;
service.invoke = async (method) => {
  readInvocations += 1;
  activeReads += 1;
  maximumActiveReads = Math.max(maximumActiveReads, activeReads);
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, method };
  } finally {
    activeReads -= 1;
  }
};

try {
  const writerStarted = deferred();
  let slowWriterCompleted = false;
  const slowWriter = service.runSerialized(
    "robot2",
    async () => {
      writerStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      slowWriterCompleted = true;
    },
    500
  );
  await writerStarted.promise;

  const shortReadStarted = performance.now();
  let shortReadElapsedMs = 0;
  const shortRead = assert
    .rejects(
      service.call("snapshot", { alias: "robot2" }, 5_000, 100),
      (error) => {
        assert.equal(error.code, "WorkerBusy");
        assert.match(error.message, /shared read remained blocked/i);
        assert.match(error.message, /active operation was not interrupted/i);
        return true;
      }
    )
    .finally(() => {
      shortReadElapsedMs = performance.now() - shortReadStarted;
    });
  const secondWriter = assert.rejects(
    service.runSerialized("robot2", async () => ({ unexpected: true }), 100),
    (error) => {
      assert.equal(error.code, "WorkerBusy");
      assert.match(error.message, /exclusive operation remained blocked/i);
      return true;
    }
  );
  const readsStarted = performance.now();
  const reads = Array.from({ length: 5 }, (_, index) =>
    service.call(
      "snapshot",
      { alias: "robot2", sample: index },
      5_000,
      4_000
    )
  );
  const [, , readResults] = await Promise.all([
    shortRead,
    secondWriter,
    Promise.all(reads)
  ]);
  const readsElapsedMs = performance.now() - readsStarted;
  await slowWriter;
  assert.equal(slowWriterCompleted, true);
  assert.equal(readResults.length, 5);
  assert.equal(readInvocations, 5);
  assert.equal(
    maximumActiveReads,
    1,
    "snapshot fan-outs must reserve the per-alias HTTP budget before entering"
  );
  assert.ok(shortReadElapsedMs >= 80, `WorkerBusy fired too early: ${shortReadElapsedMs} ms`);
  assert.ok(readsElapsedMs >= 3_000, `reads bypassed the active writer: ${readsElapsedMs} ms`);
  assert.ok(readsElapsedMs < 4_000, `reads exceeded their queue budget: ${readsElapsedMs} ms`);

  readInvocations = 0;
  activeReads = 0;
  maximumActiveReads = 0;
  service.invoke = async (method) => {
    readInvocations += 1;
    activeReads += 1;
    maximumActiveReads = Math.max(maximumActiveReads, activeReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true, method };
    } finally {
      activeReads -= 1;
    }
  };
  const capacityStarted = performance.now();
  const capacityReads = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      service.call(
        "read_signals",
        { alias: "robot2", names: [`Signal_${index}`] },
        2_000,
        100
      )
    )
  );
  const capacityElapsedMs = performance.now() - capacityStarted;
  assert.equal(capacityReads.length, 5);
  assert.equal(readInvocations, 5);
  assert.equal(maximumActiveReads, 4);
  assert.ok(
    capacityElapsedMs >= 350 && capacityElapsedMs < 700,
    `read capacity was not bounded without read-read timeout: ${capacityElapsedMs} ms`
  );

  const heldReadStarted = deferred();
  const releaseHeldRead = deferred();
  let unknownInvoked = false;
  service.invoke = async (method, params) => {
    if (method === "snapshot" && params.hold === true) {
      heldReadStarted.resolve();
      await releaseHeldRead.promise;
      return { ok: true };
    }
    if (method === "future_unregistered_method") unknownInvoked = true;
    return { ok: true };
  };
  const heldRead = service.call(
    "snapshot",
    { alias: "robot2", hold: true },
    2_000,
    500
  );
  await heldReadStarted.promise;
  await assert.rejects(
    service.call(
      "future_unregistered_method",
      { alias: "robot2" },
      2_000,
      100
    ),
    (error) => error?.code === "WorkerBusy"
  );
  assert.equal(unknownInvoked, false, "unknown methods must default to exclusive");
  const preferredWriterStarted = deferred();
  const preferredWriter = service.runSerialized(
    "robot2",
    async () => {
      preferredWriterStarted.resolve();
      return { ok: true };
    },
    500
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.call(
      "read_signals",
      { alias: "robot2", names: ["LateReader"] },
      2_000,
      100
    ),
    (error) => error?.code === "WorkerBusy"
  );
  releaseHeldRead.resolve();
  await heldRead;
  await preferredWriter;
  await preferredWriterStarted.promise;

  const closingService = new DirectRwsService({ registryPath, maxSockets: 4 });
  const closeStarted = deferred();
  const closeRelease = deferred();
  closingService.invoke = async () => {
    closeStarted.resolve();
    await closeRelease.promise;
    return { ok: true };
  };
  const entered = closingService.call(
    "snapshot",
    { alias: "robot2" },
    1_000,
    500
  );
  await closeStarted.promise;
  const drainingClose = closingService.close();
  await assert.rejects(
    closingService.call("health", {}),
    /closing or closed/,
    "service close must reject calls that did not enter before draining"
  );
  assert.equal(closingService.closed, false);
  closeRelease.resolve();
  await entered;
  await drainingClose;
  assert.equal(closingService.closed, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        writerDurationMs: 3_100,
        readsDuringWriter: readResults.length,
        maximumConcurrentReads: maximumActiveReads,
        shortReadWorkerBusyMs: Math.round(shortReadElapsedMs),
        readsWaitedAndCompletedMs: Math.round(readsElapsedMs),
        readCapacityBatchMs: Math.round(capacityElapsedMs),
        unknownMethodFailClosed: true,
        writerPreferenceEnforced: true,
        activeOperationsNotInterrupted: true,
        closeDrainedActiveOperation: true
      },
      null,
      2
    )
  );
} finally {
  await service.close();
}
