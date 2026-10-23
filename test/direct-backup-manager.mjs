import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectBackupManager } from "../direct-rws/backup-manager.mjs";

for (const method of ["plan_backup", "apply_backup", "verify_backup"]) {
  assert.equal(DirectBackupManager.supports(method), true);
}
assert.equal(DirectBackupManager.supports("commit_job"), false);

for (const protocol of ["rws1", "rws2"]) {
const payload = (items) => protocol === "rws2"
  ? { _embedded: { resources: items }, _links: {} }
  : { _embedded: { _state: items }, _links: {} };
const root = await mkdtemp(path.join(os.tmpdir(), "abb-direct-backup-manager-"));
const backupName = "backup_20260729_120000_a1b2c3d4";
const files = new Map([
  ["RAPID/MainModule.mod", Buffer.from("MODULE MainModule\nENDMODULE\n", "utf8")],
  ["SYSPAR/EIO.cfg", Buffer.from("EIO:CFG_1.0:6:1::\n", "utf8")]
]);

function directoryPayload(relativeDirectory) {
  const items = [];
  if (!relativeDirectory) {
    items.push({ _type: "fs-dir", _title: "RAPID" });
    items.push({ _type: "fs-dir", _title: "SYSPAR" });
  } else {
    const prefix = `${relativeDirectory}/`;
    for (const [relativePath, bytes] of files) {
      if (!relativePath.startsWith(prefix)) continue;
      const remainder = relativePath.slice(prefix.length);
      if (remainder.includes("/")) continue;
      items.push({
        _type: "fs-file",
        _title: remainder,
        ...(relativePath.endsWith("EIO.cfg") ? {} : { "fs-size": bytes.length })
      });
    }
  }
  return JSON.stringify(payload(items));
}

const identity = {
  Name: "EXAMPLE_CONTROLLER",
  SystemId: "11111111-2222-3333-4444-555555555555",
  RobotWare: "6.13.0164"
};
let closeCount = 0;
let backupPosts = 0;
let progressReads = 0;
let remoteConflictChecks = 0;
const service = {
  registry: { allowedLocalRoots: [root] },
  async binding(alias) {
    assert.equal(alias, "robot2");
    return {
      alias,
      config: {
        rwsProtocol: protocol,
        baseUrl: "http://127.0.0.1:80",
        longRequestTimeoutSeconds: 5
      }
    };
  },
  async identityForRead() {
    return { identity: { ...identity }, cacheHit: false, ageMs: 0 };
  },
  async controllerState() {
    return {
      Opmode: "AUTO",
      ControllerState: "guardstop",
      RapidState: "stopped"
    };
  },
  async closeBinding(alias) {
    assert.equal(alias, "robot2");
    closeCount += 1;
  },
  async bindingRequest(_binding, options, _operation, allowed) {
    const expectedRoot = protocol === "rws2" ? "/fileservice/$SYSPAR/" : "/fileservice/$SYSPAR/?json=1";
    if (protocol === "rws2") assert.ok(!options.path.includes("json="));
    if (options.method === "GET" && options.path === expectedRoot) {
      remoteConflictChecks += 1;
      const body = JSON.stringify(payload([]));
      return { statusCode: 200, body, bytes: Buffer.from(body, "utf8") };
    }
    if (options.method === "POST" && options.path === (protocol === "rws2" ? "/ctrl/backup/create" : "/ctrl/backup?action=backup")) {
      backupPosts += 1;
      assert.equal(options.form.archive, "FALSE");
      assert.equal(
        options.form.backup,
        `/fileservice/$SYSPAR/${backupName}`
      );
      assert.ok(allowed.includes(202));
      return {
        statusCode: 202,
        location: "/progress/1",
        body: "",
        bytes: Buffer.alloc(0)
      };
    }
    if (options.path.startsWith("/progress/1")) {
      progressReads += 1;
      if (protocol === "rws1") {
        // Observed on RW 6.11.1005: running first, then 303 See Other when finished.
        const finished = progressReads > 1;
        return {
          statusCode: finished ? 303 : 200,
          body: JSON.stringify(payload([finished
            ? { state: "ready", code: "294912" }
            : { state: "running", code: "" }])),
          bytes: Buffer.alloc(0)
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify(protocol === "rws2"
          ? { state: [{ state: "ready", code: "294913" }] }
          : payload([{ state: "DONE", code: "294913" }])),
        bytes: Buffer.alloc(0)
      };
    }
    const directoryMatch = options.path.match(
      new RegExp(
        `^/fileservice/\\$SYSPAR/${backupName}/(RAPID/|SYSPAR/)?(?:\\?json=1)?$`
      )
    );
    if (directoryMatch) {
      const relativeDirectory = String(directoryMatch[1] || "").replace(/\/$/, "");
      const body = directoryPayload(relativeDirectory);
      return {
        statusCode: 200,
        body,
        bytes: Buffer.from(body, "utf8")
      };
    }
    const filePrefix = `/fileservice/$SYSPAR/${backupName}/`;
    if (options.method === "GET" && options.path.startsWith(filePrefix)) {
      const relativePath = options.path.slice(filePrefix.length);
      const bytes = files.get(relativePath);
      if (!bytes) throw new Error(`Unexpected mock file request: ${relativePath}`);
      assert.ok(options.maxResponseBytes >= bytes.length);
      const streamResult = await options.consumeResponse([bytes]);
      return { statusCode: 200, streamedBytes: bytes.length, streamResult };
    }
    throw new Error(`Unexpected mock RWS request: ${options.method} ${options.path}`);
  }
};

const manager = new DirectBackupManager(service);
const progress = [];
try {
  const plan = await manager.call("plan_backup", {
    alias: "robot2",
    localRoot: root,
    backupName,
    cell: "1600-3",
    robot: "R2",
    timeoutSeconds: 60
  });
  assert.equal(plan.Planned, true);
  assert.equal(plan.ControllerModified, false);
  assert.equal(plan.RemoteExists, false);
  assert.match(plan.Token, /^[a-f0-9]{32}$/);
  assert.match(plan.PlanSha256, /^[a-f0-9]{64}$/);

  const applied = await manager.call(
    "apply_backup",
    { token: plan.Token },
    { onProgress: (event) => progress.push(event) }
  );
  assert.equal(applied.Applied, true);
  assert.equal(applied.ControllerModified, true);
  assert.equal(applied.FileCount, files.size);
  assert.equal(applied.RemoteBefore.FileCount, files.size);
  assert.equal(applied.RemoteAfter.FileCount, files.size);
  assert.equal(applied.RemoteBefore.KnownSizeCount, files.size - 1);
  assert.equal(applied.RemoteBefore.AllSizesKnown, false);
  assert.equal(applied.RemoteBefore.TotalBytes, null);
  assert.equal(backupPosts, 1);
  assert.equal(remoteConflictChecks, 2);
  assert.equal(progressReads, protocol === "rws1" ? 2 : 1);
  assert.ok(progress.some((event) => event.Phase === "backup_accepted"));
  assert.ok(progress.some((event) => event.Phase === "backup_completed"));

  const manifest = JSON.parse(await readFile(applied.ManifestPath, "utf8"));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.alias, "robot2");
  assert.equal(manifest.files.length, files.size);

  await assert.rejects(
    manager.call("apply_backup", { token: plan.Token }),
    /unknown or already-consumed/i
  );

  const registryPlan = await manager.call("plan_backup", {
    alias: "robot2",
    localRoot: root,
    backupName: "registry_recheck_20260729_a1b2c3d4",
    timeoutSeconds: 60
  });
  service.registry.allowedLocalRoots = [];
  await assert.rejects(
    manager.call("apply_backup", { token: registryPlan.Token }),
    /BackupApplyFailed:.*allowedLocalRoots/i
  );
  service.registry.allowedLocalRoots = [root];
  assert.equal(backupPosts, 1);
  assert.equal(remoteConflictChecks, 3);

  const binding = await service.binding("robot2");
  const missingStateManager = new DirectBackupManager({
    ...service,
    async bindingRequest() {
      const body = JSON.stringify({ _embedded: {}, _links: {} });
      return { statusCode: 200, body, bytes: Buffer.from(body) };
    }
  });
  await assert.rejects(
    missingStateManager.remoteBackupNameExists(binding, "future_backup"),
    (error) => error.code === "RwsFileServiceProtocolError"
  );
  missingStateManager.close();

  const failedProgressManager = new DirectBackupManager({
    ...service,
    async bindingRequest() {
      return { statusCode: 200, body: JSON.stringify(payload([{ state: "DONE", code: "-1" }])) };
    }
  });
  await assert.rejects(
    failedProgressManager.waitForProgress(binding, "/progress/1", Date.now() + 1000),
    /reported failure/
  );
  failedProgressManager.close();

  const futureTypeManager = new DirectBackupManager({
    ...service,
    async bindingRequest() {
      const body = JSON.stringify({
        _embedded: {
          _state: [{ _type: "future-directory-type", _title: "future_backup" }]
        },
        _links: {}
      });
      return { statusCode: 200, body, bytes: Buffer.from(body) };
    }
  });
  assert.equal(
    await futureTypeManager.remoteBackupNameExists(binding, "future_backup"),
    true
  );
  futureTypeManager.close();

  const verified = await manager.call("verify_backup", {
    manifestPath: applied.ManifestPath
  });
  assert.equal(verified.Verified, true);
  assert.equal(verified.FreshSession, true);
  assert.equal(verified.ControllerModified, false);
  assert.equal(verified.RemoteAllSizesKnown, false);
  assert.equal(verified.RemoteTotalBytes, null);
  assert.ok(verified.RemoteKnownBytes > 0);
  assert.equal(verified.LocalHashMismatches.length, 0);
  assert.equal(verified.RemoteMismatches.length, 0);
  assert.equal(closeCount, 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        protocol,
        backupPosts,
        progressReads,
        remoteConflictChecks,
        unknownRemoteSizeDownloaded: true,
        currentRegistryRecheckedBeforePost: true,
        malformedListingRejected: true,
        futureEntryTypeCollisionRejected: true,
        files: applied.FileCount,
        bytes: applied.TotalBytes,
        progressEvents: progress.length,
        freshSessionCloseCount: closeCount
      },
      null,
      2
    )
  );
} finally {
  manager.close();
  await rm(root, { recursive: true, force: true });
}
}
