import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pwsh =
  process.env.ABB_MCP_PWSH ||
  "pwsh";

const child = spawn(
  pwsh,
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "abb-worker.ps1")],
  { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
);

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  clearTimeout(handler.timer);
  if (message.ok) handler.resolve(message.result);
  else handler.reject(new Error(message.error?.message || "worker error"));
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code, signal) => {
  for (const handler of pending.values()) {
    clearTimeout(handler.timer);
    handler.reject(new Error(`worker exited code=${code} signal=${signal}`));
  }
  pending.clear();
});

let id = 0;
function call(method, params = {}, timeoutMs = 10_000) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`worker smoke timed out after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
}

try {
  const health = await call("health");
  const controllers = await call("list_controllers");
  if (!health.ok || !Array.isArray(controllers.Controllers)) {
    throw new Error("worker smoke assertions failed");
  }
  let backupLibraryLoaded = false;
  try {
    await call("verify_backup", {
      manifestPath: path.join(root, "artifacts", "does-not-exist-backup-manifest.json")
    });
  } catch (error) {
    if (!/does not exist|not found/i.test(error.message)) throw error;
    backupLibraryLoaded = true;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        health,
        controllerAliases: controllers.Controllers.map((x) => x.Alias),
        backupLibraryLoaded
      },
      null,
      2
    )
  );
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill();
        resolve();
      }, 3_000)
    )
  ]);
}
