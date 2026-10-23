import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectRwsService, parseRapidRobtarget } from "../direct-rws/service.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { DpapiCredentialProvider } from "../direct-rws/credential-provider.mjs";
import { Rws2HttpClient } from "../direct-rws/rws2-http-client.mjs";
import { DirectChangesetPlanner } from "../direct-rws/changeset-planner.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const service = new DirectRwsService({ registryPath: "unused.json" });
const binding = { protocol: "rws2", adapter: new RwsAdapter({ protocol: "rws2" }),
  config: { ioNetwork: "PN", ioDevice: "Device" }, client: { maxSockets: 4 } };
let requests = 0;
let bodyReads = 0;
service.bindingRequest = async (_binding, options) => {
  requests += 1;
  const name = options.path.split("?")[0].split("/").at(-1);
  return { get body() {
    bodyReads += 1;
    return JSON.stringify({ _embedded: { _state: [{ _title: `PN/Device/${name}`, name, lvalue: "1" }] } });
  } };
};
const names = Array.from({ length: 32 }, (_, i) => `S${i % 2}`);
for (const protocol of ["rws1", "rws2"]) {
  binding.protocol = protocol;
  binding.adapter = new RwsAdapter({ protocol });
  requests = 0;
  bodyReads = 0;
  const signals = await service.signals(binding, names);
  assert.deepEqual(signals.map((signal) => signal.Name), names);
  assert.equal(requests, 2);
  assert.equal(bodyReads, 2);
}
const components = { x: "1.25", y: "-2", z: "3E2", q1: "1", q2: "0", q3: "0", q4: "0",
  cf1: "0", cf4: "-1", cf6: "2", cfx: "0", ej1: "9E9", ej2: "9E9", ej3: "9E9", ej4: "9E9", ej5: "9E9", ej6: "9E9" };
const html = `<li class="rapid-robtarget">${Object.entries(components).map(([key, value]) =>
  `<span class="${key}">${value}</span>`).join("")}</li>`;
let jsonTarget = { ...components };
service.bindingRequest = async () => ({ body: JSON.stringify({ _state: [jsonTarget] }) });
const target = await service.currentRobtarget(binding, "T_ROB1", "tool0", "wobj0");
assert.deepEqual(target, parseRapidRobtarget(html));
jsonTarget = { ...components, x: "<span>1</span>" };
await assert.rejects(service.currentRobtarget(binding, "T_ROB1", "tool0", "wobj0"), /component.*x/);
await service.close();

const root = await mkdtemp(path.join(os.tmpdir(), "abb-credential-cache-"));
let loads = 0;
let fail = false;
const provider = new DpapiCredentialProvider({ loadCredential: async () => {
  loads += 1;
  await sleep(20);
  if (fail) throw new Error("mock credential error");
  return { username: "mock", password: "test-only" };
} });
try {
  const a = { credentialFile: path.join(root, "a.fixture") };
  const b = { credentialFile: path.join(root, "b.fixture") };
  await writeFile(a.credentialFile, "test fixture");
  await writeFile(b.credentialFile, "test fixture");
  await Promise.all(Array.from({ length: 8 }, () => provider.get(a)));
  assert.equal(loads, 1);
  await provider.get(b);
  await provider.get(a);
  assert.equal(loads, 2, "switching files must not evict the other credential");
  await writeFile(a.credentialFile, "updated test fixture");
  await provider.get(a);
  assert.equal(loads, 3);
  provider.clear();
  fail = true;
  await assert.rejects(provider.get(a), /mock credential error/);
  fail = false;
  await provider.get(a);
  assert.equal(loads, 5, "failed loads must be retryable");
} finally {
  provider.clear();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("abb-credential-cache-"));
  await rm(root, { recursive: true, force: true });
}

let rws2CredentialLoads = 0;
const client = new Rws2HttpClient({ baseUrl: "https://controller.invalid",
  credentialProvider: async () => {
    rws2CredentialLoads += 1;
    await sleep(20);
    return { username: "mock", password: "test-only" };
  } });
try {
  await Promise.all(Array.from({ length: 8 }, () => client.loadCredentials()));
  assert.equal(rws2CredentialLoads, 1);
} finally {
  await client.close({ logout: false });
}

let inventories = 0;
const planner = new DirectChangesetPlanner({ allowedConfigDomains: ["eio"], readApi: {
  getIdentity: async () => ({ Endpoint: "http://controller.invalid", Name: "MOCK",
    SystemId: "11111111-2222-3333-4444-555555555555", RobotWare: "6.13.0164" }),
  getControllerState: async () => ({ ControllerState: "motoroff", RapidState: "stopped" }),
  getConfigInstances: async () => {
    inventories += 1;
    return Array.from({ length: 6_000 }, (_, i) => ({ Key: `S${i}`, InstanceId: String(i), Attributes: { Name: `S${i}` } }));
  }
} });
const plan = await planner.prepare({ version: 1, controller: "mock",
  safety: { requireRapidStopped: true, allowedControllerStates: ["motoroff"] },
  expectedController: { name: "MOCK", systemId: "11111111-2222-3333-4444-555555555555", robotWare: "6.13.0164" },
  operations: Array.from({ length: 250 }, (_, i) => ({ kind: "cfg_upsert", domain: "eio", type: "EIO_SIGNAL",
    instance: i % 2 ? String(5750 + i) : `s${5750 + i}`, fields: { Name: `S${5750 + i}` } })) });
assert.equal(inventories, 1);
assert.equal(plan.ChangesRequired, 0);
assert.equal(plan.OperationCount, 250);
planner.readApi.getConfigInstances = async () => [
  { Key: "First", InstanceId: "Alias", Attributes: { Name: "First" } },
  { Key: "Alias", InstanceId: "Second", Attributes: { Name: "Second" } }
];
const collision = await planner.prepare({ version: 1, controller: "mock",
  safety: { requireRapidStopped: true, allowedControllerStates: ["motoroff"] },
  expectedController: { name: "MOCK", systemId: "11111111-2222-3333-4444-555555555555", robotWare: "6.13.0164" },
  operations: [{ kind: "cfg_upsert", domain: "eio", type: "EIO_SIGNAL", instance: "alias", fields: { Name: "First" } }] });
assert.equal(collision.ChangesRequired, 0, "Key and InstanceId collisions must preserve the first matching row");
planner.close();
console.log(JSON.stringify({ ok: true, signalNames: 32, signalRequests: requests,
  signalBodyReads: bodyReads, robtargetParity: true, credentialSingleFlight: true,
  rws2CredentialLoads, indexedInventory: 6000, plannedOperations: 250, inventories,
  liveControllerCalls: 0 }));
