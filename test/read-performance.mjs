import assert from "node:assert/strict";
import http from "node:http";
import { DirectRwsService } from "../direct-rws/service.mjs";
import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { RequestSemaphore } from "../direct-rws/request-semaphore.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const service = new DirectRwsService({ registryPath: "unused.json", maxSockets: 4 });
service.registry = { allowedConfigDomains: ["eio"], controllers: {} };
service.reloadRegistry = async () => false;
let active = 0;
let peak = 0;
let calls = 0;
let fail = false;
const client = {
  maxSockets: 4,
  requestTimeoutMs: 1_000,
  close: async () => {},
  async request(options) {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    const name = options.path.split("?")[0].split("/").at(-1);
    await sleep(fail && name === "Bad" ? 5 : 40);
    active -= 1;
    return {
      statusCode: fail && name === "Bad" ? 500 : 200,
      body: JSON.stringify({ _embedded: { _state: [{
        _title: `PROFINET/PN_Internal_Device/${name}`, name, lvalue: "0"
      }] } })
    };
  }
};
const binding = {
  alias: "mock", protocol: "rws2", adapter: new RwsAdapter({ protocol: "rws2" }),
  config: { baseUrl: "https://controller.invalid", rwsProtocol: "rws2",
    ioNetwork: "PROFINET", ioDevice: "PN_Internal_Device", defaultTask: "T_ROB1" },
  client
};
service.bindings.set("mock", binding);
const batches = [];
try {
  for (const count of [8, 9, 32]) {
    calls = 0;
    peak = 0;
    const result = await service.call("read_signals", {
      alias: "mock", names: Array.from({ length: count }, (_, i) => `S${i}`)
    });
    assert.equal(result.Signals.length, count);
    assert.equal(calls, count);
    assert.equal(peak, 4);
    batches.push({ count, peak, elapsedMs: result.ElapsedMs });
  }

  service.rapidModuleText = async (_binding, _task, module) => {
    await service.bindingRequest(binding, { path: `/mock/${module}` }, "test module");
    return "MODULE Test ENDMODULE";
  };
  calls = 0;
  const concurrent = await Promise.all(["A", "B"].map((module) =>
    service.call("read_module", { alias: "mock", module })));
  assert.equal(calls, 2);
  assert.deepEqual(concurrent.map((result) => result.RequestDelta), [1, 1]);

  fail = true;
  calls = 0;
  await assert.rejects(service.call("read_signals", {
    alias: "mock", names: ["Bad", "A", "B", "C", "D", "E", "F", "G"]
  }), /HTTP 500/);
  assert.equal(active, 0);
  assert.equal(calls, 4, "failure must stop dispatching the rest of the batch");
  await service.runSerialized("mock", async () => assert.equal(active, 0));

  fail = false;
  let release;
  let entered;
  const entry = new Promise((resolve) => { entered = resolve; });
  const held = service.runSerialized("mock", async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await entry;
  try {
    await assert.rejects(service.call("read_module", {
      alias: "mock", module: "A"
    }, 50, 1_000), { code: "ReadDeadlineExceeded" });
    assert.equal(service.aliasLock("mock").queue.length, 0);
  } finally {
    release();
    await held;
  }
  const entry2 = new Promise((resolve) => { entered = resolve; });
  const held2 = service.runSerialized("mock", async () => {
    entered();
    await sleep(90);
  });
  await entry2;
  const queued = await service.call("read_module", { alias: "mock", module: "A" });
  await held2;
  assert.ok(queued.QueueWaitMs >= 60);
  assert.ok(queued.ElapsedMs >= queued.QueueWaitMs + 25);

  const entry3 = new Promise((resolve) => { entered = resolve; });
  const heldRead = service.runWithAliasLock("mock", "read", 1_000, async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  }, 4);
  await entry3;
  try {
    await assert.rejects(service.call("read_module", {
      alias: "mock", module: "A"
    }, 40), { code: "ReadDeadlineExceeded" });
    assert.equal(service.aliasLock("mock").queue.length, 0);
  } finally {
    release();
    await heldRead;
  }
} finally {
  await service.close();
}

const semaphore = new RequestSemaphore(1);
const release = await semaphore.acquire();
await assert.rejects(semaphore.acquire(Date.now() + 30), { code: "ReadDeadlineExceeded" });
assert.equal(semaphore.queue.length, 0);
release();
assert.equal(semaphore.idle, true);

let pageRequests = 0;
let authRequests = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/auth") {
    authRequests += 1;
    setTimeout(() => {
      response.writeHead(401, { "www-authenticate": `Digest realm="mock", nonce="nonce${authRequests}", qop="auth"` });
      response.end("{}");
    }, 60);
    return;
  }
  const page = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("start") || 0);
  pageRequests += 1;
  setTimeout(() => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      _links: page < 19 ? { next: { href: `/rw/cfg/eio/EIO_SIGNAL/instances?start=${page + 1}&json=1` } } : {},
      _embedded: { _state: [{ _title: `S${page}`, instanceid: String(page), attrib: [{ _title: "Name", value: `S${page}` }] }] }
    }));
  }, 50);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const httpClient = new DigestHttpClient({ baseUrl,
  credentialProvider: async () => ({ username: "mock", password: "mock" }), requestTimeoutMs: 1_000 });
const paginated = new DirectRwsService({ registryPath: "unused.json" });
paginated.registry = { allowedConfigDomains: ["eio"], controllers: {} };
paginated.reloadRegistry = async () => false;
paginated.bindings.set("mock", { alias: "mock", protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }), config: { baseUrl }, client: httpClient });
let deadlineElapsedMs;
try {
  const start = performance.now();
  await assert.rejects(paginated.call("list_config_instances", {
    alias: "mock", domain: "eio", type: "EIO_SIGNAL"
  }, 130), { code: "ReadDeadlineExceeded" });
  deadlineElapsedMs = Math.round(performance.now() - start);
  assert.ok(deadlineElapsedMs < 600);
  assert.ok(pageRequests < 20);
  assert.equal(paginated.transportFailures.size, 0, "overall read budget is not controller unavailability");
  await assert.rejects(httpClient.request({ path: "/auth", timeoutMs: 1_000,
    deadlineAt: Date.now() + 140 }), (error) =>
    error.code === "ETIMEDOUT" || error.code === "ReadDeadlineExceeded");
  assert.ok(authRequests >= 2 && authRequests <= 3);
} finally {
  await httpClient.close({ logout: false });
  paginated.bindings.clear();
  await paginated.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ ok: true, batches, failedReadsDrained: true,
  perCallMetrics: true, queueDeadline: true, pageRequests, deadlineElapsedMs, liveControllerCalls: 0 }));
