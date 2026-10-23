import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import {
  directMethodRequestWeight
} from "../direct-rws/method-routing.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const alias = "snapshot_robot";
const systemId = "11111111-2222-3333-4444-555555555555";
const root = await mkdtemp(path.join(os.tmpdir(), "abb-direct-snapshot-"));
const registryPath = path.join(root, "controller-registry.json");
let activeRequests = 0;
let peakRequests = 0;
let identityComplete = false;
let nonIdentityBeforeIdentity = false;
let failureMode = false;
let snapshotCompletions = 0;

function payload(pathname) {
  if (pathname === "/rw/system") {
    return {
      _embedded: {
        _state: [
          { name: "SNAPSHOT_TEST", sysid: systemId, rwversion: "6.13.0164" }
        ]
      }
    };
  }
  if (pathname === "/rw/panel/opmode") {
    return { _embedded: { _state: [{ opmode: "AUTO" }] } };
  }
  if (pathname === "/rw/panel/ctrlstate") {
    return { _embedded: { _state: [{ ctrlstate: "motoroff" }] } };
  }
  if (pathname === "/rw/rapid/execution") {
    return { _embedded: { _state: [{ ctrlexecstate: "stopped" }] } };
  }
  if (pathname === "/rw/rapid/modules") {
    return {
      _embedded: { _state: [{ name: "MainModule", type: "ProgMod" }] }
    };
  }
  if (pathname === "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/PROFINET") {
    return {
      _embedded: {
        _state: [
          {
            _title: "PROFINET",
            attrib: [{ _title: "Name", value: "PROFINET" }]
          }
        ]
      }
    };
  }
  throw new Error(`Unexpected snapshot path: ${pathname}`);
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/logout") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (pathname !== "/rw/system" && !identityComplete) {
    nonIdentityBeforeIdentity = true;
  }
  activeRequests += 1;
  peakRequests = Math.max(peakRequests, activeRequests);
  const delayMs = pathname === "/rw/system" ? 40 : 70;
  const finish = (statusCode, body) => {
    activeRequests -= 1;
    if (pathname !== "/rw/system") snapshotCompletions += 1;
    if (pathname === "/rw/system") identityComplete = true;
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(body);
  };
  if (failureMode && pathname === "/rw/panel/opmode") {
    setTimeout(() => finish(500, '{"error":"fixture failure"}'), 5);
    return;
  }
  setTimeout(() => finish(200, JSON.stringify(payload(pathname))), delayMs);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const config = {
  baseUrl,
  rwsProtocol: "rws1",
  expectedName: "SNAPSHOT_TEST",
  expectedSystemId: systemId,
  expectedRobotWare: "6.13.0164",
  defaultTask: "T_ROB1",
  ioNetwork: "PROFINET",
  ioDevice: "PN_Internal_Device"
};
const registry = {
  version: 1,
  allowedConfigDomains: ["eio", "sio", "sys", "proc"],
  controllers: { [alias]: config }
};
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const client = new DigestHttpClient({
  baseUrl,
  maxSockets: 4,
  requestTimeoutMs: 1_000,
  credentialProvider: async () => ({ username: "unused", password: "unused" })
});
const service = new DirectRwsService({ registryPath, maxSockets: 4 });
service.registry = registry;
service.reloadRegistry = async () => false;
const binding = {
  alias,
  protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }),
  config,
  client,
  identity: {
    Name: config.expectedName,
    SystemId: systemId,
    RobotWare: config.expectedRobotWare
  },
  boundAt: new Date().toISOString(),
  verifiedAt: "2000-01-01T00:00:00.000Z",
  lastUsedAt: Date.now()
};
service.bindings.set(alias, binding);

try {
  assert.equal(directMethodRequestWeight("snapshot", {}, 1), 1);
  assert.equal(directMethodRequestWeight("snapshot", {}, 4), 4);
  assert.equal(directMethodRequestWeight("snapshot", {}, 16), 5);

  peakRequests = 0;
  identityComplete = false;
  nonIdentityBeforeIdentity = false;
  snapshotCompletions = 0;
  const cold = await service.call("snapshot", { alias }, 5_000, 1_000);
  assert.equal(cold.IdentityCacheHit, false);
  assert.equal(cold.Session.RequestDelta, 6);
  assert.equal(cold.State.Opmode, "AUTO");
  assert.equal(cold.RapidModules[0].Name, "MainModule");
  assert.equal(cold.IndustrialNetwork.Name, "PROFINET");
  assert.equal(nonIdentityBeforeIdentity, false, "snapshot reads started before identity verification");
  assert.equal(snapshotCompletions, 5);
  assert.equal(peakRequests, 4);

  peakRequests = 0;
  snapshotCompletions = 0;
  const hot = await service.call("snapshot", { alias }, 5_000, 1_000);
  assert.equal(hot.IdentityCacheHit, true);
  assert.equal(hot.Session.RequestDelta, 5);
  assert.equal(snapshotCompletions, 5);
  assert.equal(peakRequests, 4);

  peakRequests = 0;
  snapshotCompletions = 0;
  failureMode = true;
  await assert.rejects(
    service.call("snapshot", { alias }, 5_000, 1_000),
    /Read operation mode failed HTTP 500/
  );
  assert.equal(activeRequests, 0, "snapshot released its alias lock with reads still active");
  assert.equal(snapshotCompletions, 5, "snapshot did not settle every started read after failure");
  failureMode = false;

  peakRequests = 0;
  await service.controllerState(binding);
  assert.equal(peakRequests, 1, "default controllerState must remain serial for backup preflight");

  console.log(
    JSON.stringify(
      {
        ok: true,
        identityFirst: true,
        coldRequestDelta: cold.Session.RequestDelta,
        hotRequestDelta: hot.Session.RequestDelta,
        snapshotPeakRequests: 4,
        failureSettledAllReads: true,
        backupPreflightStatePeak: peakRequests
      },
      null,
      2
    )
  );
} finally {
  failureMode = false;
  await service.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(root, { recursive: true, force: true });
}
