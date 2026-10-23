import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { DirectRwsService } from "../direct-rws/service.mjs";

const registryPath = fileURLToPath(
  new URL("../controller-registry.example.json", import.meta.url)
);
const alias = "task_default_robot";
const service = new DirectRwsService({ registryPath });
const binding = {
  alias,
  config: {
    baseUrl: "http://192.0.2.10",
    defaultTask: "T_DEFAULT",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  },
  identity: { Name: "TASK_DEFAULT_TEST" },
  boundAt: "2026-01-01T00:00:00.000Z",
  verifiedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: Date.now()
};
const observed = [];

service.reloadRegistry = async () => false;
service.binding = async (requestedAlias) => {
  assert.equal(requestedAlias, alias);
  return binding;
};
service.identityForRead = async () => ({
  identity: binding.identity,
  cacheHit: true,
  ageMs: 0
});
service.controllerState = async () => ({
  Opmode: "AUTO",
  ControllerState: "motoroff",
  RapidState: "stopped"
});
service.configInstance = async () => ({ Attributes: { Name: "PROFINET" } });
service.rapidModules = async (_binding, task) => {
  observed.push(["modules", task]);
  return [{ Name: "MainModule", Type: "ProgMod", Task: task }];
};
service.rapidModuleText = async (_binding, task, module) => {
  observed.push(["module", task, module]);
  return `MODULE ${module}\nENDMODULE`;
};
service.rapidDataValue = async (_binding, task, module, name) => {
  observed.push(["data", task, module, name]);
  return "1";
};
service.currentRobtarget = async (_binding, task, tool, wobj) => {
  observed.push(["robtarget", task, tool, wobj]);
  return { Value: "stub" };
};

try {
  const snapshot = await service.call("snapshot", { alias });
  const modules = await service.call("list_modules", { alias });
  const moduleText = await service.call("read_module", {
    alias,
    module: "MainModule"
  });
  const rapidData = await service.call("read_rapid_data", {
    alias,
    module: "MainModule",
    name: "Revision"
  });
  const robtarget = await service.call("read_current_robtarget", {
    alias,
    tool: "tool0",
    wobj: "wobj0"
  });
  const explicit = await service.call("list_modules", {
    alias,
    task: "T_EXPLICIT"
  });

  for (const result of [modules, moduleText, rapidData, robtarget]) {
    assert.equal(result.Task, "T_DEFAULT");
  }
  assert.equal(snapshot.RapidModules[0].Task, "T_DEFAULT");
  assert.equal(explicit.Task, "T_EXPLICIT");
  assert.deepEqual(
    observed.map((entry) => entry[1]),
    ["T_DEFAULT", "T_DEFAULT", "T_DEFAULT", "T_DEFAULT", "T_DEFAULT", "T_EXPLICIT"]
  );

  const callsBeforeInvalidDefaults = observed.length;
  for (const invalid of [undefined, null, "", "bad task", 42]) {
    binding.config.defaultTask = invalid;
    await assert.rejects(
      service.call("list_modules", { alias }),
      /Unsafe RAPID task/
    );
  }
  assert.equal(
    observed.length,
    callsBeforeInvalidDefaults,
    "invalid registry defaultTask reached a RAPID read"
  );
  binding.config.defaultTask = "";
  const override = await service.call("list_modules", {
    alias,
    task: "T_OVERRIDE"
  });
  assert.equal(override.Task, "T_OVERRIDE");

  let probeCalls = 0;
  service.probeController = async () => {
    probeCalls += 1;
    throw new Error("invalid registration reached controller probe");
  };
  const validRegistration = {
    alias,
    baseUrl: "http://192.0.2.10",
    expectedName: "TASK_DEFAULT_TEST",
    expectedSystemId: "11111111-2222-3333-4444-555555555555",
    expectedRobotWare: "6.13.0164",
    credentialAlias: "robot2",
    defaultTask: "T_DEFAULT",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  };
  for (const [overrideFields, pattern] of [
    [{ alias: undefined }, /Unsafe controller alias/],
    [{ credentialAlias: undefined }, /Unsafe credential alias/],
    [{ defaultTask: "" }, /Unsafe default RAPID task/],
    [{ defaultTask: 42 }, /Unsafe default RAPID task/],
    [{ ioNetwork: " " }, /ioNetwork must not be empty/],
    [{ ioNetwork: 42 }, /ioNetwork must not be empty/],
    [{ ioDevice: " " }, /ioDevice must not be empty/],
    [{ ioDevice: {} }, /ioDevice must not be empty/]
  ]) {
    await assert.rejects(
      service.registerController({ ...validRegistration, ...overrideFields }),
      pattern
    );
  }
  assert.equal(probeCalls, 0, "invalid registration contacted a controller");

  const discovery = new DirectRwsService({ registryPath });
  discovery.config = () => ({ baseUrl: "http://192.0.2.10" });
  let paths = [];
  let closed = 0;
  let mismatch = false;
  let failResource = false;
  let activeDiscoveryReads = 0;
  let peakDiscoveryReads = 0;
  discovery.newClient = async () => ({
    requestOk: async (request) => {
      assert.equal(request.method, "GET");
      paths.push(request.path);
      if (failResource && request.path.includes("/tasks")) throw new Error("resource denied");
      activeDiscoveryReads += 1;
      peakDiscoveryReads = Math.max(peakDiscoveryReads, activeDiscoveryReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeDiscoveryReads -= 1;
      const rows = request.path.includes("/rw/system")
        ? [{ name: mismatch && paths.length > 1 ? "OTHER" : "DISCOVERY",
            sysid: "11111111-2222-3333-4444-555555555555", rwversion: "6.13.0164" }]
        : [{ name: "live-resource", _title: "Network/Device" }];
      const key = request.accept && !request.path.includes("/rw/system")
        ? "resources" : "_state";
      if (request.accept && request.path.includes("/rw/system")) {
        return { body: JSON.stringify({ state: rows,
          _embedded: { resources: [{ _type: "sys-options-li", _title: "options" }] } }) };
      }
      return { body: JSON.stringify({ _embedded: { [key]: rows } }) };
    },
    close: async () => {
      assert.equal(activeDiscoveryReads, 0, "probe closed while resource reads were still active");
      closed += 1;
    }
  });
  try {
    for (const rwsProtocol of ["rws1", "rws2"]) {
      paths = [];
      const probe = { baseUrl: "http://192.0.2.10", credentialAlias: "robot2", rwsProtocol,
        ...(rwsProtocol === "rws2" ? { certificateSha256: "A".repeat(64) } : {}) };
      await discovery.probeController(probe);
      assert.equal(paths.length, 1, "default probe remains identity-only");
      paths = [];
      peakDiscoveryReads = 0;
      const found = await discovery.probeController({ ...probe, includeResources: true });
      assert.equal(found.RapidTasks[0].name, "live-resource");
      assert.equal(found.IoNetworks.length, 1);
      assert.equal(found.IoDevices[0]._title, "Network/Device");
      assert.equal(paths.length, 5);
      assert.equal(peakDiscoveryReads, 3);
      assert.ok(paths.at(-1).startsWith("/rw/system"), "identity is rechecked after resource reads");
      assert.equal(found.ControllerModified, false);
      assert.equal(paths[1].includes("json=1"), rwsProtocol === "rws1");
    }
    paths = [];
    peakDiscoveryReads = 0;
    discovery.maxSockets = 1;
    await discovery.probeController({ baseUrl: "http://192.0.2.10",
      credentialAlias: "robot2", rwsProtocol: "rws1", includeResources: true });
    assert.equal(peakDiscoveryReads, 1, "discovery must honor a single-socket limit");
    discovery.maxSockets = 4;
    paths = [];
    mismatch = true;
    await assert.rejects(discovery.probeController({ baseUrl: "http://192.0.2.10",
      credentialAlias: "robot2", rwsProtocol: "rws1", includeResources: true }), /IDENTITY MISMATCH/);
    mismatch = false;
    failResource = true;
    await assert.rejects(discovery.probeController({ baseUrl: "http://192.0.2.10",
      credentialAlias: "robot2", rwsProtocol: "rws1", includeResources: true }), /resource denied/);
    assert.equal(closed, 7, "every probe closes its independent session");
  } finally {
    await discovery.close();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        registryDefaultTask: "T_DEFAULT",
        explicitTaskOverride: true,
        invalidDefaultsRejectedBeforeRapidRead: true,
        invalidRegistrationRejectedBeforeProbe: true
      },
      null,
      2
    )
  );
} finally {
  await service.close();
}
