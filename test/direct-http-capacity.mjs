import assert from "node:assert/strict";
import http from "node:http";

import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const maxSockets = 4;
const responseDelayMs = 300;
const requestTimeoutMs = 1_000;
const alias = "capacity_robot";
const registryPath = new URL(
  "../controller-registry.example.json",
  import.meta.url
).pathname;

let activeRequests = 0;
let peakRequests = 0;
let finishedRequests = 0;

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/logout") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }

  activeRequests += 1;
  peakRequests = Math.max(peakRequests, activeRequests);
  const name = decodeURIComponent(pathname.split("/").at(-1));
  response.once("finish", () => {
    finishedRequests += 1;
  });
  setTimeout(() => {
    activeRequests -= 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        _embedded: {
          _state: [
            {
              _title: `PROFINET/PN_Internal_Device/${name}`,
              name,
              lvalue: "0",
              lstate: "not simulated",
              phstate: "0",
              quality: "1",
              simstate: "not simulated"
            }
          ]
        }
      })
    );
  }, responseDelayMs);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const client = new DigestHttpClient({
  baseUrl,
  credentialProvider: async () => ({ username: "unused", password: "unused" }),
  requestTimeoutMs,
  maxSockets
});
const service = new DirectRwsService({ registryPath, maxSockets });
service.registry = { controllers: {} };
service.reloadRegistry = async () => false;
service.bindings.set(alias, {
  alias,
  protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }),
  config: {
    baseUrl,
    rwsProtocol: "rws1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device",
    defaultTask: "T_ROB1"
  },
  client,
  identity: { Name: "CAPACITY_TEST" },
  boundAt: new Date().toISOString(),
  verifiedAt: new Date().toISOString(),
  lastUsedAt: Date.now()
});

const probes = [];
try {
  for (const readers of [1, 2, maxSockets]) {
    peakRequests = 0;
    finishedRequests = 0;
    const metrics = service.metricsFor(alias);
    const timeoutBefore = metrics.TimeoutCount;
    const transportBefore = metrics.TransportFailureCount;
    service.transportFailures.delete(alias);
    const started = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: readers }, (_, reader) =>
        service.call(
          "read_signals",
          {
            alias,
            names: Array.from(
              { length: maxSockets },
              (_, signal) => `Reader_${reader + 1}_Signal_${signal + 1}`
            )
          },
          5_000,
          5_000
        )
      )
    );
    const timeoutCount = metrics.TimeoutCount - timeoutBefore;
    const transportFailures = metrics.TransportFailureCount - transportBefore;
    const probe = {
      readers,
      attemptedRequests: readers * maxSockets,
      successfulReads: settled.filter((item) => item.status === "fulfilled").length,
      finishedRequests,
      timeoutCount,
      transportFailures,
      circuitOpen: service.transportFailures.has(alias),
      peakRequests,
      elapsedMs: Math.round(performance.now() - started)
    };
    probes.push(probe);
  }

  console.log(JSON.stringify({ maxSockets, responseDelayMs, requestTimeoutMs, probes }, null, 2));

  for (const probe of probes) {
    assert.equal(probe.timeoutCount, 0, `${probe.readers} readers produced ETIMEDOUT`);
    assert.equal(
      probe.transportFailures,
      0,
      `${probe.readers} readers registered transport failures`
    );
    assert.equal(probe.circuitOpen, false, `${probe.readers} readers opened the circuit`);
    assert.equal(probe.successfulReads, probe.readers);
    assert.ok(
      probe.peakRequests <= maxSockets,
      `in-flight HTTP peak ${probe.peakRequests} exceeded maxSockets ${maxSockets}`
    );
  }
} finally {
  await service.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
