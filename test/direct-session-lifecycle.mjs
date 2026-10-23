import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { DirectRwsService } from "../direct-rws/service.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";

const registryPath = fileURLToPath(
  new URL("../controller-registry.example.json", import.meta.url)
);

async function verifyInitialBindingCoalescing() {
  const service = new DirectRwsService({ registryPath });
  let openBindingCalls = 0;
  let closeCalls = 0;
  service.openBinding = async (alias) => {
    openBindingCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      alias,
      config: { baseUrl: "http://192.0.2.10" },
      client: {
        async close() {
          closeCalls += 1;
        }
      },
      identity: { Name: "EXAMPLE_CONTROLLER" },
      boundAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: Date.now()
    };
  };
  const bindings = await Promise.all(
    Array.from({ length: 5 }, () => service.binding("robot2"))
  );
  assert.equal(openBindingCalls, 1);
  assert.ok(bindings.every((binding) => binding === bindings[0]));
  assert.equal(service.bindings.get("robot2"), bindings[0]);
  await service.close();
  assert.equal(closeCalls, 1);
}

async function verifyReconnectOwnership() {
  const service = new DirectRwsService({ registryPath });
  let oldCloseCalls = 0;
  let replacementCloseCalls = 0;
  let oldRequestCalls = 0;
  let replacementRequestCalls = 0;
  let openBindingCalls = 0;
  const oldClient = {
    async request() {
      oldRequestCalls += 1;
      return { statusCode: 401, body: "unauthorized", bytes: Buffer.alloc(0) };
    },
    async close({ logout }) {
      assert.equal(logout, false);
      oldCloseCalls += 1;
    }
  };
  const replacementClient = {
    async request() {
      replacementRequestCalls += 1;
      return { statusCode: 200, body: "ok", bytes: Buffer.from("ok") };
    },
    async close() {
      replacementCloseCalls += 1;
    }
  };
  const originalBinding = {
    alias: "robot2",
    config: { baseUrl: "http://192.0.2.10" },
    client: oldClient,
    identity: { Name: "EXAMPLE_CONTROLLER" },
    boundAt: "2026-01-01T00:00:00.000Z",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: Date.now()
  };
  service.bindings.set("robot2", originalBinding);
  service.openBinding = async (alias, { bypassCircuit }) => {
    openBindingCalls += 1;
    assert.equal(alias, "robot2");
    assert.equal(bypassCircuit, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      alias,
      config: { baseUrl: "http://192.0.2.10" },
      client: replacementClient,
      identity: { Name: "EXAMPLE_CONTROLLER" },
      boundAt: "2026-01-01T00:00:01.000Z",
      verifiedAt: "2026-01-01T00:00:01.000Z",
      lastUsedAt: Date.now()
    };
  };

  try {
    const responses = await Promise.all(
      ["/rw/system?json=1", "/rw/panel/opmode?json=1"].map((requestPath) =>
        service.bindingRequest(
          originalBinding,
          { method: "GET", path: requestPath },
          "Concurrent identity-locked read"
        )
      )
    );
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.equal(service.bindings.get("robot2"), originalBinding);
    assert.equal(originalBinding.client, replacementClient);
    assert.equal(oldRequestCalls, 2);
    assert.equal(replacementRequestCalls, 2);
    assert.equal(oldCloseCalls, 1);
    assert.equal(openBindingCalls, 1);
    assert.equal(service.metricsFor("robot2").ReconnectCount, 1);
  } finally {
    await service.close();
  }
  assert.equal(replacementCloseCalls, 1);
}

function jsonResponse(payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body,
    bytes: Buffer.from(body, "utf8")
  };
}

function snapshotResponse(pathname) {
  if (pathname === "/rw/panel/opmode") {
    return jsonResponse({ _embedded: { _state: [{ opmode: "AUTO" }] } });
  }
  if (pathname === "/rw/panel/ctrlstate") {
    return jsonResponse({ _embedded: { _state: [{ ctrlstate: "motoroff" }] } });
  }
  if (pathname === "/rw/rapid/execution") {
    return jsonResponse({ _embedded: { _state: [{ ctrlexecstate: "stopped" }] } });
  }
  if (pathname === "/rw/rapid/modules") {
    return jsonResponse({
      _embedded: { _state: [{ name: "MainModule", type: "ProgMod" }] }
    });
  }
  if (pathname === "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/PROFINET") {
    return jsonResponse({
      _embedded: {
        _state: [
          {
            _title: "PROFINET",
            attrib: [{ _title: "Name", value: "PROFINET" }]
          }
        ]
      }
    });
  }
  throw new Error(`Unexpected snapshot request path: ${pathname}`);
}

async function verifyConcurrentSnapshotReconnect() {
  const service = new DirectRwsService({ registryPath, maxSockets: 4 });
  const alias = "robot2";
  const config = {
    baseUrl: "http://192.0.2.10",
    rwsProtocol: "rws1",
    expectedName: "EXAMPLE_CONTROLLER",
    expectedSystemId: "11111111-2222-3333-4444-555555555555",
    expectedRobotWare: "6.13.0164",
    defaultTask: "T_ROB1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  };
  service.registry = {
    allowedConfigDomains: ["eio", "sio", "sys", "proc"],
    controllers: { [alias]: config }
  };
  service.reloadRegistry = async () => false;
  let oldRequestCalls = 0;
  let replacementRequestCalls = 0;
  let oldCloseCalls = 0;
  let replacementCloseCalls = 0;
  let openBindingCalls = 0;
  const oldClient = {
    async request() {
      oldRequestCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ error: "expired" }, 401);
    },
    async close({ logout }) {
      assert.equal(logout, false);
      oldCloseCalls += 1;
    }
  };
  const replacementClient = {
    async request(options) {
      replacementRequestCalls += 1;
      const pathname = new URL(options.path, config.baseUrl).pathname;
      return snapshotResponse(pathname);
    },
    async close() {
      replacementCloseCalls += 1;
    }
  };
  const timestamp = new Date().toISOString();
  const binding = {
    alias,
    protocol: "rws1",
    adapter: new RwsAdapter({ protocol: "rws1" }),
    config,
    client: oldClient,
    identity: {
      Name: "EXAMPLE_CONTROLLER",
      SystemId: "11111111-2222-3333-4444-555555555555",
      RobotWare: "6.13.0164"
    },
    boundAt: timestamp,
    verifiedAt: timestamp,
    lastUsedAt: Date.now()
  };
  service.bindings.set(alias, binding);
  service.openBinding = async (requestedAlias, { bypassCircuit }) => {
    assert.equal(requestedAlias, alias);
    assert.equal(bypassCircuit, true);
    openBindingCalls += 1;
    return {
      ...binding,
      client: replacementClient,
      boundAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      lastUsedAt: Date.now()
    };
  };

  try {
    const snapshot = await service.call(
      "snapshot",
      { alias },
      5_000,
      1_000
    );
    assert.equal(snapshot.State.Opmode, "AUTO");
    assert.equal(snapshot.RapidModules[0].Name, "MainModule");
    assert.equal(snapshot.Session.ReconnectDelta, 1);
    assert.equal(snapshot.Session.RequestDelta, 10);
    assert.equal(oldRequestCalls, 5);
    assert.equal(replacementRequestCalls, 5);
    assert.equal(openBindingCalls, 1);
    assert.equal(oldCloseCalls, 1);
    assert.equal(service.metricsFor(alias).ReconnectCount, 1);
  } finally {
    await service.close();
  }
  assert.equal(replacementCloseCalls, 1);
}

async function verifyIdleCleanupSerialization() {
  const service = new DirectRwsService({ registryPath });
  await service.reloadRegistry();
  let closeCalls = 0;
  const binding = {
    alias: "robot2",
    config: service.config("robot2"),
    client: {
      async close() {
        closeCalls += 1;
      }
    },
    lastUsedAt: Date.now() - 60_000
  };
  service.bindings.set("robot2", binding);

  let releaseActive;
  let activeStartedResolve;
  const activeStarted = new Promise((resolve) => {
    activeStartedResolve = resolve;
  });
  const activeBlocker = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const active = service.runInAliasQueue("robot2", 500, async () => {
    activeStartedResolve();
    await activeBlocker;
  });
  await activeStarted;

  try {
    const busyResult = await service.call(
      "disconnect_idle",
      { idleSeconds: 30 },
      1_000,
      100
    );
    assert.deepEqual(busyResult.BusyAliases, ["robot2"]);
    assert.equal(busyResult.Disconnected, false);
    assert.equal(closeCalls, 0);
    assert.equal(service.bindings.get("robot2"), binding);
  } finally {
    releaseActive();
    await active;
  }

  binding.lastUsedAt = Date.now() - 60_000;
  let finishRead;
  let readStartedResolve;
  const readStarted = new Promise((resolve) => {
    readStartedResolve = resolve;
  });
  const readFinishing = new Promise((resolve) => {
    finishRead = resolve;
  });
  const refreshingRead = service.runInAliasQueue("robot2", 500, async () => {
    readStartedResolve();
    await readFinishing;
    binding.lastUsedAt = Date.now();
  });
  await readStarted;
  const waitingCleanup = service.call(
    "disconnect_idle",
    { idleSeconds: 30 },
    1_000,
    500
  );
  finishRead();
  await refreshingRead;
  const refreshedResult = await waitingCleanup;
  assert.equal(refreshedResult.Disconnected, false);
  assert.deepEqual(refreshedResult.BusyAliases, []);
  assert.equal(closeCalls, 0);
  assert.equal(service.bindings.get("robot2"), binding);

  binding.lastUsedAt = Date.now() - 60_000;
  const idleResult = await service.call(
    "disconnect_idle",
    { idleSeconds: 30 },
    1_000,
    500
  );
  assert.equal(idleResult.Disconnected, true);
  assert.deepEqual(idleResult.Aliases, ["robot2"]);
  assert.equal(closeCalls, 1);
  assert.equal(service.bindings.has("robot2"), false);
  await service.close();
}

await verifyInitialBindingCoalescing();
await verifyReconnectOwnership();
await verifyConcurrentSnapshotReconnect();
await verifyIdleCleanupSerialization();
console.log("direct session lifecycle tests passed");
