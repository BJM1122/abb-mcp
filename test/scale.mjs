import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DirectBackupManager } from "../direct-rws/backup-manager.mjs";
import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";
import { attachLazyUtf8Body } from "../direct-rws/lazy-response-body.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const registryPath = new URL(
  "../controller-registry.example.json",
  import.meta.url
).pathname;

function response(document) {
  return {
    statusCode: 200,
    body: JSON.stringify(document),
    bytes: Buffer.alloc(0)
  };
}

function signalItem(name) {
  return {
    _title: `PROFINET/PN_Internal_Device/${name}`,
    name,
    lvalue: "0",
    lstate: "not simulated",
    phstate: "0",
    quality: "1",
    simstate: "not simulated"
  };
}

function configItem(index) {
  const name = `ScaleSignal_${String(index + 1).padStart(5, "0")}`;
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

function query(pathname) {
  return new URL(pathname, "http://controller.invalid").searchParams;
}

const inventoryService = new DirectRwsService({ registryPath, maxSockets: 4 });
inventoryService.registry = { allowedConfigDomains: ["eio"] };
const inventoryBinding = {
  alias: "robot2",
  protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }),
  config: {
    baseUrl: "http://192.0.2.10",
    rwsProtocol: "rws1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  },
  client: { maxSockets: 4 }
};
const signalInventory = new Map(
  Array.from({ length: 3_000 }, (_, index) => {
    const name = `ScaleSignal_${String(index + 1).padStart(5, "0")}`;
    return [name, signalItem(name)];
  })
);
let signalRequests = 0;
inventoryService.bindingRequest = async (_binding, options) => {
  signalRequests += 1;
  const name = decodeURIComponent(options.path.split("?")[0].split("/").at(-1));
  return response({ _embedded: { _state: [signalInventory.get(name)] } });
};
const selectedSignalNames = [
  "ScaleSignal_00001",
  "ScaleSignal_01500",
  "ScaleSignal_03000"
];
const selectedSignals = await inventoryService.signals(
  inventoryBinding,
  selectedSignalNames
);
assert.equal(signalInventory.size, 3_000);
assert.equal(signalRequests, 3);
assert.deepEqual(selectedSignals.map((item) => item.Name), selectedSignalNames);

const totalConfigInstances = 6_000;
let configRequests = 0;
inventoryService.bindingRequest = async (_binding, options) => {
  configRequests += 1;
  const parameters = query(options.path);
  const start = Number(parameters.get("start"));
  const limit = Number(parameters.get("limit"));
  const end = Math.min(totalConfigInstances, start + limit);
  return response({
    _links: end < totalConfigInstances
      ? {
          next: {
            href:
              `/rw/cfg/eio/EIO_SIGNAL/instances?start=${end}` +
              `&limit=${limit}&json=1`
          }
        }
      : {},
    _embedded: {
      _state: Array.from({ length: end - start }, (_, offset) =>
        configItem(start + offset)
      )
    }
  });
};
const configInstances = await inventoryService.configInstances(
  inventoryBinding,
  "eio",
  "EIO_SIGNAL"
);
assert.equal(configInstances.length, totalConfigInstances);
assert.equal(configInstances.at(-1).Attributes.Name, "ScaleSignal_06000");
assert.equal(configRequests, Math.ceil(totalConfigInstances / 70));
await inventoryService.close();

const backupTemp = await mkdtemp(path.join(os.tmpdir(), "abb-scale-backup-"));
const localBackupPath = path.join(backupTemp, "scale_backup");
const largeBytes = Buffer.alloc(64 * 1024 * 1024, 0xa5);
let utf8DecodeCount = 0;
const originalToString = largeBytes.toString;
Object.defineProperty(largeBytes, "toString", {
  configurable: true,
  value(...args) {
    utf8DecodeCount += 1;
    return originalToString.apply(this, args);
  }
});
const binaryResponse = attachLazyUtf8Body(
  {
    statusCode: 200,
    headers: {},
    location: "",
    bytes: largeBytes,
    elapsedMs: 0
  },
  largeBytes
);
const backupService = {
  registry: {},
  async bindingRequest(_binding, options) {
    const streamResult = await options.consumeResponse([binaryResponse.bytes]);
    return { statusCode: 200, streamedBytes: largeBytes.length, streamResult };
  }
};
const backupManager = new DirectBackupManager(backupService);
try {
  await backupManager.downloadFiles(
    {
      alias: "robot2",
      config: { longRequestTimeoutSeconds: 60 }
    },
    {
      BackupName: "scale_backup",
      LocalPath: localBackupPath
    },
    {
      Files: [{ RelativePath: "large.bin", Size: largeBytes.length }]
    },
    Date.now() + 30_000
  );
  assert.equal(utf8DecodeCount, 0, "binary backup download decoded response.body");
  const downloaded = await stat(path.join(localBackupPath, "large.bin"));
  assert.equal(downloaded.size, largeBytes.length);
} finally {
  backupManager.close();
  await rm(backupTemp, { recursive: true, force: true });
}

const slowMaxSockets = 4;
const slowDelayMs = 200;
let slowHttpActive = 0;
let slowHttpPeak = 0;
let slowHttpFinished = 0;
const slowServer = http.createServer((request, serverResponse) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/logout") {
    serverResponse.writeHead(200, { "content-type": "application/json" });
    serverResponse.end("{}");
    return;
  }
  slowHttpActive += 1;
  slowHttpPeak = Math.max(slowHttpPeak, slowHttpActive);
  serverResponse.once("finish", () => {
    slowHttpFinished += 1;
  });
  setTimeout(() => {
    slowHttpActive -= 1;
    const document = pathname.includes("/rw/iosystem/signals/")
      ? {
          _embedded: {
            _state: [signalItem(decodeURIComponent(pathname.split("/").at(-1)))]
          }
        }
      : {
          _embedded: {
            _state: [{ _type: "rap-data", value: "1" }]
          }
        };
    serverResponse.writeHead(200, { "content-type": "application/json" });
    serverResponse.end(JSON.stringify(document));
  }, slowDelayMs);
});
await new Promise((resolve, reject) => {
  slowServer.once("error", reject);
  slowServer.listen(0, "127.0.0.1", resolve);
});
const slowAddress = slowServer.address();
const slowBaseUrl = `http://127.0.0.1:${slowAddress.port}`;
const slowClient = new DigestHttpClient({
  baseUrl: slowBaseUrl,
  credentialProvider: async () => ({ username: "unused", password: "unused" }),
  requestTimeoutMs: 1_000,
  maxSockets: slowMaxSockets
});
const slowService = new DirectRwsService({
  registryPath,
  maxSockets: slowMaxSockets
});
slowService.registry = { controllers: {} };
slowService.reloadRegistry = async () => false;
let slowActive = 0;
let slowMaximumActive = 0;
const slowBinding = {
  alias: "slow_robot",
  protocol: "rws1",
  adapter: new RwsAdapter({ protocol: "rws1" }),
  config: {
    baseUrl: slowBaseUrl,
    rwsProtocol: "rws1",
    defaultTask: "T_ROB1",
    ioNetwork: "PROFINET",
    ioDevice: "PN_Internal_Device"
  },
  client: slowClient,
  identity: { Name: "SLOW_MOCK" },
  boundAt: new Date().toISOString(),
  verifiedAt: new Date().toISOString(),
  lastUsedAt: Date.now()
};
slowService.bindings.set("slow_robot", slowBinding);
const originalSlowInvoke = slowService.invoke.bind(slowService);
slowService.invoke = async (...args) => {
  slowActive += 1;
  slowMaximumActive = Math.max(slowMaximumActive, slowActive);
  try {
    return await originalSlowInvoke(...args);
  } finally {
    slowActive -= 1;
  }
};
const slowStarted = performance.now();
const slowReads = await Promise.all(
  Array.from({ length: 5 }, (_, index) =>
    slowService.call(
      "read_rapid_data",
      {
        alias: "slow_robot",
        task: "T_ROB1",
        module: "ScaleModule",
        name: `Value_${index}`
      },
      2_000,
      100
    )
  )
);
const slowElapsedMs = performance.now() - slowStarted;
assert.equal(slowReads.length, 5);
assert.equal(slowHttpFinished, 5);
assert.equal(slowMaximumActive, 4);
assert.ok(slowHttpPeak <= slowMaxSockets);
assert.ok(
  slowElapsedMs >= 350 && slowElapsedMs < 700,
  `slow reads were not materially faster than 1000 ms serial time: ${slowElapsedMs} ms`
);

slowHttpPeak = 0;
slowHttpFinished = 0;
const nestedStarted = performance.now();
const nestedReads = await Promise.all(
  Array.from({ length: slowMaxSockets }, (_, reader) =>
    slowService.call(
      "read_signals",
      {
        alias: "slow_robot",
        names: Array.from(
          { length: slowMaxSockets },
          (_, signal) => `Nested_${reader + 1}_${signal + 1}`
        )
      },
      5_000,
      5_000
    )
  )
);
const nestedElapsedMs = performance.now() - nestedStarted;
const slowMetrics = slowService.metricsFor("slow_robot");
assert.equal(nestedReads.length, slowMaxSockets);
assert.equal(slowHttpFinished, slowMaxSockets * slowMaxSockets);
assert.ok(slowHttpPeak <= slowMaxSockets);
assert.equal(slowMetrics.TimeoutCount, 0);
assert.equal(slowMetrics.TransportFailureCount, 0);
assert.equal(slowService.transportFailures.has("slow_robot"), false);
await slowService.close();
await new Promise((resolve, reject) => {
  slowServer.close((error) => (error ? reject(error) : resolve()));
});

console.log(
  JSON.stringify(
    {
      ok: true,
      signalInventory: signalInventory.size,
      selectedSignalRequests: signalRequests,
      configInstances: configInstances.length,
      configRequests,
      backupBytes: largeBytes.length,
      binaryUtf8Decodes: utf8DecodeCount,
      slowReadResponses: 5,
      slowReadMaxConcurrency: slowMaximumActive,
      slowReadHttpPeak: slowMaxSockets,
      slowReadElapsedMs: Math.round(slowElapsedMs),
      nestedSignalRequests: slowMaxSockets * slowMaxSockets,
      nestedSignalHttpPeak: slowHttpPeak,
      nestedSignalTimeouts: slowMetrics.TimeoutCount,
      nestedSignalTransportFailures: slowMetrics.TransportFailureCount,
      nestedSignalElapsedMs: Math.round(nestedElapsedMs)
    },
    null,
    2
  )
);
