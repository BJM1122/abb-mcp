import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import {
  assertBackupName,
  backupResourceItems,
  backupRootFor,
  backupRootFromRemotePath,
  createBackupManifestV2,
  encodeRemotePathSegments,
  getRemoteBackupSnapshot,
  getRemoteTreeShape,
  resolveBackupLocalFilePath,
  sha256File,
  verifyBackupManifestV2,
  writeBackupManifestV2
} from "./backup-artifact.mjs";
import { expandEnvironmentVariables } from "./credential-provider.mjs";
import {
  BACKUP_METHODS,
  isDirectBackupMethod
} from "./method-routing.mjs";

const SAFE_CONTROLLER_STATES = new Set(["guardstop", "motoroff"]);
const TOKEN_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 1024 * 1024 * 1024;
const REMOTE_CONFLICT_CHECK_TIMEOUT_MS = 5_000;

function nowIso() {
  return new Date().toISOString();
}

function planHash(plan) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(plan), "utf8")
    .digest("hex");
}

async function exists(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(candidate, root) {
  const relative = path.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function canonicalCandidate(candidate) {
  let cursor = candidate;
  const missing = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`No existing ancestor was found for local path: ${candidate}`);
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(await realpath(cursor), ...missing);
}

async function assertNoPathLinks(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative) return;
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const item = await exists(cursor);
    if (!item) return;
    if (item.isSymbolicLink()) {
      throw new Error(`Symbolic-link or junction path is forbidden for ABB backup: ${cursor}`);
    }
  }
}

async function resolveAllowedLocalRoot(value, registry) {
  const resolved = path.resolve(String(value));
  const allowedRoots = registry?.allowedLocalRoots;
  if (!Array.isArray(allowedRoots) || allowedRoots.length < 1) {
    throw new Error("controller-registry.json must define allowedLocalRoots.");
  }
  let matched = false;
  for (const item of allowedRoots) {
    const root = path.resolve(expandEnvironmentVariables(String(item)));
    if (!isWithin(resolved, root)) continue;
    matched = true;
    const rootItem = await exists(root);
    if (!rootItem || !rootItem.isDirectory()) {
      throw new Error(`Configured ABB allowedLocalRoot is not a directory: ${root}`);
    }
    if (rootItem.isSymbolicLink()) {
      throw new Error(`Configured ABB allowedLocalRoot cannot be a junction: ${root}`);
    }
    const canonicalRoot = await realpath(root);
    await assertNoPathLinks(root, resolved);
    const canonical = await canonicalCandidate(resolved);
    if (!isWithin(canonical, canonicalRoot)) {
      throw new Error(
        `LocalRoot escapes registry allowedLocalRoots after realpath: ${resolved}`
      );
    }
    const resolvedItem = await exists(resolved);
    if (resolvedItem && !resolvedItem.isDirectory()) {
      throw new Error(`ABB backup local root is not a directory: ${resolved}`);
    }
    return resolved;
  }
  if (!matched) {
    throw new Error(`LocalRoot is outside registry allowedLocalRoots: ${resolved}`);
  }
  throw new Error(`LocalRoot could not be validated: ${resolved}`);
}

function identityView(binding, identity) {
  return {
    Endpoint: String(binding.config.baseUrl).replace(/\/+$/, ""),
    Name: String(identity.Name),
    SystemId: String(identity.SystemId),
    RobotWare: String(identity.RobotWare)
  };
}

function assertSameIdentity(expected, actual) {
  for (const field of ["Endpoint", "Name", "SystemId", "RobotWare"]) {
    if (String(expected[field]).toLowerCase() !== String(actual[field]).toLowerCase()) {
      throw new Error(
        `Backup controller identity changed for ${field}: ` +
          `expected '${expected[field]}', actual '${actual[field]}'.`
      );
    }
  }
}

function safetyView(state) {
  return {
    RapidState: String(state.RapidState),
    ControllerState: String(state.ControllerState)
  };
}

function assertSafeState(state) {
  const rapidState = String(state.RapidState).toLowerCase();
  const controllerState = String(state.ControllerState).toLowerCase();
  if (rapidState !== "stopped") {
    throw new Error(`RAPID must be stopped for backup: ${state.RapidState}`);
  }
  if (!SAFE_CONTROLLER_STATES.has(controllerState)) {
    throw new Error(
      `Controller must be guardstop or motoroff for backup: ${state.ControllerState}`
    );
  }
}

function remoteView(snapshot) {
  let knownSizeCount = 0;
  let knownBytes = 0;
  const files = (snapshot?.Files || []).map((file) => {
    const size =
      Number.isSafeInteger(file.Size) && file.Size >= 0 ? file.Size : null;
    if (size !== null) {
      knownSizeCount += 1;
      knownBytes += size;
    }
    return {
      RelativePath: String(file.RelativePath),
      Size: size
    };
  });
  const fileCount = Number(snapshot?.FileCount ?? files.length);
  const allSizesKnown =
    snapshot?.AllSizesKnown === undefined
      ? knownSizeCount === fileCount && files.length === fileCount
      : Boolean(snapshot.AllSizesKnown);
  return {
    Exists: Boolean(snapshot?.Exists),
    FileCount: fileCount,
    KnownSizeCount: Number(snapshot?.KnownSizeCount ?? knownSizeCount),
    KnownBytes: Number(snapshot?.KnownBytes ?? knownBytes),
    TotalBytes: allSizesKnown
      ? Number(snapshot?.KnownBytes ?? snapshot?.TotalBytes ?? knownBytes)
      : null,
    AllSizesKnown: allSizesKnown,
    Files: files
  };
}

function sameOriginPath(location, baseUrl) {
  const base = new URL(baseUrl);
  const target = new URL(String(location), base);
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    const error = new Error(`Unsafe ABB backup progress Location: ${location}`);
    error.code = "RwsCrossOriginRejected";
    throw error;
  }
  return `${target.pathname}${target.search}`;
}

function parseProgress(response) {
  let state = "";
  let code = "";
  try {
    const document = JSON.parse(response.body);
    const item = backupResourceItems(document)[0];
    state = String(item?.state ?? "");
    code = String(item?.code ?? "");
  } catch {
    const stateMatch = String(response.body).match(
      /<span\s+class=(?:"|')state(?:"|')>([\s\S]*?)<\/span>/i
    );
    const codeMatch = String(response.body).match(
      /<span\s+class=(?:"|')code(?:"|')>([\s\S]*?)<\/span>/i
    );
    state = String(stateMatch?.[1] || "").replace(/<[^>]+>/g, "").trim();
    code = String(codeMatch?.[1] || "").replace(/<[^>]+>/g, "").trim();
  }
  return { state, code };
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeFileExclusive(destination, download) {
  await mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    throw new Error(`Local backup file already exists: ${destination}`);
  }
  const partial = `${destination}.partial.${crypto.randomUUID().replaceAll("-", "")}`;
  let handle;
  try {
    handle = await open(partial, "wx");
    const result = await download(handle);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partial, destination);
    return result;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

export class DirectBackupManager {
  constructor(service) {
    this.service = service;
    this.prepared = new Map();
    this.activeApply = null;
  }

  static supports(method) {
    return isDirectBackupMethod(method);
  }

  async aliasFor(method, params = {}) {
    if (method === "plan_backup") return String(params.alias || "");
    if (method === "apply_backup") {
      const item = this.prepared.get(String(params.token || ""));
      return String(item?.plan?.Controller || "");
    }
    if (method === "verify_backup") {
      const manifestPath = path.resolve(String(params.manifestPath || ""));
      await resolveAllowedLocalRoot(path.dirname(manifestPath), this.service.registry);
      const item = await lstat(manifestPath);
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new Error(`ABB backup manifest is not a regular file: ${manifestPath}`);
      }
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      return String(manifest.alias || "");
    }
    return "";
  }

  emit(onProgress, phase, data = {}) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ Phase: phase, At: nowIso(), Data: data });
    } catch {}
  }

  async request(binding, options, operation, allowed = [200]) {
    if (binding.config.rwsProtocol === "rws2") {
      const url = new URL(sameOriginPath(options.path, binding.config.baseUrl), binding.config.baseUrl);
      url.searchParams.delete("json");
      options = { ...options, path: `${url.pathname}${url.search}` };
      // RW7 FileService answers the combined default Accept with HTTP 406:
      // directory listings need hal+json, file downloads octet-stream.
      if (options.method === "GET" && url.pathname.startsWith("/fileservice/") && !options.accept) {
        options.accept = url.pathname.endsWith("/")
          ? "application/hal+json;v=2.0"
          : "application/octet-stream;v=2.0";
      }
    }
    return await this.service.bindingRequest(
      binding,
      {
        ...options,
        timeoutMs:
          options.timeoutMs ??
          Math.max(
            1,
            Number(binding.config.longRequestTimeoutSeconds || 60)
          ) * 1_000
      },
      operation,
      allowed
    );
  }

  remoteRequest(binding, deadline = null) {
    return async (options) =>
      {
        let timeoutMs;
        if (deadline !== null) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            const error = new Error(
              "ABB backup overall deadline expired during FileService enumeration."
            );
            error.code = "BackupOverallTimeout";
            throw error;
          }
          timeoutMs = Math.min(
            remainingMs,
            Math.max(
              1,
              Number(binding.config.longRequestTimeoutSeconds || 60)
            ) * 1_000
          );
        }
        return await this.request(
          binding,
          { ...options, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
          `Read ABB backup FileService ${options.path}`,
          [200, 404]
        );
      };
  }

  async remoteBackupNameExists(binding, backupName) {
    const expected = String(backupName).toLowerCase();
    const root = backupRootFor(binding.config.rwsProtocol);
    let nextPath = `/fileservice/${root}/?json=1`;
    const visited = new Set();
    let entries = 0;
    const deadline = Date.now() + REMOTE_CONFLICT_CHECK_TIMEOUT_MS;
    while (nextPath) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = new Error(
          "ABB backup-root collision check exceeded its 5-second overall deadline."
        );
        error.code = "RwsFileServiceTimeout";
        throw error;
      }
      if (visited.has(nextPath.toLowerCase()) || visited.size >= 100) {
        throw new Error("ABB backup-root directory pagination is unsafe or excessive.");
      }
      visited.add(nextPath.toLowerCase());
      const response = await this.request(
        binding,
        {
          method: "GET",
          path: nextPath,
          timeoutMs: Math.min(
            remainingMs,
            Math.max(
              1,
              Number(binding.config.requestTimeoutSeconds || 5)
            ) * 1_000
          )
        },
        "List ABB backup-root targets",
        [200]
      );
      let document;
      try {
        document = JSON.parse(response.body);
      } catch (error) {
        throw new Error(
          `ABB backup-root listing returned invalid JSON: ${error.message}`
        );
      }
      const items = backupResourceItems(document);
      for (const item of items) {
        entries += 1;
        if (entries > 10_000) {
          throw new Error("ABB backup-root listing exceeded the 10000-entry safety limit.");
        }
        const name = String(item?._title ?? item?.name ?? "").trim();
        if (name.toLowerCase() === expected) return true;
        const type = String(item?._type || "");
        if (!/^fs-(?:dir|file)(?:-li)?$/.test(type)) continue;
      }
      const next = document?._links?.next;
      const href = Array.isArray(next) ? next[0]?.href : next?.href;
      if (!href) {
        nextPath = "";
        continue;
      }
      nextPath = sameOriginPath(href, binding.config.baseUrl);
      if (!nextPath.toLowerCase().startsWith(`/fileservice/${root.toLowerCase()}/`)) {
        throw new Error(`Unsafe ABB backup-root pagination path: ${nextPath}`);
      }
      if (!/[?&]json=1(?:&|$)/i.test(nextPath)) {
        nextPath += nextPath.includes("?") ? "&json=1" : "?json=1";
      }
    }
    return false;
  }

  async freshPreflight(alias) {
    const binding = await this.service.binding(alias, { bypassCircuit: true });
    const identityRead = await this.service.identityForRead(binding, -1);
    const identity = identityView(binding, identityRead.identity);
    const state = await this.service.controllerState(binding);
    assertSafeState(state);
    return { binding, identity, state };
  }

  async plan(params) {
    const alias = String(params.alias);
    const backupName = assertBackupName(String(params.backupName).trim());
    const localRoot = await resolveAllowedLocalRoot(
      params.localRoot,
      this.service.registry
    );
    const localPath = path.resolve(localRoot, backupName);
    if (!isWithin(localPath, localRoot)) {
      throw new Error(`Backup target escapes LocalRoot: ${localPath}`);
    }
    if (await exists(localPath)) {
      throw new Error(
        `Local backup target already exists; overwrite is forbidden: ${localPath}`
      );
    }

    const { binding, identity, state } = await this.freshPreflight(alias);
    const remotePath = `/fileservice/${backupRootFor(binding.config.rwsProtocol)}/${backupName}`;
    if (await this.remoteBackupNameExists(binding, backupName)) {
      throw new Error(
        `Remote ABB backup target already exists; overwrite is forbidden: ${remotePath}`
      );
    }
    const remoteSnapshot = {
      Exists: false,
      BackupName: backupName,
      RemotePath: remotePath,
      FileCount: 0,
      KnownSizeCount: 0,
      KnownBytes: 0,
      AllSizesKnown: true,
      Files: []
    };

    const timeoutSeconds = Number(params.timeoutSeconds || 600);
    const plan = {
      Controller: alias,
      Identity: identity,
      BackupName: backupName,
      Cell: String(params.cell || "").trim(),
      Robot: String(params.robot || "").trim(),
      LocalRoot: localRoot,
      LocalPath: localPath,
      RemotePath: remoteSnapshot.RemotePath,
      TimeoutSeconds: timeoutSeconds,
      Safety: safetyView(state),
      RemoteBefore: remoteView(remoteSnapshot)
    };
    const hash = planHash(plan);
    const token = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
    this.prepared.set(token, {
      token,
      plan,
      planHash: hash,
      expiresAt: expiresAt.getTime(),
      used: false
    });

    return {
      Planned: true,
      ...plan,
      Token: token,
      PlanSha256: hash,
      ExpiresAtUtc: expiresAt.toISOString(),
      RemoteExists: false,
      LocalExists: false,
      ControllerModified: false
    };
  }

  consume(token) {
    const key = String(token);
    const prepared = this.prepared.get(key);
    if (!prepared || prepared.used) {
      throw new Error("Unknown or already-consumed ABB backup plan token.");
    }
    if (Date.now() > prepared.expiresAt) {
      this.prepared.delete(key);
      throw new Error("ABB backup plan token expired; create and approve a new plan.");
    }
    if (prepared.planHash !== planHash(prepared.plan)) {
      this.prepared.delete(key);
      throw new Error(
        "ABB backup plan changed after approval; create and approve a new plan."
      );
    }
    prepared.used = true;
    return prepared;
  }

  async waitForProgress(binding, location, deadline, onProgress) {
    let finalState = "";
    let finalCode = "";
    let lastState = "";
    let lastCode = "";
    let lastReportedAt = 0;
    while (Date.now() < deadline) {
      const response = await this.request(
        binding,
        {
          method: "GET",
          path: String(location).includes("?")
            ? `${location}&json=1`
            : `${location}?json=1`,
          timeoutMs: Math.min(
            Math.max(1, deadline - Date.now()),
            Math.max(
              1,
              Number(binding.config.longRequestTimeoutSeconds || 60)
            ) * 1_000
          )
        },
        "Read ABB backup progress",
        // RW 6.11 RWS1 answers a finished progress resource with 303 See Other
        // pointing at the backup directory, state=ready, code=294912.
        // RW 7.20 RWS2 answers it with 201 Created, state=ready, code=294912.
        [200, 201, 303]
      );
      const progress = parseProgress(response);
      finalState = progress.state;
      finalCode = progress.code;
      if (!finalState && !finalCode) {
        const error = new Error(
          "ABB backup progress response did not contain state or code."
        );
        error.code = "RwsProgressProtocolError";
        throw error;
      }
      const reportDue =
        finalState !== lastState ||
        finalCode !== lastCode ||
        Date.now() - lastReportedAt >= 5_000;
      if (reportDue) {
        lastState = finalState;
        lastCode = finalCode;
        lastReportedAt = Date.now();
        this.emit(onProgress, "backup_progress", {
          state: finalState,
          code: finalCode
        });
      }
      if (
        /(FAIL|ERROR|ABORT|CANCEL)/i.test(finalState) ||
        (/^-/.test(finalCode) && finalCode !== "-0")
      ) {
        throw new Error(
          `Backup progress reported failure: state=${finalState} code=${finalCode}`
        );
      }
      if (
        /^(DONE|COMPLETED|SUCCESS|OK)$/i.test(finalState) ||
        finalCode === "294913" ||
        ((response.statusCode === 303 || response.statusCode === 201) &&
          /^ready$/i.test(finalState))
      ) {
        return { location, finalState, finalCode };
      }
      await delay(Math.min(500, Math.max(1, deadline - Date.now())));
    }
    const error = new Error(
      `ABB backup progress timed out: state=${finalState} code=${finalCode}`
    );
    error.code = "ControllerBackupOutcomeUnknown";
    throw error;
  }

  async downloadFiles(binding, plan, remoteSnapshot, deadline, onProgress) {
    let knownTotal = 0;
    for (const file of remoteSnapshot.Files) {
      if (file.Size === null || file.Size === undefined) continue;
      if (!Number.isSafeInteger(file.Size) || file.Size < 0) {
        throw new Error(`Remote ABB backup file size is invalid: ${file.RelativePath}`);
      }
      if (file.Size > MAX_BACKUP_FILE_BYTES) {
        throw new Error(
          `Remote ABB backup file exceeds ${MAX_BACKUP_FILE_BYTES} bytes: ` +
            `${file.RelativePath}`
        );
      }
      knownTotal += file.Size;
      if (!Number.isSafeInteger(knownTotal) || knownTotal > MAX_BACKUP_TOTAL_BYTES) {
        throw new Error(
          `Remote ABB backup exceeds ${MAX_BACKUP_TOTAL_BYTES} total bytes.`
        );
      }
    }
    await mkdir(plan.LocalPath, { recursive: false });
    const files = remoteSnapshot.Files;
    const records = new Array(files.length);
    let nextIndex = 0;
    let transferredBytes = 0;
    let stopped = false;
    const worker = async () => {
      while (true) {
        if (stopped) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= files.length) return;
        const file = files[index];
        try {
          if (Date.now() >= deadline) {
            throw new Error("ABB backup overall timeout expired during file download.");
          }
          const encoded = encodeRemotePathSegments(file.RelativePath.split("/"));
          const remotePath =
            `/fileservice/${backupRootFromRemotePath(plan.RemotePath)}/` +
            `${encodeURIComponent(plan.BackupName)}/${encoded}`;
          const localPath = resolveBackupLocalFilePath(
            plan.LocalPath,
            file.RelativePath
          );
          this.emit(onProgress, "download_start", {
            index: index + 1,
            count: files.length,
            relativePath: file.RelativePath,
            expectedBytes: file.Size
          });
          const record = await writeFileExclusive(localPath, async (handle) => {
            let receivedBytes = 0;
            const hash = crypto.createHash("sha256");
            const response = await this.request(
              binding,
              {
                method: "GET",
                path: remotePath,
                timeoutMs: Math.min(
                  Math.max(1, deadline - Date.now()),
                  Math.max(
                    1,
                    Number(binding.config.longRequestTimeoutSeconds || 60)
                  ) * 1_000
                ),
                maxResponseBytes:
                  file.Size === null || file.Size === undefined
                    ? MAX_BACKUP_FILE_BYTES
                    : Math.max(1, file.Size),
                consumeResponse: async (chunks) => {
                  for await (const chunk of chunks) {
                    if (Date.now() >= deadline) {
                      throw new Error("ABB backup overall timeout expired during file download.");
                    }
                    receivedBytes += chunk.length;
                    transferredBytes += chunk.length;
                    if (receivedBytes > MAX_BACKUP_FILE_BYTES ||
                        (file.Size !== null && file.Size !== undefined && receivedBytes > file.Size)) {
                      throw new Error(`Downloaded size exceeded limit for ${file.RelativePath}.`);
                    }
                    if (transferredBytes > MAX_BACKUP_TOTAL_BYTES) {
                      throw new Error(`Downloaded ABB backup exceeded ${MAX_BACKUP_TOTAL_BYTES} bytes.`);
                    }
                    hash.update(chunk);
                    await handle.writeFile(chunk);
                  }
                  return hash.digest("hex");
                }
              },
              `Download ABB backup file ${file.RelativePath}`,
              [200]
            );
            if (response.streamedBytes !== receivedBytes || !response.streamResult) {
              throw new Error(`ABB backup download did not complete its stream: ${file.RelativePath}`);
            }
            if (file.Size !== null && file.Size !== undefined && receivedBytes !== file.Size) {
              throw new Error(`Downloaded size mismatch for ${file.RelativePath}: actual=${receivedBytes} remote=${file.Size}`);
            }
            if (Date.now() >= deadline) {
              throw new Error("ABB backup overall timeout expired during file download.");
            }
            return {
              RelativePath: file.RelativePath,
              Size: receivedBytes,
              RemoteSize: file.Size,
              ContentLength: file.Size,
              Sha256: response.streamResult
            };
          });
          records[index] = record;
          this.emit(onProgress, "download_done", {
            index: index + 1,
            count: files.length,
            relativePath: file.RelativePath,
            bytes: record.Size
          });
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(2, files.length) }, worker)
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return records;
  }

  async applyCore(params, onProgress) {
    const started = performance.now();
    const prepared = this.consume(params.token);
    const plan = prepared.plan;
    let stage = "preflight";
    let backupAccepted = false;
    let backupCompleted = false;
    try {
      this.emit(onProgress, "backup_preflight", {
        controller: plan.Controller,
        backupName: plan.BackupName
      });
      const { binding, identity, state } = await this.freshPreflight(
        plan.Controller
      );
      assertSameIdentity(plan.Identity, identity);
      const currentLocalRoot = await resolveAllowedLocalRoot(
        plan.LocalRoot,
        this.service.registry
      );
      const currentLocalPath = path.resolve(currentLocalRoot, plan.BackupName);
      if (
        currentLocalRoot.toLowerCase() !== plan.LocalRoot.toLowerCase() ||
        currentLocalPath.toLowerCase() !== plan.LocalPath.toLowerCase()
      ) {
        throw new Error(
          "ABB backup destination no longer matches the approved plan and current registry."
        );
      }
      if (await exists(plan.LocalPath)) {
        throw new Error(
          `Local backup target appeared after planning; overwrite is forbidden: ` +
          `${plan.LocalPath}`
        );
      }
      stage = "remote-conflict-check";
      if (await this.remoteBackupNameExists(binding, plan.BackupName)) {
        throw new Error(
          `Remote ABB backup target appeared after planning; overwrite is forbidden: ` +
            `${plan.RemotePath}`
        );
      }
      const deadline = Date.now() + plan.TimeoutSeconds * 1_000;
      stage = "create-backup";
      const createStarted = performance.now();
      const response = await this.request(
        binding,
        {
          method: "POST",
          path: binding.config.rwsProtocol === "rws2"
            ? "/ctrl/backup/create" : "/ctrl/backup?action=backup",
          form: { backup: plan.RemotePath, archive: "FALSE" },
          timeoutMs: Math.min(
            Math.max(1, deadline - Date.now()),
            Math.max(
              1,
              Number(binding.config.longRequestTimeoutSeconds || 60)
            ) * 1_000
          )
        },
        "Create ABB controller backup",
        [202]
      );
      if (!response.location) {
        const error = new Error(
          "ABB backup returned HTTP 202 without a Location progress URI."
        );
        error.code = "ControllerBackupOutcomeUnknown";
        throw error;
      }
      backupAccepted = true;
      this.emit(onProgress, "backup_accepted", {
        location: response.location,
        remotePath: plan.RemotePath
      });
      stage = "wait-progress";
      const progress = await this.waitForProgress(
        binding,
        response.location,
        deadline,
        onProgress
      );
      backupCompleted = true;
      const generatedAt = performance.now();
      stage = "enumerate-before-download";
      const remoteBefore = await getRemoteBackupSnapshot({
        request: this.remoteRequest(binding, deadline),
        backupName: plan.BackupName,
        root: backupRootFromRemotePath(plan.RemotePath)
      });
      if (!remoteBefore.Exists || remoteBefore.FileCount < 1) {
        throw new Error("Remote ABB backup tree is empty after completion.");
      }
      stage = "download";
      const downloadStarted = performance.now();
      const files = await this.downloadFiles(
        binding,
        plan,
        remoteBefore,
        deadline,
        onProgress
      );
      stage = "enumerate-after-download";
      const downloadedAt = performance.now();
      const remoteAfter = await getRemoteBackupSnapshot({
        request: this.remoteRequest(binding, deadline),
        backupName: plan.BackupName,
        root: backupRootFromRemotePath(plan.RemotePath)
      });
      if (
        getRemoteTreeShape(remoteBefore.Files).join("\n") !==
        getRemoteTreeShape(remoteAfter.Files).join("\n")
      ) {
        throw new Error(
          "Remote backup tree changed between pre-download and post-download enumeration."
        );
      }

      const manifest = createBackupManifestV2({
        cell: plan.Cell,
        robot: plan.Robot,
        alias: plan.Controller,
        endpoint: identity.Endpoint,
        controller: identity,
        stateBefore: state,
        backupName: plan.BackupName,
        remotePath: plan.RemotePath,
        localPath: plan.LocalPath,
        progress,
        remoteBefore,
        remoteAfter,
        files
      });
      const manifestResult = await writeBackupManifestV2({
        manifest,
        localBackupPath: plan.LocalPath
      });
      const localVerification = await verifyBackupManifestV2({
        manifest,
        manifestPath: manifestResult.ManifestPath,
        localBackupPath: plan.LocalPath
      });
      if (!localVerification.Valid || !localVerification.LocalVerified) {
        throw new Error(
          `Local ABB backup manifest verification failed: ` +
            `${localVerification.Errors.join(" | ")}`
        );
      }
      const totalBytes = files.reduce((total, file) => total + file.Size, 0);
      this.emit(onProgress, "backup_completed", {
        files: files.length,
        bytes: totalBytes,
        manifestPath: manifestResult.ManifestPath
      });
      return {
        Applied: true,
        Controller: plan.Controller,
        Identity: identity,
        BackupName: plan.BackupName,
        RemotePath: plan.RemotePath,
        LocalPath: plan.LocalPath,
        ManifestPath: manifestResult.ManifestPath,
        ManifestSha256: manifestResult.ManifestSha256,
        FileCount: files.length,
        TotalBytes: totalBytes,
        TimingMs: {
          Preflight: Math.round(createStarted - started),
          ControllerBackup: Math.round(generatedAt - createStarted),
          Inventory: Math.round(downloadStarted - generatedAt),
          Download: Math.round(downloadedAt - downloadStarted),
          PostDownloadVerification: Math.round(performance.now() - downloadedAt),
          Total: Math.round(performance.now() - started)
        },
        RemoteBefore: remoteView(remoteBefore),
        RemoteAfter: remoteView(remoteAfter),
        Safety: safetyView(state),
        RobotStarted: false,
        MotorsEnabled: false,
        ControllerModified: true
      };
    } catch (error) {
      const domainCodes = new Set([
        "ControllerBackupOutcomeUnknown",
        "BackupDownloadIncomplete",
        "BackupApplyFailed"
      ]);
      if (stage === "create-backup" || (backupAccepted && !backupCompleted)) {
        error.code = "ControllerBackupOutcomeUnknown";
      } else if (backupCompleted && !domainCodes.has(error.code)) {
        error.code = "BackupDownloadIncomplete";
      } else if (!domainCodes.has(error.code)) {
        error.code = "BackupApplyFailed";
      }
      if (!String(error.message).startsWith(`${error.code}:`)) {
        error.message = `${error.code}: stage=${stage}: ${error.message}`;
      }
      throw error;
    } finally {
      this.prepared.delete(String(params.token));
    }
  }

  async apply(params, onProgress) {
    if (this.activeApply) {
      throw new Error(
        "WorkerBusy: another ABB backup apply is active; it was not interrupted."
      );
    }
    const current = this.applyCore(params, onProgress);
    this.activeApply = current;
    try {
      return await current;
    } finally {
      if (this.activeApply === current) this.activeApply = null;
    }
  }

  async verify(params, timeoutMs = 60_000) {
    const started = performance.now();
    const deadline =
      Date.now() + Math.max(1, Number(timeoutMs || 60_000));
    const manifestPath = path.resolve(String(params.manifestPath));
    const localRoot = await resolveAllowedLocalRoot(
      path.dirname(manifestPath),
      this.service.registry
    );
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    if (manifest.version !== 2) {
      throw new Error("Unsupported ABB backup manifest version.");
    }
    const declaredLocalPath = await resolveAllowedLocalRoot(
      manifest.localPath,
      this.service.registry
    );
    if (
      localRoot.toLowerCase() !== declaredLocalPath.toLowerCase() ||
      path.dirname(manifestPath).toLowerCase() !== declaredLocalPath.toLowerCase()
    ) {
      throw new Error(
        "ABB backup manifest is not stored in its declared local backup directory."
      );
    }
    const alias = String(manifest.alias || "");
    if (!alias) throw new Error("ABB backup manifest is missing alias.");

    await this.service.closeBinding(alias);
    const { binding, identity, state } = await this.freshPreflight(alias);
    assertSameIdentity(
      {
        Endpoint: String(manifest.endpoint || ""),
        Name: String(manifest.controller?.name || ""),
        SystemId: String(manifest.controller?.systemId || ""),
        RobotWare: String(manifest.controller?.robotWare || "")
      },
      identity
    );
    const verification = await verifyBackupManifestV2({
      manifest,
      manifestPath,
      localBackupPath: declaredLocalPath,
      request: this.remoteRequest(binding, deadline)
    });
    const localMismatches = verification.LocalErrors.map((detail) => ({
      Reason: "LocalBackupVerificationFailed",
      Detail: detail
    }));
    const remoteMismatches = verification.RemoteErrors.map((detail) => ({
      Reason: "RemoteBackupVerificationFailed",
      Detail: detail
    }));
    return {
      Verified:
        verification.Valid &&
        verification.LocalVerified &&
        verification.RemoteVerified,
      Controller: alias,
      Identity: identity,
      BackupName: String(manifest.backupName),
      ManifestPath: manifestPath,
      ManifestSha256: await sha256File(manifestPath),
      FileCount: Number(manifest.localVerification?.fileCount || 0),
      TotalBytes: Number(manifest.localVerification?.totalBytes || 0),
      RemoteFileCount: Number(verification.RemoteFileCount || 0),
      RemoteKnownBytes: Number(verification.RemoteKnownBytes || 0),
      RemoteTotalBytes:
        verification.RemoteTotalBytes === null ||
        verification.RemoteTotalBytes === undefined
          ? null
          : Number(verification.RemoteTotalBytes),
      RemoteAllSizesKnown: Boolean(verification.RemoteAllSizesKnown),
      LocalHashMismatches: localMismatches,
      RemoteMismatches: remoteMismatches,
      Safety: safetyView(state),
      FreshSession: true,
      ElapsedMs: Math.round(performance.now() - started),
      ControllerModified: false
    };
  }

  async call(method, params, { onProgress, timeoutMs } = {}) {
    if (method === "plan_backup") return await this.plan(params);
    if (method === "apply_backup") return await this.apply(params, onProgress);
    if (method === "verify_backup") return await this.verify(params, timeoutMs);
    throw new Error(`Unknown direct backup method: ${method}`);
  }

  close() {
    this.prepared.clear();
  }
}

export { BACKUP_METHODS, remoteView, resolveAllowedLocalRoot };
