import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { executeBatch, executeCommand, loadBatch } from "../abbctl.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

class FakeClient {
  constructor() {
    this.calls = [];
  }

  async callTool(request) {
    this.calls.push(request);
    if (request.name === "abb_plan_backup") {
      return {
        structuredContent: {
          Planned: true,
          Token: "0123456789abcdef0123456789abcdef",
          LocalPath: path.join(request.arguments.localRoot, request.arguments.backupName)
        }
      };
    }
    if (request.name === "abb_apply_backup") {
      return {
        structuredContent: {
          Applied: true,
          Token: request.arguments.token,
          ManifestPath: "backup_manifest.json"
        }
      };
    }
    if (request.name === "abb_verify_backup") {
      return {
        structuredContent: {
          Verified: true,
          ManifestPath: request.arguments.manifestPath
        }
      };
    }
    return {
      structuredContent: {
        tool: request.name,
        arguments: request.arguments
      }
    };
  }
}

const fake = new FakeClient();
const fakeBatch = await executeBatch(fake, [
  { id: "first", command: "health", args: [] },
  { id: "second", command: "health", args: [] },
  { id: "modules", command: "modules", args: ["robot2"] },
  { id: "io", command: "io-config", args: ["robot2", "PF_"] }
]);
assert.equal(fakeBatch.exitCode, 0);
assert.equal(fakeBatch.result.executedCommands, 4);
assert.deepEqual(
  fake.calls.map((call) => call.name),
  ["abb_health", "abb_health", "abb_list_rapid_modules", "abb_list_config_instances"]
);
assert.deepEqual(fake.calls[2].arguments, { alias: "robot2" });
assert.equal(fake.calls[3].arguments.prefix, "PF_");

await assert.rejects(
  () => executeCommand(fake, "modules", ["robot2", ""]),
  /Missing RAPID task/
);

await executeCommand(fake, "modules", ["robot2", "T_EXPLICIT"]);
assert.deepEqual(fake.calls.at(-1).arguments, {
  alias: "robot2",
  task: "T_EXPLICIT"
});
await assert.rejects(
  () => executeCommand(fake, "probe", ["http://192.0.2.10"]),
  /Missing credential alias/
);
await assert.rejects(
  () => executeCommand(fake, "register", [
    "new_robot",
    "http://192.0.2.10",
    "rws1",
    "-",
    "NEW_ROBOT",
    "11111111-2222-3333-4444-555555555555",
    "6.13.0164",
    "robot2"
  ]),
  /Missing default RAPID task/
);
const registrationClient = new FakeClient();
await executeCommand(registrationClient, "register", [
  "new_robot",
  "http://192.0.2.10",
  "rws1",
  "-",
  "NEW_ROBOT",
  "11111111-2222-3333-4444-555555555555",
  "6.13.0164",
  "robot2",
  "T_MAIN",
  "PROFINET",
  "PN_Internal_Device"
]);
assert.deepEqual(registrationClient.calls[0].arguments, {
  alias: "new_robot",
  baseUrl: "http://192.0.2.10",
  rwsProtocol: "rws1",
  expectedName: "NEW_ROBOT",
  expectedSystemId: "11111111-2222-3333-4444-555555555555",
  expectedRobotWare: "6.13.0164",
  credentialAlias: "robot2",
  defaultTask: "T_MAIN",
  ioNetwork: "PROFINET",
  ioDevice: "PN_Internal_Device"
});

await assert.rejects(
  () => executeCommand(fake, "apply", ["job.json"]),
  /explicit --yes/
);
await assert.rejects(
  () => executeCommand(fake, "backup-apply", ["robot2", "D:\\backups", "run-1"]),
  /explicit --yes/
);
await assert.rejects(
  () => executeBatch(fake, [{ command: "batch", args: ["nested.json"] }]),
  /cannot recursively run batch/
);

const temp = await mkdtemp(path.join(os.tmpdir(), "abbctl-batch-"));
try {
  const backupRoot = path.join(temp, "backups");
  const backupPlanClient = new FakeClient();
  const backupPlan = await executeCommand(backupPlanClient, "backup-plan", [
    "robot2",
    backupRoot,
    "run-1",
    "cell-a",
    "robot-a"
  ]);
  assert.equal(backupPlan.exitCode, 0);
  assert.equal(backupPlan.result.Planned, true);
  assert.deepEqual(backupPlanClient.calls, [
    {
      name: "abb_plan_backup",
      arguments: {
        alias: "robot2",
        localRoot: backupRoot,
        backupName: "run-1",
        cell: "cell-a",
        robot: "robot-a"
      }
    }
  ]);

  const backupApplyClient = new FakeClient();
  const backupApply = await executeCommand(backupApplyClient, "backup-apply", [
    "robot2",
    backupRoot,
    "run-2",
    "--yes"
  ]);
  assert.equal(backupApply.exitCode, 0);
  assert.equal(backupApply.result.plan.Planned, true);
  assert.equal(backupApply.result.apply.Applied, true);
  assert.equal(
    backupApply.result.apply.Token,
    backupApply.result.plan.Token
  );
  assert.deepEqual(
    backupApplyClient.calls.map((call) => call.name),
    ["abb_plan_backup", "abb_apply_backup"]
  );
  assert.deepEqual(backupApplyClient.calls[0].arguments, {
    alias: "robot2",
    localRoot: backupRoot,
    backupName: "run-2"
  });
  assert.deepEqual(backupApplyClient.calls[1].arguments, {
    token: backupApply.result.plan.Token
  });

  const manifestPath = path.join(backupRoot, "run-2", "backup_manifest.json");
  const backupVerifyClient = new FakeClient();
  const backupVerify = await executeCommand(backupVerifyClient, "backup-verify", [
    manifestPath
  ]);
  assert.equal(backupVerify.exitCode, 0);
  assert.equal(backupVerify.result.Verified, true);
  assert.deepEqual(backupVerifyClient.calls, [
    {
      name: "abb_verify_backup",
      arguments: { manifestPath: path.resolve(manifestPath) }
    }
  ]);

  const batchPath = path.join(temp, "health.json");
  const blockedPath = path.join(temp, "blocked.json");
  await writeFile(blockedPath, JSON.stringify({ version: 1, controller: "mock", operations: [] }));
  const blockedCalls = [];
  const blockedClient = { callTool: async (request) => {
    blockedCalls.push(request.name);
    return { structuredContent: { Prepared: false, Preview: true, SafetyBlocked: true } };
  } };
  const blocked = await executeCommand(blockedClient, "apply", [blockedPath, "--yes"]);
  assert.equal(blocked.exitCode, 2);
  assert.deepEqual(blockedCalls, ["abb_plan_changeset"]);
  await writeFile(
    batchPath,
    JSON.stringify([
      { id: "cold", command: "health", args: [] },
      { id: "hot", command: "health", args: [] }
    ]),
    "utf8"
  );
  const loaded = await loadBatch(batchPath);
  assert.equal(loaded.commands.length, 2);

  const child = spawn(process.execPath, [path.join(root, "abbctl.mjs"), "batch", batchPath], {
    cwd: root,
    env: { ...process.env, ABB_MCP_CHANGESET_BACKEND: "direct-rws-preview", ABB_MCP_ALLOW_LEGACY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.ok, true);
  assert.equal(output.executedCommands, 2);
  assert.equal(output.commands[0].result.backends.changeset, "direct-rws-preview");
  assert.equal(output.commands[0].result.legacy.enabled, false);
  assert.equal(output.commands[0].result.pid, output.commands[1].result.pid);
  assert.ok(output.commands[0].durationMs > output.commands[1].durationMs);
  assert.ok(output.connectMs >= 0);

  console.log(
    JSON.stringify(
      {
        ok: true,
        commandCount: output.executedCommands,
        reusedWorkerPid: output.commands[0].result.pid,
        connectMs: output.connectMs,
        firstCommandMs: output.commands[0].durationMs,
        secondCommandMs: output.commands[1].durationMs
      },
      null,
      2
    )
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
