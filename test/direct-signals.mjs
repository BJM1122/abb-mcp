import assert from "node:assert/strict";

import { RwsHttpError } from "../direct-rws/digest-http-client.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const service = new DirectRwsService({
  registryPath: new URL("../controller-registry.example.json", import.meta.url).pathname
});
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

function signalItem(name, network = "PROFINET", device = "PN_Internal_Device") {
  return {
    _title: `${network}/${device}/${name}`,
    name,
    lvalue: "0",
    lstate: "not simulated",
    phstate: "0",
    quality: "1",
    simstate: "not simulated"
  };
}

function response(document) {
  return { statusCode: 200, body: JSON.stringify(document), bytes: Buffer.alloc(0) };
}

let requestCount = 0;
let activeRequests = 0;
let maximumActiveRequests = 0;
service.bindingRequest = async (_binding, options) => {
  requestCount += 1;
  activeRequests += 1;
  maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const name = decodeURIComponent(options.path.split("?")[0].split("/").at(-1));
    return response({ _embedded: { _state: [signalItem(name)] } });
  } finally {
    activeRequests -= 1;
  }
};

const threeNames = ["Signal_1", "Signal_2", "Signal_3"];
const threeSignals = await service.signals(binding, threeNames);
assert.deepEqual(threeSignals.map((item) => item.Name), threeNames);
assert.equal(requestCount, 3);
assert.equal(maximumActiveRequests, 2);

const inventory = Array.from({ length: 3_000 }, (_, index) =>
  signalItem(`Signal_${index + 1}`)
);
requestCount = 0;
service.bindingRequest = async (_binding, options) => {
  requestCount += 1;
  assert.match(options.path, /^\/rw\/iosystem\/signals\?start=/);
  return response({ _links: {}, _embedded: { _state: inventory } });
};
const twentyNames = Array.from({ length: 20 }, (_, index) => `Signal_${index + 1}`);
const twentySignals = await service.signals(binding, twentyNames);
assert.equal(requestCount, 1);
assert.deepEqual(twentySignals.map((item) => item.Name), twentyNames);

service.bindingRequest = async (_binding, options) => {
  const name = decodeURIComponent(options.path.split("?")[0].split("/").at(-1));
  if (name === "Missing") {
    throw new RwsHttpError("Read I/O signal Missing failed HTTP 404", {
      statusCode: 404
    });
  }
  return response({ _embedded: { _state: [signalItem(name)] } });
};
await assert.rejects(
  service.signals(binding, ["Signal_1", "Missing", "Signal_3"]),
  /I\/O signals not found on PROFINET\/PN_Internal_Device: Missing/
);

service.bindingRequest = async () =>
  response({
    _embedded: { _state: [signalItem("Signal_1", "OtherNetwork", "OtherDevice")] }
  });
await assert.rejects(
  service.signals(binding, ["Signal_1"]),
  /I\/O signals not found on PROFINET\/PN_Internal_Device: Signal_1/
);

await service.close();
console.log("direct signal threshold tests passed");
