import assert from "node:assert/strict";

import { DirectRwsService } from "../direct-rws/service.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";

const registryPath = new URL(
  "../controller-registry.example.json",
  import.meta.url
).pathname;

function configItem(index) {
  const name = `Signal_${String(index + 1).padStart(5, "0")}`;
  return {
    _title: name,
    instanceid: String(index + 1),
    rdonly: "false",
    attrib: [
      { _title: "Name", value: name },
      { _title: "Device", value: "PN_Internal_Device" }
    ]
  };
}

function pageResponse(items, hasNext, next = "next") {
  return {
    statusCode: 200,
    body: JSON.stringify({
      _links: hasNext ? { next: { href: next } } : {},
      _embedded: { _state: items }
    }),
    bytes: Buffer.alloc(0)
  };
}

function query(pathname) {
  return new URL(pathname, "http://controller.invalid").searchParams;
}

const defaultService = new DirectRwsService({ registryPath });
defaultService.registry = { allowedConfigDomains: ["eio"] };
const binding = {
  alias: "robot2",
  protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }),
  config: {
    baseUrl: "http://192.0.2.10",
    rwsProtocol: "rws1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  },
  client: { maxSockets: 2 }
};
const totalInstances = 6_000;
let configRequests = 0;
defaultService.bindingRequest = async (_binding, options) => {
  configRequests += 1;
  const parameters = query(options.path);
  const start = Number(parameters.get("start"));
  const limit = Number(parameters.get("limit"));
  const end = Math.min(totalInstances, start + limit);
  const items = Array.from({ length: end - start }, (_, offset) =>
    configItem(start + offset)
  );
  return pageResponse(
    items,
    end < totalInstances,
    `/rw/cfg/eio/EIO_SIGNAL/instances?start=${end}&limit=${limit}&json=1`
  );
};
const instances = await defaultService.configInstances(
  binding,
  "eio",
  "EIO_SIGNAL"
);
assert.equal(defaultService.pagination.configMaxItems, 20_000);
assert.equal(instances.length, totalInstances);
assert.equal(instances[0].Attributes.Name, "Signal_00001");
assert.equal(instances.at(-1).Attributes.Name, "Signal_06000");
assert.equal(configRequests, Math.ceil(totalInstances / 70));
await defaultService.close();

// Regression: RobotWare 6 returns the next link relative to the HAL base and
// drops the type segment ("eio/instances?start=5&limit=5&json=1"). Requesting
// that href verbatim 404s on the controller, so every page request must be
// rebuilt on the canonical list path with the cursor from the next link.
const relativeNextService = new DirectRwsService({
  registryPath,
  pagination: { configPageSize: 5, configMaxItems: 100 }
});
relativeNextService.registry = { allowedConfigDomains: ["eio"] };
const relativeNextTotal = 12;
const relativeNextPaths = [];
relativeNextService.bindingRequest = async (_binding, options) => {
  relativeNextPaths.push(options.path);
  if (!options.path.startsWith("/rw/cfg/eio/EIO_SIGNAL/instances?")) {
    const error = new Error(`HTTP 404: ${options.path}`);
    error.statusCode = 404;
    throw error;
  }
  const parameters = query(options.path);
  assert.equal(parameters.get("json"), "1");
  const start = Number(parameters.get("start"));
  const limit = Number(parameters.get("limit"));
  const end = Math.min(relativeNextTotal, start + limit);
  return pageResponse(
    Array.from({ length: end - start }, (_, offset) => configItem(start + offset)),
    end < relativeNextTotal,
    `eio/instances?start=${end}&limit=${limit}&json=1`
  );
};
const relativeNextInstances = await relativeNextService.configInstances(
  binding,
  "eio",
  "EIO_SIGNAL"
);
assert.equal(relativeNextInstances.length, relativeNextTotal);
assert.equal(relativeNextInstances[0].Attributes.Name, "Signal_00001");
assert.equal(relativeNextInstances.at(-1).Attributes.Name, "Signal_00012");
assert.deepEqual(relativeNextPaths, [
  "/rw/cfg/eio/EIO_SIGNAL/instances?start=0&limit=5&json=1",
  "/rw/cfg/eio/EIO_SIGNAL/instances?start=5&limit=5&json=1",
  "/rw/cfg/eio/EIO_SIGNAL/instances?start=10&limit=5&json=1"
]);
await relativeNextService.close();

const guardedConfigService = new DirectRwsService({
  registryPath,
  pagination: { configPageSize: 100, configMaxItems: 500 }
});
guardedConfigService.registry = { allowedConfigDomains: ["eio"] };
guardedConfigService.bindingRequest = async (_binding, options) => {
  const parameters = query(options.path);
  const start = Number(parameters.get("start"));
  const limit = Number(parameters.get("limit"));
  return pageResponse(
    Array.from({ length: limit }, (_, offset) => configItem(start + offset)),
    true,
    `/rw/cfg/eio/EIO_SIGNAL/instances?start=${start + limit}&limit=${limit}&json=1`
  );
};
await assert.rejects(
  guardedConfigService.configInstances(binding, "eio", "EIO_SIGNAL"),
  /ABB_MCP_CONFIG_MAX_ITEMS \(current 500, maximum 1000000\)/
);
await guardedConfigService.close();

const guardedSignalService = new DirectRwsService({
  registryPath,
  pagination: { signalPageSize: 500, signalMaxItems: 1_000 }
});
guardedSignalService.bindingRequest = async (_binding, options) => {
  const parameters = query(options.path);
  const start = Number(parameters.get("start"));
  const limit = Number(parameters.get("limit"));
  const items = Array.from({ length: limit }, (_, offset) => ({
    _title: `PROFINET/PN_Internal_Device/Unrelated_${start + offset}`,
    name: `Unrelated_${start + offset}`,
    lvalue: "0"
  }));
  return pageResponse(items, true);
};
const missingNames = Array.from({ length: 20 }, (_, index) => `Wanted_${index}`);
await assert.rejects(
  guardedSignalService.signals(binding, missingNames),
  /ABB_MCP_SIGNAL_MAX_ITEMS \(current 1000, maximum 1000000\)/
);
await guardedSignalService.close();

assert.throws(
  () =>
    new DirectRwsService({
      registryPath,
      pagination: { configMaxItems: 1_000_001 }
    }),
  /configMaxItems must be an integer from 1 to 1000000/
);

console.log("direct pagination guard tests passed");
