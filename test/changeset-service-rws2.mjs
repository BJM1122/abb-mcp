import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDirectChangesetStack } from "../direct-rws/changeset-stack.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const SYSTEM_ID = "33333333-4444-5555-6666-777777777777";

function response(state, statusCode = 200, extra = {}) {
  return {
    statusCode,
    headers: {},
    bytes: Buffer.from(
      statusCode === 204
        ? ""
        : JSON.stringify({ state: Array.isArray(state) ? state : [state], ...extra })
    ),
    get body() {
      return this.bytes.toString("utf8");
    }
  };
}

class FakeRws2Client {
  constructor(model, serial) {
    this.model = model;
    this.serial = serial;
    this.closed = false;
    this.requests = [];
    this.maxSockets = 2;
  }

  async request(options) {
    if (this.closed) {
      const error = new Error("fake RWS2 session closed");
      error.code = "ECONNRESET";
      throw error;
    }
    const method = String(options.method || "GET").toUpperCase();
    const requestPath = String(options.path);
    this.requests.push({ method, path: requestPath });

    if (method === "GET" && requestPath === "/rw/system") {
      return response({
        name: "MOCK_OMNICORE",
        sysid: SYSTEM_ID,
        rwversion: "7.20.0+1391"
      });
    }
    if (method === "GET" && requestPath === "/rw/panel/opmode") {
      return response({ opmode: "MANR" });
    }
    if (method === "GET" && requestPath === "/rw/panel/ctrl-state") {
      return response({ ctrlstate: "guardstop" });
    }
    if (method === "GET" && requestPath === "/rw/rapid/execution") {
      return response({ ctrlexecstate: "stopped" });
    }
    if (
      method === "GET" &&
      requestPath === "/rw/rapid/symbol/RAPID/T_ROB1/MainModule/Revision/data"
    ) {
      return response({ _type: "rap-data", value: this.model.revision });
    }
    if (method === "GET" && requestPath === "/rw/rapid/tasks/T_ROB1/modules") {
      return response([
        { name: "MainModule", type: "ProgMod" },
        { name: "WorldZone", type: "SysMod" }
      ]);
    }
    if (
      method === "GET" &&
      requestPath === "/rw/rapid/tasks/T_ROB1/modules/MainModule/text"
    ) {
      return response({ "file-path": "/TEMP/pusres.12345" });
    }
    if (method === "GET" && requestPath === "/fileservice/TEMP/pusres.12345") {
      const bytes = Buffer.from(this.model.moduleText, "utf8");
      return {
        statusCode: 200,
        headers: { "content-type": "application/octet-stream;v=2.0" },
        bytes,
        get body() {
          return this.bytes.toString("utf8");
        }
      };
    }
    if (
      method === "GET" &&
      requestPath === "/rw/cfg/eio/EIO_SIGNAL/instances?limit=10"
    ) {
      return response(
        [
          {
            _title: "PF_DI01",
            instanceid: "1",
            rdonly: false,
            attrib: [{ _title: "Name", value: "PF_DI01" }]
          }
        ],
        200,
        {
          _links: {
            next: { href: "/rw/cfg/eio/EIO_SIGNAL/instances?cursor=opaque" }
          }
        }
      );
    }
    if (
      method === "GET" &&
      requestPath === "/rw/cfg/eio/EIO_SIGNAL/instances?cursor=opaque"
    ) {
      return response([
        {
          _title: "PF_DO01",
          instanceid: "2",
          rdonly: false,
          attrib: [{ _title: "Name", value: "PF_DO01" }]
        }
      ]);
    }
    if (
      method === "GET" &&
      requestPath === "/rw/cfg/eio/EIO_SIGNAL/instances/PF_DI01"
    ) {
      return response({
        _title: "PF_DI01",
        instanceid: "1",
        rdonly: false,
        attrib: [
          { _title: "Name", value: "PF_DI01" },
          { _title: "Device", value: "PN_Internal_Device" }
        ]
      });
    }
    if (
      method === "GET" &&
      requestPath ===
        "/rw/iosystem/signals/PROFINET/PN_Internal_Device/PF_DI01"
    ) {
      return response({
        _title: "PROFINET/PN_Internal_Device/PF_DI01",
        name: "PF_DI01",
        lvalue: "1",
        lstate: "high",
        phstate: "valid",
        quality: "good"
      });
    }
    if (
      method === "GET" &&
      requestPath ===
        "/rw/rapid/tasks/T_ROB1/motion/robtarget?tool=tool0&wobj=wobj0"
    ) {
      return response({
        x: "1",
        y: "2",
        z: "3",
        q1: "1",
        q2: "0",
        q3: "0",
        q4: "0",
        cf1: "0",
        cf4: "0",
        cf6: "0",
        cfx: "0",
        eax_a: "9E+09",
        eax_b: "9E+09",
        eax_c: "9E+09",
        eax_d: "9E+09",
        eax_e: "9E+09",
        eax_f: "9E+09"
      });
    }
    if (method === "POST" && requestPath === "/rw/mastership/request") {
      this.model.mastership = true;
      return response([], 204);
    }
    if (method === "POST" && requestPath === "/rw/mastership/release") {
      this.model.mastership = false;
      return response([], 204);
    }
    if (method === "POST" && requestPath === "/fileservice/$HOME/create") {
      return response([], 201);
    }
    if (method === "PUT" && requestPath.startsWith("/fileservice/$HOME/")) {
      const controllerPath = requestPath.replace("/fileservice/", "");
      this.model.files.set(controllerPath, Buffer.from(options.bytes));
      return response([], 201);
    }
    if (method === "DELETE" && requestPath.startsWith("/fileservice/$HOME/")) {
      return response([], 204);
    }
    if (method === "POST" && requestPath === "/rw/rapid/tasks/T_ROB1/loadmod") {
      assert.ok(String(options.form.modulepath).endsWith(".modx"));
      assert.equal(this.model.mastership, true);
      const bytes = this.model.files.get(String(options.form.modulepath));
      assert.ok(bytes, `Staged module not found: ${options.form.modulepath}`);
      this.model.moduleText = bytes.toString("utf8");
      return response({ name: "MainModule" }, 200);
    }
    if (method === "POST" && requestPath === "/rw/rapid/tasks/T_ROB1/build") {
      assert.equal(this.model.mastership, true);
      return response([], 204);
    }
    if (
      method === "GET" &&
      requestPath === "/rw/rapid/tasks/T_ROB1/program/builderror?start=1&limit=30"
    ) {
      return response([]);
    }
    if (
      method === "POST" &&
      requestPath ===
        "/rw/rapid/symbol/RAPID/T_ROB1/MainModule/Revision/data?initval=true"
    ) {
      assert.equal(this.model.mastership, true);
      this.model.revision = String(options.form.value);
      return response([], 204);
    }
    throw new Error(`Unexpected fake RWS2 request: ${method} ${requestPath}`);
  }

  async requestOk(options, operation, allowed = [200]) {
    const result = await this.request(options);
    if (!allowed.includes(result.statusCode)) {
      throw new Error(`${operation} failed HTTP ${result.statusCode}`);
    }
    return result;
  }

  async close() {
    this.closed = true;
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "abb-rws2-changeset-"));
const registryPath = path.join(temporary, "controller-registry.json");
const registry = {
  version: 1,
  allowedConfigDomains: ["eio", "sio", "sys", "proc"],
  allowedLocalRoots: [temporary],
  controllers: {
    omnicore: {
      baseUrl: "https://192.0.2.20",
      rwsProtocol: "rws2",
      certificateSha256:
        "E72AC4601CD9781BDEDA452EBD39BF2CF532A8B1BF69F0C4B8E3AB3313E37321",
      expectedName: "MOCK_OMNICORE",
      expectedSystemId: SYSTEM_ID,
      expectedRobotWare: "7.20.0+1391",
      username: "Default User",
      credentialFile: "mock-only.clixml",
      defaultTask: "T_ROB1",
      ioNetwork: "PROFINET",
      ioDevice: "PN_Internal_Device",
      requestTimeoutSeconds: 3,
      longRequestTimeoutSeconds: 30
    }
  }
};
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

const model = {
  revision: "7",
  moduleText: "MODULE MainModule\nENDMODULE\n",
  mastership: false,
  files: new Map()
};
const clients = [];
const service = new DirectRwsService({ registryPath });
service.newClient = async () => {
  const client = new FakeRws2Client(model, clients.length + 1);
  clients.push(client);
  return client;
};

try {
  await service.reloadRegistry();
  const probe = await service.probeController({
    baseUrl: "https://192.0.2.20",
    credentialAlias: "omnicore",
    rwsProtocol: "rws2",
    certificateSha256: registry.controllers.omnicore.certificateSha256
  });
  assert.equal(probe.RwsProtocol, "rws2");
  assert.equal(probe.Identity.SystemId, SYSTEM_ID);

  const registered = await service.registerController({
    alias: "omnicore_copy",
    baseUrl: "https://192.0.2.20",
    credentialAlias: "omnicore",
    rwsProtocol: "rws2",
    certificateSha256: registry.controllers.omnicore.certificateSha256,
    expectedName: "MOCK_OMNICORE",
    expectedSystemId: SYSTEM_ID,
    expectedRobotWare: "7.20.0+1391",
    defaultTask: "T_ROB1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  });
  assert.equal(registered.RwsProtocol, "rws2");
  assert.equal(
    service.registry.controllers.omnicore_copy.certificateSha256,
    registry.controllers.omnicore.certificateSha256
  );
  await service.reloadRegistry();

  const binding = await service.binding("omnicore", { bypassCircuit: true });
  assert.deepEqual(
    (await service.rapidModules(binding, "T_ROB1")).map((item) => item.Name),
    ["MainModule", "WorldZone"]
  );
  const replacementPath = path.join(temporary, "MainModule.modx");
  const replacementText =
    "MODULE MainModule\n  !喷涂程序\n  CONST num BuildMarker := 8;\nENDMODULE\n";
  await writeFile(replacementPath, replacementText, "utf8");
  assert.match(
    await service.rapidModuleText(binding, "T_ROB1", "MainModule"),
    /^MODULE MainModule/
  );
  assert.equal(
    (await service.configInstances(binding, "eio", "EIO_SIGNAL")).length,
    2
  );
  assert.equal(
    (
      await service.configInstance(
        binding,
        "eio",
        "EIO_SIGNAL",
        "PF_DI01"
      )
    ).Attributes.Device,
    "PN_Internal_Device"
  );
  assert.equal((await service.exactSignal(binding, "PF_DI01")).Value, "1");
  assert.deepEqual(
    (await service.currentRobtarget(binding, "T_ROB1", "tool0", "wobj0")).Trans,
    { X: 1, Y: 2, Z: 3 }
  );

  const stack = createDirectChangesetStack({
    service,
    policy: registry,
    protocol: "rws1+rws2"
  });
  try {
    const plan = await stack.manager.call("prepare_changeset", {
      changeset: {
        version: 1,
        controller: "omnicore",
        expectedController: {
          name: "MOCK_OMNICORE",
          systemId: SYSTEM_ID,
          robotWare: "7.20.0+1391"
        },
        safety: {
          requireRapidStopped: true,
          allowedControllerStates: ["guardstop", "motoroff"]
        },
        operations: [
          {
            kind: "rapid_set_init",
            task: "T_ROB1",
            module: "MainModule",
            name: "Revision",
            value: 8
          }
        ]
      }
    });
    assert.equal(plan.ChangesRequired, 1);
    assert.equal(plan.Identity.Protocol, "rws2");

    const applied = await stack.manager.call("commit_job", { token: plan.Token });
    assert.equal(applied.Applied, true);
    assert.equal(applied.ControllerModified, true);
    assert.equal(model.revision, "8");
    assert.equal(model.mastership, false);
    assert.ok(clients.length >= 2, "Apply verification must create a fresh RWS2 session.");

    const paths = clients.flatMap((client) => client.requests.map((item) => item.path));
    assert.equal(paths.filter((item) => item === "/rw/mastership/request").length, 1);
    assert.equal(paths.filter((item) => item === "/rw/mastership/release").length, 1);
    assert.equal(
      paths.filter(
        (item) =>
          item ===
          "/rw/rapid/symbol/RAPID/T_ROB1/MainModule/Revision/data?initval=true"
      ).length,
      1,
      "RWS2 mutation must not be replayed."
    );

    const modulePlan = await stack.manager.call("prepare_changeset", {
      changeset: {
        version: 1,
        controller: "omnicore",
        expectedController: {
          name: "MOCK_OMNICORE",
          systemId: SYSTEM_ID,
          robotWare: "7.20.0+1391"
        },
        safety: {
          requireRapidStopped: true,
          allowedControllerStates: ["guardstop", "motoroff"]
        },
        operations: [
          {
            kind: "rapid_module_put",
            task: "T_ROB1",
            module: "MainModule",
            localPath: replacementPath
          }
        ]
      }
    });
    assert.equal(modulePlan.ChangesRequired, 1);
    const moduleApplied = await stack.manager.call("commit_job", {
      token: modulePlan.Token
    });
    assert.equal(moduleApplied.Applied, true);
    assert.equal(moduleApplied.BuildVerification[0].ErrorCount, 0);
    assert.equal(model.moduleText, replacementText);
    const legacyPath = path.join(temporary, "MainModule.mod");
    await writeFile(legacyPath, replacementText, "utf8");
    await assert.rejects(stack.manager.call("prepare_changeset", {
      changeset: { version: 1, controller: "omnicore",
        expectedController: { name: "MOCK_OMNICORE", systemId: SYSTEM_ID, robotWare: "7.20.0+1391" },
        safety: { requireRapidStopped: true, allowedControllerStates: ["guardstop", "motoroff"] },
        operations: [{ kind: "rapid_module_put", task: "T_ROB1", module: "MainModule", localPath: legacyPath }]
      }
    }), /UTF-8 RAPID source requires/);
    const allPaths = clients.flatMap((client) =>
      client.requests.map((item) => item.path)
    );
    assert.equal(
      allPaths.filter((item) => item === "/rw/rapid/tasks/T_ROB1/loadmod").length,
      1
    );
    assert.equal(
      allPaths.filter((item) => item === "/rw/rapid/tasks/T_ROB1/build").length,
      1
    );
  } finally {
    await stack.close();
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        protocol: "rws2",
        fullPlanApplyFreshVerify: true,
        moduleStageLoadBuildFreshVerify: true,
        explicitProbeAndRegistration: true,
        programConfigAndIoReads: true,
        largeModuleFileServiceHandoff: true,
        identityLock: true,
        safetyStateGate: true,
        mutationReplays: 0,
        liveControllerCalls: 0
      },
      null,
      2
    )
  );
} finally {
  await service.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
