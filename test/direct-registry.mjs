import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DirectChangesetServiceAdapter } from "../direct-rws/changeset-service-adapter.mjs";
import { RwsAdapter } from "../direct-rws/rws-adapter.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "abb-direct-registry-"));
const registryPath = path.join(root, "controller-registry.json");

function registry(expectedName) {
  return {
    version: 1,
    allowedLocalRoots: [root],
    allowedConfigDomains: ["eio", "sio", "sys", "proc"],
    controllers: {
      robot_a: {
        baseUrl: "http://192.0.2.10",
        expectedName,
        expectedSystemId: "11111111-2222-3333-4444-555555555555",
        expectedRobotWare: "6.13.0164",
        username: "Default User",
        credentialFile: "%USERPROFILE%\\.codex\\secrets\\abb-mcp\\test.clixml",
        defaultTask: "T_ROB1",
        ioNetwork: "PROFINET",
        ioDevice: "PN_Internal_Device",
        rwsProtocol: "rws1",
        requestTimeoutSeconds: 5,
        longRequestTimeoutSeconds: 60
      }
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const service = new DirectRwsService({ registryPath });
try {
  const firstText = `${JSON.stringify(registry("CELL_A"), null, 2)}\n`;
  const secondText = `${JSON.stringify(registry("CELL_B"), null, 2)}\n`;
  assert.equal(
    Buffer.byteLength(firstText),
    Buffer.byteLength(secondText),
    "fixture must preserve registry byte length"
  );

  const fixedTimestamp = new Date("2026-01-02T03:04:05.000Z");
  await writeFile(registryPath, firstText, "utf8");
  await utimes(registryPath, fixedTimestamp, fixedTimestamp);
  const firstMetadata = await stat(registryPath);
  assert.equal(await service.reloadRegistry(), true);
  assert.equal(service.config("robot_a").expectedName, "CELL_A");
  const firstHash = service.registrySha256;

  await writeFile(registryPath, secondText, "utf8");
  await utimes(registryPath, fixedTimestamp, fixedTimestamp);
  const secondMetadata = await stat(registryPath);
  assert.equal(secondMetadata.size, firstMetadata.size);
  assert.equal(secondMetadata.mtimeMs, firstMetadata.mtimeMs);
  assert.equal(Object.hasOwn(service, "registryStamp"), false);
  assert.equal(await service.reloadRegistry(), true);
  assert.equal(service.config("robot_a").expectedName, "CELL_B");
  assert.notEqual(service.registrySha256, firstHash);

  const firstReadStarted = deferred();
  const releaseFirstRead = deferred();
  let currentBytes = Buffer.from(firstText, "utf8");
  let readCount = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  const concurrentService = new DirectRwsService({
    registryPath,
    registryFileReader: async () => {
      const readNumber = ++readCount;
      const snapshot = Buffer.from(currentBytes);
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        if (readNumber === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return snapshot;
      } finally {
        activeReads -= 1;
      }
    }
  });
  let staleReload;
  let freshReload;
  try {
    staleReload = concurrentService.reloadRegistry();
    await firstReadStarted.promise;
    currentBytes = Buffer.from(secondText, "utf8");
    freshReload = concurrentService.reloadRegistry();
    await Promise.resolve();
    assert.equal(
      readCount,
      1,
      "a newer reload must wait until the older full read and SHA update finish"
    );
    releaseFirstRead.resolve();
    assert.equal(await staleReload, true);
    assert.equal(await freshReload, true);
    assert.equal(readCount, 2, "concurrent callers must each perform a full read");
    assert.equal(maxActiveReads, 1, "registry reads must be serialized");
    assert.equal(
      concurrentService.config("robot_a").expectedName,
      "CELL_B",
      "an older delayed read must not overwrite the newer registry state"
    );
  } finally {
    releaseFirstRead.resolve();
    await Promise.allSettled([staleReload, freshReload].filter(Boolean));
    await concurrentService.close();
  }

  for (const alias of ["__proto__", "prototype", "constructor"]) {
    assert.throws(() => service.config(alias), /Unknown controller alias/);
  }

  const adapter = new DirectChangesetServiceAdapter({
    service,
    protocol: "rws1"
  });
  let closeCalls = 0;
  let requestCalls = 0;
  const activeBinding = {
    alias: "robot_a",
    protocol: "rws1",
    adapter: new RwsAdapter({ protocol: "rws1" }),
    config: service.config("robot_a"),
    client: {
      closed: false,
      async request() {
        requestCalls += 1;
        throw new Error("registry drift must fail before an RWS request");
      },
      async close() {
        closeCalls += 1;
        this.closed = true;
      }
    },
    lastUsedAt: Date.now()
  };
  service.bindings.set("robot_a", activeBinding);
  const activeSession = await adapter.openSession({
    controller: "robot_a",
    fresh: false
  });
  assert.equal(activeBinding.noReconnect, true);

  await writeFile(
    registryPath,
    `${JSON.stringify(registry("CELL_C"), null, 2)}\n`,
    "utf8"
  );
  assert.equal(await service.reloadRegistry(), true);
  assert.equal(
    closeCalls,
    0,
    "registry refresh must not close an active no-reconnect changeset binding"
  );
  assert.equal(activeBinding.registryStale, true);
  await assert.rejects(
    adapter.getIdentity({ controller: "robot_a", session: activeSession }),
    /changed after the changeset session was opened/,
    "the active target call must still fail closed on ControllerLock drift"
  );
  assert.equal(requestCalls, 0);
  await adapter.close();
  assert.equal(closeCalls, 1, "normal changeset teardown closes the stale binding");

  console.log(
    JSON.stringify(
      {
        ok: true,
        offlineOnly: true,
        contentHashReload: true,
        sameLengthChangeDetected: true,
        concurrentReloadSerialized: true,
        delayedOldStateCannotOverwriteNewState: true,
        prototypeAliasesRejected: true,
        activeChangesetBindingDeferredClose: true,
        controllerLockDriftFailedClosed: true,
        controllerCalls: 0
      },
      null,
      2
    )
  );
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
