import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";

const BACKUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_REMOTE_PAGES = 1_000;
const MAX_REMOTE_ENTRIES = 100_000;
const MANIFEST_FILE_NAME = "backup_manifest.json";

function key(value) {
  return String(value).toLowerCase();
}

function compareOrdinal(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function safeInteger(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function checkedAdd(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} exceeds the JavaScript safe-integer range.`);
  }
  return total;
}

function objectValue(object, ...names) {
  for (const name of names) {
    if (object && Object.prototype.hasOwnProperty.call(object, name)) {
      return object[name];
    }
  }
  return undefined;
}

function responseStatus(response) {
  return Number(objectValue(response, "statusCode", "StatusCode", "status") ?? 0);
}

function responseBody(response) {
  const body = objectValue(response, "body", "Body");
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  return body;
}

function flatBody(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonBody(response, operation) {
  const body = responseBody(response);
  if (body && typeof body === "object") return body;
  try {
    return JSON.parse(String(body ?? ""));
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error.message}`);
  }
}

export function backupResourceItems(document) {
  const embedded = document?._embedded?._state ?? document?._embedded?.state ??
    document?._state ?? document?.state ?? document?._embedded?.resources;
  if (Array.isArray(embedded)) return embedded;
  if (embedded && typeof embedded === "object") return [embedded];
  const error = new Error(
    "Remote FileService directory response is missing _embedded._state."
  );
  error.code = "RwsFileServiceProtocolError";
  throw error;
}

function normalizeNextPagePath(href) {
  const value = String(href ?? "").trim();
  if (!value) return "";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    !value.toLowerCase().startsWith("/fileservice/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value.includes("#") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`Unsafe remote FileService pagination link: ${value}`);
  }
  const rawPath = value.split("?", 1)[0];
  for (const rawSegment of rawPath.split("/")) {
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new Error(`Unsafe remote FileService pagination link: ${value}`);
    }
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      throw new Error(`Unsafe remote FileService pagination link: ${value}`);
    }
  }
  return addJsonQuery(value);
}

function normalizeRemoteFiles(files) {
  const seen = new Set();
  const normalized = [];
  for (const file of files ?? []) {
    const relativePath = normalizeRelativePath(
      objectValue(file, "RelativePath", "relativePath"),
      "remote backup path"
    );
    const folded = key(relativePath);
    if (seen.has(folded)) {
      throw new Error(`Duplicate remote backup path detected: ${relativePath}`);
    }
    seen.add(folded);
    normalized.push({
      RelativePath: relativePath,
      Size: safeInteger(objectValue(file, "Size", "size"), `Remote size for ${relativePath}`, {
        nullable: true
      })
    });
  }
  return normalized.sort((left, right) =>
    compareOrdinal(left.RelativePath, right.RelativePath)
  );
}

function normalizeManifestFile(file) {
  const relativePath = normalizeRelativePath(
    objectValue(file, "RelativePath", "relativePath"),
    "manifest file path"
  );
  const size = safeInteger(
    objectValue(file, "Size", "size"),
    `Manifest size for ${relativePath}`
  );
  const rawRemoteSize = objectValue(file, "RemoteSize", "remoteSize");
  const remoteSize = rawRemoteSize === undefined
    ? size
    : safeInteger(
        rawRemoteSize,
        `Manifest remote size for ${relativePath}`,
        { nullable: true }
      );
  const contentLength = safeInteger(
    objectValue(file, "ContentLength", "contentLength"),
    `Manifest content length for ${relativePath}`,
    { nullable: true }
  );
  const sha256 = String(objectValue(file, "Sha256", "sha256") ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Manifest SHA256 is invalid for ${relativePath}.`);
  }
  return {
    RelativePath: relativePath,
    Size: size,
    RemoteSize: remoteSize,
    ContentLength: contentLength,
    Sha256: sha256
  };
}

function snapshotStats(snapshot, fallbackFiles = []) {
  if (!snapshot) return measureRemoteTree(fallbackFiles);
  const files = snapshot.Files ?? snapshot.files ?? fallbackFiles;
  const measured = measureRemoteTree(files);
  return {
    FileCount: safeInteger(
      snapshot.FileCount ?? snapshot.fileCount ?? measured.FileCount,
      "Remote file count"
    ),
    KnownSizeCount: safeInteger(
      snapshot.KnownSizeCount ?? snapshot.knownSizeCount ?? measured.KnownSizeCount,
      "Remote known-size count"
    ),
    KnownBytes: safeInteger(
      snapshot.KnownBytes ?? snapshot.knownBytes ?? measured.KnownBytes,
      "Remote known bytes"
    ),
    AllSizesKnown: Boolean(
      snapshot.AllSizesKnown ?? snapshot.allSizesKnown ?? measured.AllSizesKnown
    )
  };
}

function manifestRemoteFiles(files) {
  return normalizeRemoteFiles(
    files.map((file) => ({
      RelativePath: file.RelativePath,
      Size: Object.prototype.hasOwnProperty.call(file, "RemoteSize")
        ? file.RemoteSize
        : file.Size
    }))
  );
}

export function assertBackupName(backupName) {
  const value = String(backupName ?? "");
  if (!BACKUP_NAME_PATTERN.test(value)) {
    throw new Error(
      "BackupName must contain only ASCII letters, digits, underscore, dot, or hyphen."
    );
  }
  return value;
}

export function assertSafeRemotePathSegment(name, parent = "") {
  const value = String(name ?? "");
  const deviceStem = value.split(".", 1)[0];
  if (
    !value.trim() ||
    value === "." ||
    value === ".." ||
    /[\/\\\x00-\x1f\x7f<>:"|?*]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(deviceStem)
  ) {
    throw new Error(`Unsafe remote file-service entry name '${value}' under '${parent}'.`);
  }
  return value;
}

export function normalizeRelativePath(relativePath, label = "relative path") {
  const value = String(relativePath ?? "");
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  const segments = value.split("/");
  for (const segment of segments) assertSafeRemotePathSegment(segment, value);
  return segments.join("/");
}

export function encodeRemotePathSegments(segments) {
  return [...segments]
    .map((segment) => {
      const safe = assertSafeRemotePathSegment(segment);
      return encodeURIComponent(safe).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );
    })
    .join("/");
}

export function addJsonQuery(remotePath) {
  const value = String(remotePath ?? "");
  if (/(?:[?&])json=1(?:&|$)/.test(value)) return value;
  return `${value}${value.includes("?") ? "&" : "?"}json=1`;
}

export function resolveBackupLocalFilePath(localBackupPath, relativePath) {
  const rootValue = String(localBackupPath ?? "");
  if (!rootValue.trim()) throw new Error("Local backup path is required.");
  const root = path.resolve(rootValue);
  const normalized = normalizeRelativePath(relativePath, "remote backup path");
  const candidate = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Remote path escapes local backup root: ${relativePath}`);
  }
  return candidate;
}

export function getRemoteTreeShape(files) {
  return normalizeRemoteFiles(files).map(
    (file) => `${file.RelativePath}|${file.Size === null ? "<unknown>" : file.Size}`
  );
}

export function measureRemoteTree(files) {
  const normalized = normalizeRemoteFiles(files);
  let knownBytes = 0;
  let knownSizeCount = 0;
  for (const file of normalized) {
    if (file.Size === null) continue;
    knownSizeCount += 1;
    knownBytes = checkedAdd(knownBytes, file.Size, "Remote backup byte total");
  }
  return {
    FileCount: normalized.length,
    KnownSizeCount: knownSizeCount,
    KnownBytes: knownBytes,
    AllSizesKnown: knownSizeCount === normalized.length
  };
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readRemoteDirectoryEntries({
  request,
  backupName,
  relativeDirectory = "",
  initialResponse = null
}) {
  if (typeof request !== "function") throw new Error("request must be an async function.");
  const safeBackupName = assertBackupName(backupName);
  const directorySegments = relativeDirectory
    ? normalizeRelativePath(relativeDirectory, "remote directory").split("/")
    : [];
  const encoded = encodeRemotePathSegments([safeBackupName, ...directorySegments]);
  const directoryPath = `/fileservice/$SYSPAR/${encoded}/`;
  let nextPath = `${directoryPath}?json=1`;
  let pendingInitialResponse = initialResponse;
  const visitedPages = new Set();
  const entries = [];

  while (nextPath) {
    const pageKey = key(nextPath);
    if (visitedPages.has(pageKey)) {
      throw new Error(
        `Remote directory pagination loop detected for '${relativeDirectory}': ${nextPath}`
      );
    }
    visitedPages.add(pageKey);
    if (visitedPages.size > MAX_REMOTE_PAGES) {
      throw new Error(
        `Remote directory pagination exceeded ${MAX_REMOTE_PAGES} pages for '${relativeDirectory}'.`
      );
    }

    const response =
      pendingInitialResponse ??
      await request({ method: "GET", path: nextPath });
    pendingInitialResponse = null;
    const statusCode = responseStatus(response);
    if (statusCode !== 200) {
      throw new Error(
        `Remote directory read failed HTTP ${statusCode} for ${relativeDirectory}: ` +
          flatBody(responseBody(response))
      );
    }
    const document = parseJsonBody(
      response,
      `Remote directory '${relativeDirectory || "/"}'`
    );
    for (const item of backupResourceItems(document)) {
      const type = String(item?._type ?? "");
      let name = String(item?._title ?? item?.name ?? "");
      if (!name || name === "." || name === "..") continue;
      const kind = /^fs-dir(?:-li)?$/.test(type)
        ? "directory"
        : /^fs-file(?:-li)?$/.test(type)
          ? "file"
          : "";
      if (!kind) continue;
      name = assertSafeRemotePathSegment(name, relativeDirectory);
      const rawSize = item?.["fs-size"] ?? item?.size;
      const size = kind === "file"
        ? safeInteger(rawSize, `Remote file size for ${relativeDirectory}/${name}`, {
            nullable: true
          })
        : null;
      entries.push({ Name: name, Kind: kind, Size: size });
    }

    const next = document?._links?.next;
    const href = Array.isArray(next) ? next[0]?.href : next?.href;
    nextPath = normalizeNextPagePath(href);
    if (nextPath) {
      const nextUrl = new URL(nextPath, "http://abb-rws.local");
      const expectedPath = directoryPath.replace(/\/+$/, "").toLowerCase();
      const actualPath = nextUrl.pathname.replace(/\/+$/, "").toLowerCase();
      if (actualPath !== expectedPath) {
        throw new Error(
          `Unsafe remote FileService pagination link escaped directory ` +
            `'${relativeDirectory || "/"}': ${nextPath}`
        );
      }
    }
  }
  return entries;
}

export async function getRemoteBackupTree({
  request,
  backupName,
  rootResponse = null
}) {
  const safeBackupName = assertBackupName(backupName);
  const directories = [""];
  const seenDirectories = new Set([""]);
  const seenEntries = new Set();
  const files = [];
  let pendingRootResponse = rootResponse;

  while (directories.length > 0) {
    const directory = directories.shift();
    const entries = await readRemoteDirectoryEntries({
      request,
      backupName: safeBackupName,
      relativeDirectory: directory,
      initialResponse: directory === "" ? pendingRootResponse : null
    });
    if (directory === "") pendingRootResponse = null;
    for (const entry of entries) {
      const relativePath = directory
        ? `${directory}/${entry.Name}`
        : entry.Name;
      const folded = key(relativePath);
      if (seenEntries.has(folded)) {
        throw new Error(`Duplicate remote backup path detected: ${relativePath}`);
      }
      seenEntries.add(folded);
      if (seenEntries.size > MAX_REMOTE_ENTRIES) {
        throw new Error(
          `Remote backup tree exceeded the ${MAX_REMOTE_ENTRIES}-entry safety limit.`
        );
      }
      if (entry.Kind === "directory") {
        if (seenDirectories.has(folded)) {
          throw new Error(`Remote directory cycle detected: ${relativePath}`);
        }
        seenDirectories.add(folded);
        directories.push(relativePath);
      } else {
        files.push({ RelativePath: relativePath, Size: entry.Size });
      }
    }
  }
  return normalizeRemoteFiles(files);
}

export async function getRemoteBackupSnapshot({
  request,
  backupName,
  shallow = false
}) {
  if (typeof request !== "function") throw new Error("request must be an async function.");
  const safeBackupName = assertBackupName(backupName);
  const remotePath = `/fileservice/$SYSPAR/${safeBackupName}`;
  const response = await request({ method: "GET", path: `${remotePath}/?json=1` });
  const statusCode = responseStatus(response);
  if (statusCode === 404) {
    return {
      Exists: false,
      BackupName: safeBackupName,
      RemotePath: remotePath,
      FileCount: 0,
      KnownSizeCount: 0,
      KnownBytes: 0,
      AllSizesKnown: true,
      TreeSha256: sha256Text(""),
      Files: []
    };
  }
  if (statusCode !== 200) {
    throw new Error(
      `Remote backup target probe failed HTTP ${statusCode}: ${flatBody(responseBody(response))}`
    );
  }
  if (shallow) {
    return {
      Exists: true,
      BackupName: safeBackupName,
      RemotePath: remotePath,
      FileCount: 0,
      KnownSizeCount: 0,
      KnownBytes: 0,
      AllSizesKnown: false,
      TreeSha256: "",
      TreeEnumerated: false,
      Files: []
    };
  }
  const files = await getRemoteBackupTree({
    request,
    backupName: safeBackupName,
    rootResponse: response
  });
  const statistics = measureRemoteTree(files);
  const shape = getRemoteTreeShape(files);
  return {
    Exists: true,
    BackupName: safeBackupName,
    RemotePath: remotePath,
    ...statistics,
    TreeSha256: sha256Text(shape.join("\n")),
    Files: files
  };
}

export async function buildManifestFileRecords({ remoteFiles, localBackupPath }) {
  const files = normalizeRemoteFiles(remoteFiles);
  const records = [];
  for (const file of files) {
    const localPath = resolveBackupLocalFilePath(localBackupPath, file.RelativePath);
    const item = await lstat(localPath);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`Local backup entry is not a regular file: ${file.RelativePath}`);
    }
    if (file.Size !== null && item.size !== file.Size) {
      throw new Error(
        `Local size mismatch for ${file.RelativePath}: actual=${item.size} remote=${file.Size}`
      );
    }
    records.push({
      RelativePath: file.RelativePath,
      Size: safeInteger(item.size, `Local size for ${file.RelativePath}`),
      RemoteSize: file.Size,
      ContentLength: file.Size,
      Sha256: await sha256File(localPath)
    });
  }
  return records;
}

export function createBackupManifestV2({
  createdAt = new Date().toISOString(),
  cell = "",
  robot = "",
  alias = "",
  endpoint = "",
  controller,
  stateBefore,
  backupName,
  remotePath,
  localPath,
  progress = {},
  remoteBefore,
  remoteAfter,
  files
}) {
  const safeBackupName = assertBackupName(backupName);
  const localPathValue = String(localPath ?? "");
  if (!localPathValue.trim()) throw new Error("Local backup path is required.");
  const normalizedFiles = (files ?? []).map(normalizeManifestFile);
  const seen = new Set();
  for (const file of normalizedFiles) {
    const folded = key(file.RelativePath);
    if (seen.has(folded)) {
      throw new Error(`Duplicate manifest file path: ${file.RelativePath}`);
    }
    seen.add(folded);
  }
  normalizedFiles.sort((left, right) =>
    compareOrdinal(left.RelativePath, right.RelativePath)
  );
  const remoteFiles = manifestRemoteFiles(normalizedFiles);
  const beforeStatistics = snapshotStats(remoteBefore, remoteFiles);
  const afterStatistics = snapshotStats(remoteAfter, remoteFiles);
  let totalBytes = 0;
  for (const file of normalizedFiles) {
    totalBytes = checkedAdd(totalBytes, file.Size, "Local backup byte total");
  }
  const controllerName = String(objectValue(controller, "name", "Name") ?? "");
  const controllerSystemId = String(
    objectValue(controller, "systemId", "SystemId") ?? ""
  );
  const controllerRobotWare = String(
    objectValue(controller, "robotWare", "RobotWare") ?? ""
  );
  return {
    version: 2,
    createdAt: String(createdAt),
    cell: String(cell),
    robot: String(robot),
    alias: String(alias),
    endpoint: String(endpoint),
    controller: {
      name: controllerName,
      systemId: controllerSystemId,
      robotWare: controllerRobotWare
    },
    stateBefore: stateBefore ?? {},
    backupName: safeBackupName,
    remotePath: String(remotePath),
    localPath: path.resolve(localPathValue),
    progress: {
      location: String(objectValue(progress, "location", "Location") ?? ""),
      finalState: String(objectValue(progress, "finalState", "FinalState") ?? ""),
      finalCode: String(objectValue(progress, "finalCode", "FinalCode") ?? "")
    },
    remoteBeforeDownload: {
      fileCount: beforeStatistics.FileCount,
      knownSizeCount: beforeStatistics.KnownSizeCount,
      knownBytes: beforeStatistics.KnownBytes,
      allSizesKnown: beforeStatistics.AllSizesKnown
    },
    remoteAfterDownload: {
      fileCount: afterStatistics.FileCount,
      knownSizeCount: afterStatistics.KnownSizeCount,
      knownBytes: afterStatistics.KnownBytes,
      allSizesKnown: afterStatistics.AllSizesKnown
    },
    localVerification: {
      fileCount: normalizedFiles.length,
      totalBytes,
      matchesRemote: true,
      manifestExcludedFromTotals: true
    },
    files: normalizedFiles
  };
}

export async function writeBackupManifestV2({
  manifest,
  localBackupPath,
  manifestFileName = MANIFEST_FILE_NAME
}) {
  if (manifest?.version !== 2) throw new Error("Unsupported ABB backup manifest version.");
  assertSafeRemotePathSegment(manifestFileName, "local backup root");
  const root = path.resolve(String(localBackupPath));
  await mkdir(root, { recursive: true });
  const manifestPath = path.join(root, manifestFileName);
  const partialPath = `${manifestPath}.partial`;
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  let handle;
  try {
    handle = await open(partialPath, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partialPath, manifestPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    ManifestPath: manifestPath,
    ManifestSha256: crypto.createHash("sha256").update(bytes).digest("hex")
  };
}

async function loadManifest(manifest, manifestPath) {
  if (manifest && typeof manifest === "object") {
    return { manifest, manifestPath: manifestPath ? path.resolve(manifestPath) : "" };
  }
  const sourceValue = String(manifestPath || manifest || "");
  if (!sourceValue.trim()) throw new Error("Backup manifest path is required.");
  const sourcePath = path.resolve(sourceValue);
  const text = await readFile(sourcePath, "utf8");
  return { manifest: JSON.parse(text), manifestPath: sourcePath };
}

function validateManifestStructure(manifest) {
  const errors = [];
  const files = [];
  let structureValid = true;
  if (manifest?.version !== 2) {
    errors.push("Unsupported ABB backup manifest version.");
    structureValid = false;
  }
  try {
    assertBackupName(manifest?.backupName);
  } catch (error) {
    errors.push(error.message);
    structureValid = false;
  }
  if (!Array.isArray(manifest?.files)) {
    errors.push("ABB backup manifest files must be an array.");
    return { errors, files, structureValid: false };
  }
  const seen = new Set();
  for (const rawFile of manifest.files) {
    try {
      const file = normalizeManifestFile(rawFile);
      const folded = key(file.RelativePath);
      if (seen.has(folded)) {
        errors.push(`Duplicate manifest file path: ${file.RelativePath}`);
        structureValid = false;
        continue;
      }
      seen.add(folded);
      files.push(file);
    } catch (error) {
      errors.push(error.message);
      structureValid = false;
    }
  }
  files.sort((left, right) => compareOrdinal(left.RelativePath, right.RelativePath));
  return { errors, files, structureValid };
}

async function enumerateLocalFiles(root, manifestPath, errors) {
  const queue = [root];
  const files = new Map();
  let totalBytes = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        errors.push(`Unexpected local backup symbolic link: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        errors.push(`Unexpected local backup entry: ${relativePath}`);
        continue;
      }
      if (
        manifestPath &&
        fullPath.toLowerCase() === manifestPath.toLowerCase()
      ) {
        continue;
      }
      const folded = key(relativePath);
      if (files.has(folded)) {
        errors.push(`Duplicate local backup path: ${relativePath}`);
        continue;
      }
      const item = await lstat(fullPath);
      const size = safeInteger(item.size, `Local size for ${relativePath}`);
      totalBytes = checkedAdd(totalBytes, size, "Local backup byte total");
      files.set(folded, { relativePath, fullPath, size });
    }
  }
  return { files, totalBytes };
}

export async function verifyBackupManifestV2({
  manifest,
  manifestPath = "",
  localBackupPath = "",
  request = null,
  skipLocalHashes = false
}) {
  const loaded = await loadManifest(manifest, manifestPath);
  const checked = validateManifestStructure(loaded.manifest);
  const errors = [...checked.errors];
  const localErrors = [...checked.errors];
  const remoteErrors = [];
  let localVerified = false;
  let localFileCount = 0;
  let localTotalBytes = 0;
  let remoteVerified = false;
  let remoteFileCount = 0;
  let remoteKnownBytes = 0;
  let remoteAllSizesKnown = false;

  const localRootValue =
    localBackupPath ||
    (loaded.manifestPath
      ? path.dirname(loaded.manifestPath)
      : loaded.manifest?.localPath || "");
  if (localRootValue) {
    const localRoot = path.resolve(String(localRootValue));
    const expectedManifestPath = loaded.manifestPath
      ? loaded.manifestPath
      : path.join(localRoot, MANIFEST_FILE_NAME);
    const localStart = localErrors.length;
    const actual = await enumerateLocalFiles(localRoot, expectedManifestPath, localErrors);
    localFileCount = actual.files.size;
    localTotalBytes = actual.totalBytes;
    const manifestPaths = new Map(
      checked.files.map((file) => [key(file.RelativePath), file])
    );

    for (const actualFile of actual.files.values()) {
      if (!manifestPaths.has(key(actualFile.relativePath))) {
        localErrors.push(`Unexpected local backup file: ${actualFile.relativePath}`);
      }
    }
    for (const file of checked.files) {
      const actualFile = actual.files.get(key(file.RelativePath));
      if (!actualFile) {
        localErrors.push(`Missing local backup file: ${file.RelativePath}`);
        continue;
      }
      try {
        resolveBackupLocalFilePath(localRoot, file.RelativePath);
      } catch (error) {
        localErrors.push(error.message);
        continue;
      }
      if (actualFile.size !== file.Size) {
        localErrors.push(
          `Local size mismatch for ${file.RelativePath}: ` +
            `actual=${actualFile.size} manifest=${file.Size}`
        );
      }
      if (!skipLocalHashes) {
        const actualHash = await sha256File(actualFile.fullPath);
        if (actualHash !== file.Sha256.toLowerCase()) {
          localErrors.push(`Local SHA256 mismatch for ${file.RelativePath}.`);
        }
      }
    }
    localVerified =
      checked.structureValid &&
      localErrors.length === localStart;
    errors.push(...localErrors.slice(checked.errors.length));
  }

  if (request) {
    const snapshot = await getRemoteBackupSnapshot({
      request,
      backupName: loaded.manifest?.backupName
    });
    if (!snapshot.Exists) {
      remoteErrors.push(
        `Remote backup no longer exists: ${loaded.manifest?.backupName ?? ""}`
      );
    } else {
      remoteFileCount = snapshot.FileCount;
      remoteKnownBytes = snapshot.KnownBytes;
      remoteAllSizesKnown = snapshot.AllSizesKnown;
      const expectedShape = getRemoteTreeShape(manifestRemoteFiles(checked.files));
      const actualShape = getRemoteTreeShape(snapshot.Files);
      if (expectedShape.join("\n") !== actualShape.join("\n")) {
        remoteErrors.push("Remote backup tree does not match manifest.");
      } else if (checked.structureValid) {
        remoteVerified = true;
      }
    }
    errors.push(...remoteErrors);
  }

  return {
    Valid: errors.length === 0,
    BackupName: String(loaded.manifest?.backupName ?? ""),
    FileCount: checked.files.length,
    LocalVerified: localVerified,
    LocalFileCount: localFileCount,
    LocalTotalBytes: localTotalBytes,
    RemoteVerified: remoteVerified,
    RemoteFileCount: remoteFileCount,
    RemoteKnownBytes: remoteKnownBytes,
    RemoteTotalBytes: remoteAllSizesKnown ? remoteKnownBytes : null,
    RemoteAllSizesKnown: remoteAllSizesKnown,
    LocalErrors: localErrors,
    RemoteErrors: remoteErrors,
    Errors: errors
  };
}

export {
  BACKUP_NAME_PATTERN,
  MANIFEST_FILE_NAME,
  MAX_REMOTE_ENTRIES,
  MAX_REMOTE_PAGES
};
