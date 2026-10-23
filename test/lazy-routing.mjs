import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  AbbBackendRouter,
  CHANGESET_BACKEND_DIRECT_PREVIEW
} from "../backend-router.mjs";
import { changesetPolicySignature } from "../direct-rws/changeset-policy.mjs";
import {
  DIRECT_EXCLUSIVE_METHODS,
  DIRECT_SHARED_READ_METHODS,
  directMethodLockMode,
  isDirectBackupMethod,
  isDirectChangesetMethod
} from "../direct-rws/method-routing.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const registryPath = fileURLToPath(
  new URL("../controller-registry.example.json", import.meta.url)
);

for (const method of ["plan_backup", "apply_backup", "verify_backup"]) {
  assert.equal(isDirectBackupMethod(method), true);
  assert.equal(isDirectChangesetMethod(method), false);
}
for (const method of ["prepare_changeset", "commit_job", "verify_changeset"]) {
  assert.equal(isDirectChangesetMethod(method), true);
  assert.equal(isDirectBackupMethod(method), false);
  assert.equal(directMethodLockMode(method), "write");
}
for (const method of DIRECT_SHARED_READ_METHODS) {
  assert.equal(directMethodLockMode(method), "read");
}
for (const method of DIRECT_EXCLUSIVE_METHODS) {
  assert.equal(directMethodLockMode(method), "write");
}
assert.equal(directMethodLockMode("future_unregistered_method"), "write");

let backupLoads = 0;
let backupCloses = 0;
class FakeBackupManager {
  constructor(service) {
    this.service = service;
  }

  async aliasFor(_method, params) {
    return String(params.alias || "robot2");
  }

  async call(method) {
    return { Backend: "direct-backup", Method: method };
  }

  close() {
    backupCloses += 1;
  }
}

const directService = new DirectRwsService({
  registryPath,
  backupManagerLoader: async () => {
    backupLoads += 1;
    return { DirectBackupManager: FakeBackupManager };
  }
});
const directHealth = await directService.call("health", {});
assert.equal(directHealth.backend, "direct-rws");
assert.equal(backupLoads, 0, "health must not load the backup implementation");
const backupResult = await directService.call("plan_backup", { alias: "robot2" });
assert.deepEqual(backupResult, {
  Backend: "direct-backup",
  Method: "plan_backup"
});
assert.equal(backupLoads, 1);
await directService.call("plan_backup", { alias: "robot2" });
assert.equal(backupLoads, 1, "backup implementation must be loaded once");
await directService.close();
assert.equal(backupCloses, 1);

class FakeDirectService {
  constructor() {
    this.busy = false;
    this.closed = false;
    this.registry = {
      allowedConfigDomains: ["eio", "sio", "sys", "proc"],
      allowedLocalRoots: ["C:\\mock"],
      controllers: {}
    };
  }

  async call(method) {
    assert.equal(method, "health");
    return {
      ok: true,
      service: "fake-direct-rws",
      version: "test",
      powershell: "not used",
      pid: process.pid
    };
  }

  async reloadRegistry() {
    return false;
  }

  async runSerialized(_alias, operation) {
    return await operation();
  }

  async close() {
    this.closed = true;
  }
}

class FakeLegacyWorker {
  constructor() {
    this.closed = false;
    this.busy = false;
  }

  async call(method) {
    if (method === "health") {
      return { powershell: "7.test", pid: 1234 };
    }
    return { Backend: "legacy", Method: method };
  }

  async close() {
    this.closed = true;
  }
}

let legacyChangesetLoads = 0;
const legacyRouter = new AbbBackendRouter({
  directService: new FakeDirectService(),
  directChangesetLoader: async () => {
    legacyChangesetLoads += 1;
    throw new Error("legacy routing must not load direct changesets");
  },
  legacyWorkerFactory: () => new FakeLegacyWorker()
});
const legacyHealth = await legacyRouter.call("health", {});
assert.deepEqual(legacyHealth.backends, {
  read: "direct-rws",
  changeset: "legacy-powershell",
  backup: "direct-rws"
});
const legacyResult = await legacyRouter.call("prepare_changeset", {
  changeset: { controller: "robot2", operations: [] }
});
assert.equal(legacyResult.Backend, "legacy");
assert.equal(legacyChangesetLoads, 0);
await legacyRouter.close();

const previewDirect = new FakeDirectService();
let previewLoads = 0;
let previewFactoryCalls = 0;
let previewCloseCalls = 0;
const previewStack = {
  policySha256: changesetPolicySignature(previewDirect.registry),
  manager: {
    async aliasFor() {
      return "robot2";
    },
    async call(method) {
      return { Backend: "direct", Method: method };
    }
  },
  async close() {
    previewCloseCalls += 1;
  }
};
const previewRouter = new AbbBackendRouter({
  directService: previewDirect,
  allowLegacy: false,
  changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
  directChangesetLoader: async () => {
    previewLoads += 1;
    return {
      createDirectChangesetStack({ protocol }) {
        assert.equal(protocol, "rws1+rws2");
        previewFactoryCalls += 1;
        return previewStack;
      }
    };
  },
  legacyWorkerFactory() {
    throw new Error("direct preview must not start legacy");
  }
});
const previewHealth = await previewRouter.call("health", {});
assert.deepEqual(previewHealth.backends, {
  read: "direct-rws",
  changeset: "direct-rws-preview",
  backup: "direct-rws"
});
assert.equal(previewLoads, 0, "health must not load the changeset stack");
const previewResult = await previewRouter.call("prepare_changeset", {
  changeset: { controller: "robot2", operations: [] }
});
assert.equal(previewResult.Backend, "direct");
assert.equal(previewLoads, 1);
assert.equal(previewFactoryCalls, 1);
await previewRouter.call("verify_changeset", { token: "a".repeat(32) });
assert.equal(previewLoads, 1, "changeset stack must be loaded once");
assert.equal(previewFactoryCalls, 1);
await previewRouter.close();
assert.equal(previewCloseCalls, 1);

console.log("lazy backend routing tests passed");
