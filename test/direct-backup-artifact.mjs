import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildManifestFileRecords,
  createBackupManifestV2,
  encodeRemotePathSegments,
  getRemoteBackupSnapshot,
  getRemoteBackupTree,
  getRemoteTreeShape,
  measureRemoteTree,
  normalizeRelativePath,
  resolveBackupLocalFilePath,
  sha256Text,
  verifyBackupManifestV2,
  writeBackupManifestV2
} from "../direct-rws/backup-artifact.mjs";

const backupName = "offline_backup";
const rootBytes = Buffer.from([0, 1, 2, 3]);
const configBytes = Buffer.from("cfg12", "utf8");
const moduleBytes = Buffer.from("MODULE Main\nENDMODULE\n", "utf8");

function response(statusCode, body) {
  return {
    statusCode,
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

function directory(...items) {
  return {
    _embedded: { _state: items },
    _links: {}
  };
}

function createTreeRequest({ moduleSize = moduleBytes.length } = {}) {
  const calls = [];
  const request = async ({ method, path: requestPath }) => {
    calls.push({ method, path: requestPath });
    assert.equal(method, "GET");
    if (requestPath === "/fileservice/$SYSPAR/offline_backup/?json=1") {
      const body = directory(
        {
          _type: "fs-file",
          _title: "root.bin",
          "fs-size": rootBytes.length
        },
        {
          _type: "fs-dir-li",
          _title: "RAPID files"
        }
      );
      body._links.next = {
        href: "/fileservice/$SYSPAR/offline_backup/?cursor=2"
      };
      return response(200, body);
    }
    if (
      requestPath ===
      "/fileservice/$SYSPAR/offline_backup/?cursor=2&json=1"
    ) {
      return response(
        200,
        directory({
          _type: "fs-file-li",
          _title: "config.cfg",
          "fs-size": configBytes.length
        })
      );
    }
    if (
      requestPath ===
      "/fileservice/$SYSPAR/offline_backup/RAPID%20files/?json=1"
    ) {
      return response(
        200,
        directory({
          _type: "fs-file",
          _title: "Main#1.mod",
          "fs-size": moduleSize
        })
      );
    }
    return response(404, { error: "not-found", path: requestPath });
  };
  return { request, calls };
}

async function expectReject(action, pattern) {
  try {
    await action();
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern);
    return;
  }
  assert.fail(`Expected rejection matching ${pattern}`);
}

assert.equal(
  encodeRemotePathSegments(["RAPID files", "Main#1.mod"]),
  "RAPID%20files/Main%231.mod"
);
assert.equal(normalizeRelativePath("RAPID/Main.mod"), "RAPID/Main.mod");
assert.throws(() => normalizeRelativePath("../escape"), /unsafe/i);
assert.throws(() => normalizeRelativePath("RAPID/../escape"), /unsafe/i);
assert.throws(() => normalizeRelativePath("NUL.txt"), /unsafe/i);
assert.throws(() => normalizeRelativePath("trailing."), /unsafe/i);
assert.throws(
  () => resolveBackupLocalFilePath("", "file.mod"),
  /local backup path is required/i
);
assert.equal(
  resolveBackupLocalFilePath(path.parse(process.cwd()).root, "file.mod"),
  path.resolve(path.parse(process.cwd()).root, "file.mod")
);

const treeFixture = createTreeRequest();
const remoteFiles = await getRemoteBackupTree({
  request: treeFixture.request,
  backupName
});
assert.deepEqual(remoteFiles, [
  { RelativePath: "RAPID files/Main#1.mod", Size: moduleBytes.length },
  { RelativePath: "config.cfg", Size: configBytes.length },
  { RelativePath: "root.bin", Size: rootBytes.length }
]);
assert.equal(
  treeFixture.calls.filter(
    (call) =>
      call.path ===
      "/fileservice/$SYSPAR/offline_backup/RAPID%20files/?json=1"
  ).length,
  1
);

const expectedShape = [
  `RAPID files/Main#1.mod|${moduleBytes.length}`,
  `config.cfg|${configBytes.length}`,
  `root.bin|${rootBytes.length}`
];
assert.deepEqual(getRemoteTreeShape(remoteFiles), expectedShape);
assert.equal(
  sha256Text(expectedShape.join("\n")),
  crypto
    .createHash("sha256")
    .update(expectedShape.join("\n"), "utf8")
    .digest("hex")
);
assert.deepEqual(measureRemoteTree(remoteFiles), {
  FileCount: 3,
  KnownSizeCount: 3,
  KnownBytes: rootBytes.length + configBytes.length + moduleBytes.length,
  AllSizesKnown: true
});
assert.deepEqual(
  measureRemoteTree([
    { RelativePath: "known.bin", Size: 2 },
    { RelativePath: "unknown.bin", Size: null }
  ]),
  {
    FileCount: 2,
    KnownSizeCount: 1,
    KnownBytes: 2,
    AllSizesKnown: false
  }
);

const snapshotFixture = createTreeRequest();
const snapshot = await getRemoteBackupSnapshot({
  request: snapshotFixture.request,
  backupName
});
assert.equal(snapshot.Exists, true);
assert.equal(snapshot.FileCount, 3);
assert.equal(snapshot.KnownBytes, rootBytes.length + configBytes.length + moduleBytes.length);
assert.equal(snapshot.TreeSha256, sha256Text(expectedShape.join("\n")));
assert.equal(
  snapshotFixture.calls.filter(
    (call) =>
      call.path === "/fileservice/$SYSPAR/offline_backup/?json=1"
  ).length,
  1,
  "full snapshots reuse the root probe response instead of reading it twice"
);

const missingSnapshot = await getRemoteBackupSnapshot({
  request: async () => response(404, { error: "not-found" }),
  backupName
});
assert.equal(missingSnapshot.Exists, false);
assert.equal(missingSnapshot.TreeSha256, sha256Text(""));

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () => response(200, { _embedded: {}, _links: {} })
    }),
  /missing _embedded\._state/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () =>
        response(
          200,
          directory({ _type: "fs-file", _title: "../escape", "fs-size": 1 })
        )
    }),
  /unsafe remote file-service entry/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () => {
        const body = directory();
        body._links.next = { href: "https://evil.invalid/files" };
        return response(200, body);
      }
    }),
  /unsafe remote fileservice pagination link/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () => {
        const body = directory();
        body._links.next = {
          href: "/fileservice/$SYSPAR/a_different_backup/?start=2"
        };
        return response(200, body);
      }
    }),
  /pagination link escaped directory/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () => {
        const body = directory();
        body._links.next = {
          href: "/fileservice/$SYSPAR/%2e%2e/rw/system?cursor=2"
        };
        return response(200, body);
      }
    }),
  /unsafe remote fileservice pagination link/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () => {
        const body = directory();
        body._links.next = {
          href: "/fileservice/$SYSPAR/offline_backup/?json=1"
        };
        return response(200, body);
      }
    }),
  /pagination loop/i
);

await expectReject(
  () =>
    getRemoteBackupTree({
      backupName,
      request: async () =>
        response(
          200,
          directory(
            { _type: "fs-file", _title: "Main.mod", "fs-size": 1 },
            { _type: "fs-file", _title: "main.mod", "fs-size": 1 }
          )
        )
    }),
  /duplicate remote backup path/i
);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "abb-direct-backup-"));
const localBackupPath = path.join(temporaryRoot, backupName);
const rapidDirectory = path.join(localBackupPath, "RAPID files");

try {
  await mkdir(rapidDirectory, { recursive: true });
  await writeFile(path.join(localBackupPath, "root.bin"), rootBytes);
  await writeFile(path.join(localBackupPath, "config.cfg"), configBytes);
  await writeFile(path.join(rapidDirectory, "Main#1.mod"), moduleBytes);

  const fileRecords = await buildManifestFileRecords({
    remoteFiles,
    localBackupPath
  });
  assert.equal(fileRecords.length, 3);
  for (const record of fileRecords) {
    const expectedBytes =
      record.RelativePath === "root.bin"
        ? rootBytes
        : record.RelativePath === "config.cfg"
          ? configBytes
          : moduleBytes;
    assert.equal(record.Size, expectedBytes.length);
    assert.equal(
      record.Sha256,
      crypto.createHash("sha256").update(expectedBytes).digest("hex")
    );
  }

  const manifest = createBackupManifestV2({
    createdAt: "2026-07-29T00:00:00.000Z",
    cell: "1600T-3",
    robot: "R2",
    alias: "robot2",
    endpoint: "http://192.0.2.100",
    controller: {
      name: "OFFLINE",
      systemId: "00000000-0000-0000-0000-000000000000",
      robotWare: "6.10.1039"
    },
    stateBefore: {
      Opmode: "AUTO",
      ControllerState: "motoroff",
      RapidState: "stopped"
    },
    backupName,
    remotePath: `/fileservice/$SYSPAR/${backupName}`,
    localPath: localBackupPath,
    progress: {
      location: "/progress/1",
      finalState: "DONE",
      finalCode: "294913"
    },
    remoteBefore: snapshot,
    remoteAfter: snapshot,
    files: fileRecords
  });

  assert.equal(manifest.version, 2);
  assert.equal(manifest.backupName, backupName);
  assert.equal(manifest.localPath, path.resolve(localBackupPath));
  assert.deepEqual(manifest.controller, {
    name: "OFFLINE",
    systemId: "00000000-0000-0000-0000-000000000000",
    robotWare: "6.10.1039"
  });
  assert.deepEqual(manifest.localVerification, {
    fileCount: 3,
    totalBytes: rootBytes.length + configBytes.length + moduleBytes.length,
    matchesRemote: true,
    manifestExcludedFromTotals: true
  });

  assert.throws(
    () =>
      createBackupManifestV2({
        backupName,
        remotePath: "/fileservice/$SYSPAR/offline_backup",
        localPath: localBackupPath,
        files: [
          fileRecords[0],
          { ...fileRecords[0], RelativePath: fileRecords[0].RelativePath.toLowerCase() }
        ]
      }),
    /duplicate manifest file path/i
  );
  assert.throws(
    () =>
      createBackupManifestV2({
        backupName,
        remotePath: "/fileservice/$SYSPAR/offline_backup",
        localPath: localBackupPath,
        files: [{ ...fileRecords[0], RelativePath: "../escape" }]
      }),
    /unsafe/i
  );

  const written = await writeBackupManifestV2({
    manifest,
    localBackupPath
  });
  const manifestBytes = await readFile(written.ManifestPath);
  assert.equal(
    written.ManifestSha256,
    crypto.createHash("sha256").update(manifestBytes).digest("hex")
  );

  const exactFixture = createTreeRequest();
  const exact = await verifyBackupManifestV2({
    manifestPath: written.ManifestPath,
    request: exactFixture.request
  });
  assert.equal(exact.Valid, true);
  assert.equal(exact.LocalVerified, true);
  assert.equal(exact.RemoteVerified, true);
  assert.equal(exact.LocalFileCount, 3);
  assert.equal(exact.RemoteFileCount, 3);
  assert.deepEqual(exact.Errors, []);

  const fallbackManifest = structuredClone(manifest);
  delete fallbackManifest.files[0].RemoteSize;
  const fallbackFixture = createTreeRequest();
  const fallback = await verifyBackupManifestV2({
    manifest: fallbackManifest,
    localBackupPath,
    request: fallbackFixture.request
  });
  assert.equal(
    fallback.RemoteVerified,
    true,
    "missing RemoteSize must retain the legacy fallback to Size"
  );

  const extraPath = path.join(localBackupPath, "unexpected.partial");
  await writeFile(extraPath, Buffer.from([1, 2, 3]));
  const extra = await verifyBackupManifestV2({
    manifestPath: written.ManifestPath
  });
  assert.equal(extra.Valid, false);
  assert.equal(extra.LocalVerified, false);
  assert.match(extra.Errors.join("\n"), /unexpected local backup file/i);
  await unlink(extraPath);

  const alteredRootBytes = Buffer.from([3, 2, 1, 0]);
  await writeFile(path.join(localBackupPath, "root.bin"), alteredRootBytes);
  const hashMismatch = await verifyBackupManifestV2({
    manifestPath: written.ManifestPath
  });
  assert.equal(hashMismatch.Valid, false);
  assert.match(hashMismatch.Errors.join("\n"), /local sha256 mismatch/i);
  await writeFile(path.join(localBackupPath, "root.bin"), rootBytes);

  const configPath = path.join(localBackupPath, "config.cfg");
  await unlink(configPath);
  const missing = await verifyBackupManifestV2({
    manifestPath: written.ManifestPath
  });
  assert.equal(missing.Valid, false);
  assert.match(missing.Errors.join("\n"), /missing local backup file/i);
  await writeFile(configPath, configBytes);

  const changedRemoteFixture = createTreeRequest({
    moduleSize: moduleBytes.length + 1
  });
  const changedRemote = await verifyBackupManifestV2({
    manifestPath: written.ManifestPath,
    request: changedRemoteFixture.request
  });
  assert.equal(changedRemote.Valid, false);
  assert.equal(changedRemote.LocalVerified, true);
  assert.equal(changedRemote.RemoteVerified, false);
  assert.match(changedRemote.Errors.join("\n"), /remote backup tree does not match/i);

  const traversalManifest = structuredClone(manifest);
  traversalManifest.files[0].RelativePath = "../escape";
  const traversal = await verifyBackupManifestV2({
    manifest: traversalManifest,
    localBackupPath
  });
  assert.equal(traversal.Valid, false);
  assert.match(traversal.Errors.join("\n"), /unsafe/i);

  console.log(
    JSON.stringify(
      {
        ok: true,
        remoteFiles: snapshot.FileCount,
        remoteBytes: snapshot.KnownBytes,
        treeSha256: snapshot.TreeSha256,
        manifestSha256: written.ManifestSha256,
        exactLocalAndRemoteVerification: exact.Valid,
        missingRemoteSizeFallback: fallback.RemoteVerified,
        extraFileRejected: !extra.Valid,
        hashMismatchRejected: !hashMismatch.Valid,
        missingFileRejected: !missing.Valid,
        remoteMismatchRejected: !changedRemote.Valid,
        traversalRejected: !traversal.Valid
      },
      null,
      2
    )
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
