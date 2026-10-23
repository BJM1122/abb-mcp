import crypto from "node:crypto";
import { mapWithConcurrency } from "./bounded-map.mjs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expandEnvironmentVariables } from "./credential-provider.mjs";

const BUILT_IN_CONFIG_DOMAINS = new Set(["eio", "sio", "sys", "proc"]);
const CONFIG_OPERATION_KINDS = new Set([
  "cfg_set",
  "cfg_upsert",
  "cfg_delete",
  "cfg_file_load"
]);
const TOKEN_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_OPERATIONS = 250;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const METRIC_NAMES = [
  "RequestCount",
  "SessionCreateCount",
  "ReconnectCount",
  "TimeoutCount",
  "TransportFailureCount",
  "CircuitFastFailCount"
];

function hasOwn(object, name) {
  return Boolean(
    object &&
    typeof object === "object" &&
    Object.prototype.hasOwnProperty.call(object, name)
  );
}

function objectValue(object, ...names) {
  for (const name of names) {
    if (hasOwn(object, name)) return object[name];
  }
  if (!object || typeof object !== "object") return undefined;
  const entries = Object.entries(object);
  for (const name of names) {
    const match = entries.find(
      ([key]) => key.toLowerCase() === String(name).toLowerCase()
    );
    if (match) return match[1];
  }
  return undefined;
}

function requiredValue(object, name) {
  const value = objectValue(object, name);
  if (value === undefined) throw new Error(`Missing required property: ${name}`);
  return value;
}

function psString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function equalIgnoreCase(left, right) {
  return psString(left).toLowerCase() === psString(right).toLowerCase();
}

function equalExact(left, right) {
  return psString(left) === psString(right);
}

function psBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false" || value === "") return false;
  }
  return Boolean(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function comparePowerShellLike(left, right) {
  const foldedLeft = psString(left).toLowerCase();
  const foldedRight = psString(right).toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  const exactLeft = psString(left);
  const exactRight = psString(right);
  if (exactLeft < exactRight) return -1;
  if (exactLeft > exactRight) return 1;
  return 0;
}

function checkedNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function normalizeSystemId(value) {
  return psString(value)
    .trim()
    .replace(/^[{]+|[}]+$/g, "")
    .toLowerCase();
}

function normalizeTextForHash(text) {
  return psString(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return crypto
    .createHash("sha256")
    .update(normalizeTextForHash(text), "utf8")
    .digest("hex");
}

function decodeCapturedText(bytes) {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2 !== 0) {
      throw new Error("UTF-16BE file contains an incomplete code unit.");
    }
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function assertSafeIdentifier(value, label) {
  const text = psString(value);
  if (!SAFE_IDENTIFIER_PATTERN.test(text)) {
    throw new Error(`Unsafe ${label}: ${text}`);
  }
  return text;
}

function assertSafeConfigInstanceKey(value, label) {
  const text = psString(value);
  if (
    text.length < 1 ||
    text.length > 160 ||
    text !== text.trim() ||
    /[\x00-\x1f\x7f/\\?#]/.test(text)
  ) {
    throw new Error(`Unsafe ${label}: ${text}`);
  }
  return text;
}

function normalizeAllowedDomains(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("allowedConfigDomains must be explicitly defined.");
  }
  const domains = [...new Set(values.map((value) => psString(value).trim().toLowerCase()))];
  if (domains.some((domain) => !BUILT_IN_CONFIG_DOMAINS.has(domain))) {
    throw new Error(
      "allowedConfigDomains may contain only eio, sio, sys, and proc. " +
        "Motion configuration is intentionally blocked."
    );
  }
  return new Set(domains);
}

function normalizeConfigDomain(domain, allowedDomains) {
  const normalized = psString(domain).trim().toLowerCase();
  if (!allowedDomains.has(normalized)) {
    throw new Error(`Configuration domain is not allowed: ${domain}`);
  }
  return normalized;
}

function normalizeAttributes(attributes, label = "configuration attributes") {
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  const normalized = {};
  for (const [name, value] of Object.entries(attributes)) {
    normalized[name] = psString(value);
  }
  return normalized;
}

function attributeValue(attributes, name, { required = false } = {}) {
  const entries = Object.entries(attributes);
  const match = entries.find(
    ([key]) => key.toLowerCase() === psString(name).toLowerCase()
  );
  if (!match) {
    if (required) throw new Error(`Missing required property: ${name}`);
    return undefined;
  }
  return match[1];
}

function normalizeConfigInstance(instance, { domain, type, instanceKey = "" } = {}) {
  if (instance === null || instance === undefined) return null;
  if (typeof instance !== "object" || Array.isArray(instance)) {
    throw new Error(`Invalid configuration instance for ${domain}/${type}.`);
  }
  const attributes = normalizeAttributes(
    objectValue(instance, "Attributes", "attributes"),
    `Configuration attributes for ${domain}/${type}/${instanceKey}`
  );
  const key = psString(objectValue(instance, "Key", "key"));
  const instanceId = psString(
    objectValue(instance, "InstanceId", "instanceId", "instanceid")
  );
  const deleteKeyValue = objectValue(instance, "DeleteKey", "deleteKey");
  return {
    Domain: domain,
    Type: type,
    Instance: instanceKey,
    Key: key,
    InstanceId: instanceId,
    DeleteKey:
      deleteKeyValue === undefined
        ? instanceId || key
        : psString(deleteKeyValue),
    ReadOnly: psBoolean(objectValue(instance, "ReadOnly", "readOnly")),
    Attributes: attributes
  };
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new Error("Controller identity read returned no identity.");
  }
  const normalized = {
    Name: psString(objectValue(identity, "Name", "name")),
    SystemId: normalizeSystemId(
      objectValue(identity, "SystemId", "systemId", "sysid")
    ),
    RobotWare: psString(
      objectValue(identity, "RobotWare", "robotWare", "rwversion")
    )
  };
  const endpoint = objectValue(
    identity,
    "Endpoint",
    "endpoint",
    "BaseUrl",
    "baseUrl"
  );
  const controllerLock = objectValue(
    identity,
    "ControllerLock",
    "controllerLock",
    "RegistrySignature",
    "registrySignature"
  );
  if (endpoint !== undefined && endpoint !== null && psString(endpoint).trim()) {
    normalized.Endpoint = psString(endpoint).trim();
  }
  const protocol = psString(
    objectValue(identity, "Protocol", "protocol", "RwsProtocol", "rwsProtocol")
  ).trim().toLowerCase();
  if (protocol) {
    if (!new Set(["rws1", "rws2"]).has(protocol)) {
      throw new Error(`Controller identity returned an unsupported protocol: ${protocol}`);
    }
    normalized.Protocol = protocol;
  }
  if (
    controllerLock !== undefined &&
    controllerLock !== null &&
    psString(controllerLock).trim()
  ) {
    normalized.ControllerLock = psString(controllerLock).trim();
  }
  if (!normalized.Name || !normalized.SystemId || !normalized.RobotWare) {
    throw new Error("Controller identity read is missing Name, SystemId, or RobotWare.");
  }
  return normalized;
}

function assertExpectedIdentity(changeset, identity) {
  const expected = requiredValue(changeset, "expectedController");
  const expectedName = psString(requiredValue(expected, "name"));
  const expectedSystemId = normalizeSystemId(requiredValue(expected, "systemId"));
  const expectedRobotWare = psString(requiredValue(expected, "robotWare"));
  if (
    !equalIgnoreCase(identity.Name, expectedName) ||
    identity.SystemId !== expectedSystemId
  ) {
    throw new Error(
      `CONTROLLER IDENTITY MISMATCH: actual=${identity.Name}/${identity.SystemId}, ` +
        `expected=${expectedName}/${expectedSystemId}`
    );
  }
  if (!equalIgnoreCase(identity.RobotWare, expectedRobotWare)) {
    throw new Error(
      `ROBOTWARE MISMATCH: actual=${identity.RobotWare}, expected=${expectedRobotWare}`
    );
  }
}

function normalizeControllerState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("Controller state read returned no state.");
  }
  return {
    Opmode: psString(objectValue(state, "Opmode", "opmode")),
    ControllerState: psString(
      objectValue(state, "ControllerState", "controllerState", "ctrlstate")
    ),
    RapidState: psString(
      objectValue(state, "RapidState", "rapidState", "ctrlexecstate")
    )
  };
}

function evaluateSafety(changeset, state) {
  const safety = requiredValue(changeset, "safety");
  if (requiredValue(safety, "requireRapidStopped") !== true) {
    throw new Error("All ABB jobs must require RAPID stopped.");
  }
  const allowed = requiredValue(safety, "allowedControllerStates");
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error("allowedControllerStates may contain only guardstop and motoroff.");
  }
  const normalized = allowed.map((value) => psString(value).toLowerCase());
  if (normalized.some((value) => !["guardstop", "motoroff"].includes(value))) {
    throw new Error("allowedControllerStates may contain only guardstop and motoroff.");
  }
  const blockers = [];
  if (!state.Opmode || !state.ControllerState || !state.RapidState) {
    blockers.push({
      Code: "StateIncomplete",
      Message: "Controller state is incomplete; write readiness cannot be established."
    });
  }
  if (state.RapidState.toLowerCase() !== "stopped") {
    blockers.push({
      Code: "RapidNotStopped", Actual: state.RapidState,
      Message: "RAPID must report stopped. A stationary robot or a program waiting for PLC input may still report running."
    });
  }
  if (!normalized.includes(state.ControllerState.toLowerCase())) {
    blockers.push({
      Code: "ControllerStateBlocked", Actual: state.ControllerState,
      Allowed: normalized,
      Message: "This MCP write policy requires guardstop or motoroff; this is separate from RAPID execution status."
    });
  }
  return { SafetyBlocked: blockers.length > 0, WriteBlockers: blockers };
}

function sourceDifference(before, after) {
  const lines = (value) => value === null ? [] :
    psString(value).replace(/\r\n?/g, "\n").trim().split("\n");
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  // Bound the displayed excerpt, never the approved artifact or its hash.
  const excerpt = (values, end) =>
    values.slice(start, Math.min(end, start + 100)).join("\n");
  const oldText = excerpt(oldLines, oldEnd);
  const newText = excerpt(newLines, newEnd);
  return {
    StartLine: start + 1,
    BeforeLineCount: oldEnd - start,
    AfterLineCount: newEnd - start,
    Before: oldText.slice(0, 12000),
    After: newText.slice(0, 12000),
    Truncated: oldEnd - start > 100 || newEnd - start > 100 ||
      oldText.length > 12000 || newText.length > 12000
  };
}

function getCfgTextDomain(text, allowedDomains) {
  const firstLine = psString(text)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  const match = psString(firstLine).match(
    /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:CFG_/i
  );
  if (!match) throw new Error("ABB CFG header is missing or invalid.");
  return normalizeConfigDomain(match[1], allowedDomains);
}

function parseCfgEntryLine(domain, type, line) {
  const fields = {};
  const pattern =
    /-(?<name>[A-Za-z0-9_]+)\s+(?:"(?<quoted>[^"]*)"|(?<bare>[^\s]+))/g;
  for (const match of psString(line).matchAll(pattern)) {
    fields[match.groups.name] =
      match.groups.quoted !== undefined
        ? match.groups.quoted
        : match.groups.bare;
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(`Unable to parse ABB CFG entry in ${domain}/${type}: ${line}`);
  }
  return { Domain: domain, Type: type, Fields: fields };
}

function parseCfgText(text, allowedDomains) {
  const domain = getCfgTextDomain(text, allowedDomains);
  const entries = [];
  let section = "";
  let buffer = "";

  const flush = () => {
    if (!buffer.trim()) return;
    entries.push(parseCfgEntryLine(domain, section, buffer));
    buffer = "";
  };

  for (const rawLine of psString(text).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^[A-Za-z][A-Za-z0-9_]*\s*:CFG_/i.test(trimmed)) continue;
    if (!trimmed || trimmed === "#") {
      flush();
      continue;
    }
    const sectionMatch = trimmed.match(/^([A-Za-z0-9_]+):$/);
    if (sectionMatch) {
      flush();
      section = assertSafeIdentifier(sectionMatch[1], "CFG section type");
      continue;
    }
    if (!section) throw new Error(`CFG entry appears before a section: ${trimmed}`);
    const continued = trimmed.endsWith("\\");
    const part = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    buffer = `${buffer} ${part}`.trim();
    if (!continued) flush();
  }
  flush();
  if (entries.length === 0) {
    throw new Error("ABB CFG file contains no configuration entries.");
  }
  return entries;
}

function cfgEntryPresent(entry, instances) {
  return instances.some((instance) =>
    Object.entries(entry.Fields).every(([name, value]) => {
      const actual = attributeValue(instance.Attributes, name);
      return actual !== undefined && equalExact(actual, value);
    })
  );
}

function configAttributesSha256(attributes) {
  const normalized = normalizeAttributes(attributes);
  const ordered = {};
  for (const name of Object.keys(normalized).sort(comparePowerShellLike)) {
    ordered[name] = psString(normalized[name]);
  }
  return sha256Text(JSON.stringify(ordered));
}

function configInventorySha256(instances) {
  const rows = [...instances]
    .map((instance) => ({
      Key: psString(objectValue(instance, "Key", "key")),
      InstanceId: psString(
        objectValue(instance, "InstanceId", "instanceId", "instanceid")
      ),
      AttributesSha256: configAttributesSha256(
        objectValue(instance, "Attributes", "attributes")
      )
    }))
    .sort(
      (left, right) =>
        comparePowerShellLike(left.Key, right.Key) ||
        comparePowerShellLike(left.InstanceId, right.InstanceId)
    );
  const serialized =
    rows.length === 0
      ? ""
      : JSON.stringify(rows.length === 1 ? rows[0] : rows);
  return sha256Text(serialized);
}

function verifyObjectFields(fields, label) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`${label} fields must be an object.`);
  }
  const entries = Object.entries(fields);
  if (entries.length === 0) throw new Error(`${label} fields cannot be empty.`);
  for (const [name] of entries) assertSafeIdentifier(name, `${label} field`);
  return entries;
}

function assertCfgVerificationSpec(verify, operationDomain, allowedDomains) {
  if (!verify || typeof verify !== "object" || Array.isArray(verify)) {
    throw new Error("cfg_file_load requires an operation-level verify block.");
  }
  let checkCount = 0;
  const cfgInstances = objectValue(verify, "cfgInstances");
  if (cfgInstances !== undefined && !Array.isArray(cfgInstances)) {
    throw new Error("cfg_file_load cfgInstances verification must be an array.");
  }
  for (const item of cfgInstances ?? []) {
    if (item === null || item === undefined) continue;
    const domain = normalizeConfigDomain(
      requiredValue(item, "domain"),
      allowedDomains
    );
    if (domain !== operationDomain) {
      throw new Error(
        "cfg_file_load cfgInstances verification cannot reference another " +
          "configuration domain."
      );
    }
    assertSafeIdentifier(
      requiredValue(item, "type"),
      "verification configuration type"
    );
    assertSafeConfigInstanceKey(
      requiredValue(item, "instance"),
      "verification configuration instance"
    );
    verifyObjectFields(
      requiredValue(item, "fields"),
      "verification configuration"
    );
    checkCount += 1;
  }

  const configSignals = objectValue(verify, "configSignals");
  if (configSignals !== undefined && !Array.isArray(configSignals)) {
    throw new Error("cfg_file_load configSignals verification must be an array.");
  }
  if (configSignals !== undefined && operationDomain !== "eio") {
    throw new Error(
      "configSignals verification is valid only for the eio domain."
    );
  }
  for (const signal of configSignals ?? []) {
    if (signal === null || signal === undefined) continue;
    assertSafeConfigInstanceKey(
      requiredValue(signal, "name"),
      "configuration signal name"
    );
    const fields = objectValue(signal, "fields");
    if (fields !== undefined) {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error("configuration signal fields must be an object.");
      }
      for (const name of Object.keys(fields)) {
        assertSafeIdentifier(name, "configuration signal field");
      }
    }
    checkCount += 1;
  }

  const signals = objectValue(verify, "signals");
  if (signals !== undefined && !Array.isArray(signals)) {
    throw new Error("cfg_file_load signals verification must be an array.");
  }
  for (const signalName of signals ?? []) {
    if (signalName === null || signalName === undefined) continue;
    assertSafeConfigInstanceKey(signalName, "runtime signal name");
    checkCount += 1;
  }
  if (checkCount === 0) {
    throw new Error(
      "cfg_file_load verify must contain at least one cfgInstances, " +
        "configSignals, or signals check."
    );
  }
}

function pathWithin(candidate, root) {
  const relative =
    process.platform === "win32"
      ? path.relative(root.toLowerCase(), candidate.toLowerCase())
      : path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveAllowedLocalFile(
  value,
  extensions,
  allowedLocalRoots
) {
  const resolved = path.resolve(expandEnvironmentVariables(psString(value)));
  if (
    !Array.isArray(allowedLocalRoots) ||
    allowedLocalRoots.length === 0
  ) {
    throw new Error("allowedLocalRoots must be explicitly defined.");
  }
  const allowed = allowedLocalRoots.some((rootValue) => {
    const root = path.resolve(
      expandEnvironmentVariables(psString(rootValue))
    );
    return pathWithin(resolved, root);
  });
  if (!allowed) throw new Error(`Local file is outside allowed roots: ${resolved}`);
  let item;
  try {
    item = await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Local file not found: ${resolved}`);
    }
    throw error;
  }
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error(`Local file is not a regular file: ${resolved}`);
  }
  const canonicalFile = await realpath(resolved);
  let canonicalAllowed = false;
  for (const rootValue of allowedLocalRoots) {
    const root = path.resolve(
      expandEnvironmentVariables(psString(rootValue))
    );
    try {
      const canonicalRoot = await realpath(root);
      if (pathWithin(canonicalFile, canonicalRoot)) {
        canonicalAllowed = true;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!canonicalAllowed) {
    throw new Error(
      `Local file resolves outside allowed roots: ${resolved} -> ${canonicalFile}`
    );
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extensions.length > 0 && !extensions.includes(extension)) {
    throw new Error(`Unsupported file extension for ${resolved}`);
  }
  return {
    Path: resolved,
    Size: Number(item.size)
  };
}

function normalizeMetrics(metrics = {}) {
  const output = {};
  for (const name of METRIC_NAMES) {
    const raw = objectValue(metrics, name, name[0].toLowerCase() + name.slice(1));
    output[name] =
      raw === undefined ? 0 : checkedNonNegativeInteger(raw, `Metric ${name}`);
  }
  return output;
}

function metricDelta(before, after, name) {
  return after[name] - before[name];
}

function publicPreparedOperation(operation) {
  const output = {};
  for (const [name, value] of Object.entries(operation)) {
    if (name === "ArtifactBytes" || name === "ParsedEntries") continue;
    output[name] = value;
  }
  return cloneJson(output);
}

function assertNoOperationConflicts(operations) {
  const targets = new Set();
  const cfgFileTypes = new Set();
  const cfgInstanceModes = new Map();

  for (const operation of operations.filter(
    (item) => item.Kind === "cfg_file_load"
  )) {
    const types = new Map();
    for (const entry of operation.ParsedEntries) {
      const folded = psString(entry.Type).toLowerCase();
      if (!types.has(folded)) types.set(folded, psString(entry.Type));
    }
    for (const type of types.values()) {
      const key = `${operation.Domain}|${type}`.toLowerCase();
      if (cfgFileTypes.has(key)) {
        throw new Error(
          `Multiple CFG files touch the same configuration type: ${key}`
        );
      }
      cfgFileTypes.add(key);
    }
  }

  for (const operation of operations) {
    if (["cfg_set", "cfg_upsert"].includes(operation.Kind)) {
      const base =
        `${operation.Domain}|${operation.Type}|${operation.Instance}`.toLowerCase();
      if (
        cfgInstanceModes.has(base) &&
        (
          operation.Kind === "cfg_upsert" ||
          cfgInstanceModes.get(base) === "cfg_upsert"
        )
      ) {
        throw new Error(
          `cfg_upsert cannot be combined with another operation on the same ` +
            `instance: ${base}`
        );
      }
      cfgInstanceModes.set(base, operation.Kind);
      if (cfgFileTypes.has(`${operation.Domain}|${operation.Type}`.toLowerCase())) {
        throw new Error(
          `cfg_set conflicts with cfg_file_load for ` +
            `${operation.Domain}/${operation.Type}`
        );
      }
      if (targets.has(`cfg-delete|${base}`)) {
        throw new Error(`cfg_set conflicts with cfg_delete for ${base}`);
      }
      for (const name of Object.keys(operation.Desired)) {
        const key = `cfg-field|${base}|${name}`.toLowerCase();
        if (targets.has(key)) throw new Error(`Duplicate cfg_set target: ${key}`);
        targets.add(key);
      }
      continue;
    }

    if (operation.Kind === "cfg_delete") {
      const base =
        `${operation.Domain}|${operation.Type}|${operation.InstanceKey}`.toLowerCase();
      if (cfgFileTypes.has(`${operation.Domain}|${operation.Type}`.toLowerCase())) {
        throw new Error(
          `cfg_delete conflicts with cfg_file_load for ` +
            `${operation.Domain}/${operation.Type}; use a separate exact cleanup changeset.`
        );
      }
      if (
        [...targets].some((target) =>
          target.startsWith(`cfg-field|${base}|`)
        )
      ) {
        throw new Error(`cfg_delete conflicts with cfg_set for ${base}`);
      }
      const key = `cfg-delete|${base}`;
      if (targets.has(key)) {
        throw new Error(`Duplicate cfg_delete target: ${base}`);
      }
      targets.add(key);
      continue;
    }

    if (operation.Kind === "rapid_set_init") {
      const moduleKey = `${operation.Task}|${operation.Module}`.toLowerCase();
      if (targets.has(`rapid-module|${moduleKey}`)) {
        throw new Error(
          `rapid_set_init conflicts with a module put/delete for ${moduleKey}`
        );
      }
      const key =
        `rapid-data|${moduleKey}|${operation.Name}`.toLowerCase();
      if (targets.has(key)) {
        throw new Error(`Duplicate RAPID data target: ${key}`);
      }
      targets.add(key);
      continue;
    }

    if (["rapid_module_put", "rapid_module_delete"].includes(operation.Kind)) {
      const moduleKey = `${operation.Task}|${operation.Module}`.toLowerCase();
      const key = `rapid-module|${moduleKey}`;
      if (
        targets.has(key) ||
        [...targets].some((target) =>
          target.startsWith(`rapid-data|${moduleKey}|`)
        )
      ) {
        throw new Error(
          `Conflicting RAPID module operations for ${moduleKey}`
        );
      }
      targets.add(key);
    }
  }
}

class PlanReadContext {
  constructor(planner, controller, identity) {
    this.planner = planner;
    this.controller = controller;
    this.identity = identity;
    this.configLists = new Map();
    this.configIndexes = new Map();
    this.configDirect = new Map();
    this.rapidModules = new Map();
    this.rapidTexts = new Map();
    this.rapidData = new Map();
    this.files = new Map();
    this.pendingReads = new Map();
  }

  async once(key, read) {
    if (this.pendingReads.has(key)) return await this.pendingReads.get(key);
    const pending = Promise.resolve().then(read);
    this.pendingReads.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pendingReads.delete(key);
    }
  }

  async call(names, args) {
    for (const name of names) {
      const method = this.planner.readApi?.[name];
      if (typeof method === "function") {
        return await method.call(this.planner.readApi, args);
      }
    }
    throw new Error(`Injected read API is missing method: ${names[0]}`);
  }

  async getConfigInstances(domain, type) {
    return await this.once(`config-list|${domain}|${type}`.toLowerCase(),
      () => this.loadConfigInstances(domain, type));
  }

  async loadConfigInstances(domain, type) {
    const cacheKey = `${domain}|${type}`.toLowerCase();
    if (!this.configLists.has(cacheKey)) {
      const raw = await this.call(
        ["getConfigInstances", "listConfigInstances"],
        { controller: this.controller, domain, type }
      );
      if (!Array.isArray(raw)) {
        throw new Error(`Configuration inventory is not an array: ${domain}/${type}`);
      }
      this.configLists.set(
        cacheKey,
        raw.map((instance) =>
          normalizeConfigInstance(instance, { domain, type })
        )
      );
    }
    return this.configLists.get(cacheKey);
  }

  async getConfigInstance(domain, type, instance, { allowMissing = false } = {}) {
    return await this.once(`config|${domain}|${type}|${instance}|${allowMissing}`.toLowerCase(),
      () => this.loadConfigInstance(domain, type, instance, { allowMissing }));
  }

  async loadConfigInstance(domain, type, instance, { allowMissing }) {
    if (allowMissing) {
      const listed = await this.getConfigInstances(domain, type);
      const listKey = `${domain}|${type}`.toLowerCase();
      if (!this.configIndexes.has(listKey)) {
        const index = new Map();
        for (const item of listed) {
          for (const value of [item.Key, item.InstanceId]) {
            if (value && !index.has(value.toLowerCase())) index.set(value.toLowerCase(), item);
          }
        }
        this.configIndexes.set(listKey, index);
      }
      return this.configIndexes.get(listKey).get(psString(instance).toLowerCase()) ?? null;
    }
    const cacheKey = `${domain}|${type}|${instance}`.toLowerCase();
    if (!this.configDirect.has(cacheKey)) {
      const raw = await this.call(
        ["getConfigInstance"],
        {
          controller: this.controller,
          domain,
          type,
          instance,
          allowMissing: false
        }
      );
      if (raw === null || raw === undefined) {
        throw new Error(
          `Configuration instance not found: ${domain}/${type}/${instance}`
        );
      }
      this.configDirect.set(
        cacheKey,
        normalizeConfigInstance(raw, {
          domain,
          type,
          instanceKey: instance
        })
      );
    }
    return this.configDirect.get(cacheKey);
  }

  async getRapidModules(task) {
    return await this.once(`modules|${task}`.toLowerCase(),
      () => this.loadRapidModules(task));
  }

  async loadRapidModules(task) {
    const cacheKey = task.toLowerCase();
    if (!this.rapidModules.has(cacheKey)) {
      const raw = await this.call(
        ["getRapidModules", "listRapidModules"],
        { controller: this.controller, task }
      );
      if (!Array.isArray(raw)) {
        throw new Error(`RAPID module inventory is not an array: ${task}`);
      }
      this.rapidModules.set(
        cacheKey,
        raw.map((module) => ({
          Name: psString(objectValue(module, "Name", "name")),
          Type: psString(objectValue(module, "Type", "type")),
          Task: task
        }))
      );
    }
    return this.rapidModules.get(cacheKey);
  }

  async getRapidModuleText(task, module, { allowMissing = false } = {}) {
    return await this.once(`module|${task}|${module}|${allowMissing}`.toLowerCase(),
      () => this.loadRapidModuleText(task, module, { allowMissing }));
  }

  async loadRapidModuleText(task, module, { allowMissing }) {
    const cacheKey = `${task}|${module}`.toLowerCase();
    if (this.rapidTexts.has(cacheKey)) return this.rapidTexts.get(cacheKey);
    if (allowMissing) {
      const modules = await this.getRapidModules(task);
      if (!modules.some((item) => equalIgnoreCase(item.Name, module))) {
        this.rapidTexts.set(cacheKey, null);
        return null;
      }
    }
    const text = await this.call(
      ["getRapidModuleText"],
      { controller: this.controller, task, module, allowMissing: false }
    );
    if (text === null || text === undefined) {
      throw new Error(`No module text returned for ${task}/${module}`);
    }
    const normalized = psString(text);
    this.rapidTexts.set(cacheKey, normalized);
    return normalized;
  }

  async getRapidDataValue(task, module, name) {
    return await this.once(`data|${task}|${module}|${name}`.toLowerCase(),
      () => this.loadRapidDataValue(task, module, name));
  }

  async loadRapidDataValue(task, module, name) {
    const cacheKey = `${task}|${module}|${name}`.toLowerCase();
    if (!this.rapidData.has(cacheKey)) {
      const value = await this.call(
        ["getRapidDataValue"],
        { controller: this.controller, task, module, name }
      );
      this.rapidData.set(cacheKey, psString(value));
    }
    return this.rapidData.get(cacheKey);
  }

  async captureFile(localPath, extensions) {
    const file = await resolveAllowedLocalFile(
      localPath,
      extensions,
      this.planner.allowedLocalRoots
    );
    const resolved = file.Path;
    if (
      !Number.isSafeInteger(file.Size) ||
      file.Size < 0 ||
      file.Size > MAX_ARTIFACT_BYTES
    ) {
      throw new Error(
        `Local artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte planning limit: ` +
          `${resolved}`
      );
    }
    const cacheKey =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const artifact = await this.once(`artifact|${cacheKey}`, async () => {
      if (!this.files.has(cacheKey)) {
        const raw = await this.planner.readFileBytes(resolved);
        if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
          throw new Error(`File byte reader returned non-binary data: ${resolved}`);
        }
        if (raw.byteLength > MAX_ARTIFACT_BYTES) {
          throw new Error(
            `Local artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte planning limit: ` +
              `${resolved}`
          );
        }
        this.files.set(cacheKey, Buffer.from(raw));
      }
      return this.files.get(cacheKey);
    });
    return {
      LocalPath: resolved,
      ArtifactBytes: Buffer.from(artifact)
    };
  }
}

async function prepareOperation(planner, context, operation) {
  let kind = psString(requiredValue(operation, "kind")).trim().toLowerCase();
  if (kind === "rapid_module_replace") kind = "rapid_module_put";

  if (kind === "cfg_set" || kind === "cfg_upsert") {
    const domain = normalizeConfigDomain(
      requiredValue(operation, "domain"),
      planner.allowedConfigDomains
    );
    const type = assertSafeIdentifier(
      requiredValue(operation, "type"),
      "configuration type"
    );
    const instance = assertSafeConfigInstanceKey(
      requiredValue(operation, "instance"),
      "configuration instance"
    );
    const fieldEntries = verifyObjectFields(
      requiredValue(operation, "fields"),
      kind
    );
    const current = await context.getConfigInstance(domain, type, instance, {
      allowMissing: kind === "cfg_upsert"
    });
    if (current?.ReadOnly) {
      throw new Error(
        `Configuration instance is read-only: ${domain}/${type}/${instance}`
      );
    }
    const before = {};
    const desired = {};
    let needsChange = current === null;
    for (const [name, rawValue] of fieldEntries) {
      if (current) {
        before[name] = psString(
          attributeValue(current.Attributes, name, { required: true })
        );
      }
      desired[name] = psString(rawValue);
      if (current && !equalExact(before[name], desired[name])) {
        needsChange = true;
      }
    }
    const prepared = {
      Kind: kind,
      Domain: domain,
      Type: type,
      Instance: instance
    };
    if (kind === "cfg_upsert") prepared.BeforeExists = current !== null;
    prepared.Before = before;
    prepared.Desired = desired;
    prepared.NeedsChange = needsChange;
    return prepared;
  }

  if (kind === "cfg_delete") {
    const domain = normalizeConfigDomain(
      requiredValue(operation, "domain"),
      planner.allowedConfigDomains
    );
    const type = assertSafeIdentifier(
      requiredValue(operation, "type"),
      "configuration type"
    );
    const instanceKey = assertSafeConfigInstanceKey(
      requiredValue(operation, "instanceKey"),
      "configuration instance key"
    );
    if (requiredValue(operation, "ifPresent") !== true) {
      throw new Error(
        "cfg_delete requires ifPresent=true so reruns remain safe."
      );
    }
    const current = await context.getConfigInstance(
      domain,
      type,
      instanceKey,
      { allowMissing: true }
    );
    if (current?.ReadOnly) {
      throw new Error(
        `Configuration instance is read-only: ${domain}/${type}/${instanceKey}`
      );
    }
    return {
      Kind: kind,
      Domain: domain,
      Type: type,
      InstanceKey: instanceKey,
      DeleteKey: current ? current.DeleteKey : instanceKey,
      BeforeExists: current !== null,
      BeforeAttributesSha256: current
        ? configAttributesSha256(current.Attributes)
        : null,
      Before: current ? cloneJson(current.Attributes) : null,
      NeedsChange: current !== null
    };
  }

  if (kind === "rapid_set_init") {
    const task = assertSafeIdentifier(
      requiredValue(operation, "task"),
      "RAPID task"
    );
    const module = assertSafeIdentifier(
      requiredValue(operation, "module"),
      "RAPID module"
    );
    const name = assertSafeIdentifier(
      requiredValue(operation, "name"),
      "RAPID data name"
    );
    const desired = psString(requiredValue(operation, "value"));
    const before = await context.getRapidDataValue(task, module, name);
    return {
      Kind: kind,
      Task: task,
      Module: module,
      Name: name,
      Before: before,
      Desired: desired,
      NeedsChange: !equalExact(before, desired)
    };
  }

  if (kind === "rapid_module_put") {
    const task = assertSafeIdentifier(
      requiredValue(operation, "task"),
      "RAPID task"
    );
    const module = assertSafeIdentifier(
      requiredValue(operation, "module"),
      "RAPID module"
    );
    const captured = await context.captureFile(
      requiredValue(operation, "localPath"),
      context.identity.RobotWare.startsWith("6.")
        ? [".mod", ".sys"] : [".mod", ".sys", ".modx", ".sysx"]
    );
    const source = decodeCapturedText(captured.ArtifactBytes);
    if (!context.identity.RobotWare.startsWith("6.") &&
        /[^\x00-\x7f]/.test(source) &&
        ![".modx", ".sysx"].includes(path.extname(captured.LocalPath).toLowerCase())) {
      throw new Error(`RW7 UTF-8 RAPID source requires .modx or .sysx: ${captured.LocalPath}`);
    }
    if (
      context.identity.RobotWare.startsWith("6.") &&
      /[^\x00-\x7f]/.test(source)
    ) {
      throw new Error(
        `RW6 RAPID source must be ASCII: ${captured.LocalPath}`
      );
    }
    const escapedModule = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(
      `^\\s*MODULE\\s+${escapedModule}(?:\\s*\\(|\\s*$)`,
      "mi"
    );
    if (!declaration.test(source)) {
      throw new Error(`RAPID source does not declare MODULE ${module}`);
    }
    const online = await context.getRapidModuleText(task, module, {
      allowMissing: true
    });
    const beforeHash = online === null ? null : sha256Text(online);
    const sourceHash = sha256Text(source);
    return {
      Kind: kind,
      Task: task,
      Module: module,
      LocalPath: captured.LocalPath,
      FileSha256: sha256Bytes(captured.ArtifactBytes),
      SourceSha256: sourceHash,
      ArtifactBytes: captured.ArtifactBytes,
      BeforeSourceSha256: beforeHash,
      BeforeExists: online !== null,
      SourceDiff: sourceDifference(online, source),
      NeedsChange: beforeHash !== sourceHash
    };
  }

  if (kind === "rapid_module_delete") {
    const task = assertSafeIdentifier(
      requiredValue(operation, "task"),
      "RAPID task"
    );
    const module = assertSafeIdentifier(
      requiredValue(operation, "module"),
      "RAPID module"
    );
    if (requiredValue(operation, "ifPresent") !== true) {
      throw new Error(
        "rapid_module_delete requires ifPresent=true so reruns remain safe."
      );
    }
    const modules = await context.getRapidModules(task);
    const moduleInfo =
      modules.find((item) => equalIgnoreCase(item.Name, module)) ?? null;
    const allowSystemModule = psBoolean(
      objectValue(operation, "allowSystemModule")
    );
    if (
      moduleInfo &&
      /sys/i.test(moduleInfo.Type) &&
      !allowSystemModule
    ) {
      throw new Error(
        `Refusing to delete RAPID system module ${task}/${module} ` +
          "without allowSystemModule=true."
      );
    }
    const online = moduleInfo
      ? await context.getRapidModuleText(task, module)
      : null;
    return {
      Kind: kind,
      Task: task,
      Module: module,
      ModuleType: moduleInfo ? moduleInfo.Type : null,
      AllowSystemModule: allowSystemModule,
      BeforeExists: online !== null,
      BeforeSourceSha256: online === null ? null : sha256Text(online),
      NeedsChange: online !== null
    };
  }

  if (kind === "cfg_file_load") {
    const domain = normalizeConfigDomain(
      requiredValue(operation, "domain"),
      planner.allowedConfigDomains
    );
    const actionType = psString(
      requiredValue(operation, "actionType")
    );
    if (actionType === "add-with-reset") {
      throw new Error(
        "Direct RWS preview rejects cfg_file_load actionType='add-with-reset'; " +
          "implement and approve a complete explicit deletion diff before " +
          "reset semantics can be enabled."
      );
    }
    if (actionType !== "add") {
      throw new Error(
        "Direct RWS preview permits only cfg_file_load actionType='add'; " +
          "full-domain replace is blocked."
      );
    }
    const captured = await context.captureFile(
      requiredValue(operation, "localPath"),
      [".cfg"]
    );
    const cfgText = decodeCapturedText(captured.ArtifactBytes);
    const fileDomain = getCfgTextDomain(
      cfgText,
      planner.allowedConfigDomains
    );
    if (fileDomain !== domain) {
      throw new Error(
        `CFG header domain '${fileDomain}' does not match operation ` +
          `domain '${domain}'.`
      );
    }
    const parsedEntries = parseCfgText(
      cfgText,
      planner.allowedConfigDomains
    );
    const verify = objectValue(operation, "verify");
    assertCfgVerificationSpec(
      verify,
      domain,
      planner.allowedConfigDomains
    );
    const typeSnapshots = {};
    const missingOrChanged = [];
    const types = new Map();
    for (const entry of parsedEntries) {
      const folded = entry.Type.toLowerCase();
      if (!types.has(folded)) types.set(folded, entry.Type);
    }
    for (const type of [...types.values()].sort(comparePowerShellLike)) {
      const instances = await context.getConfigInstances(domain, type);
      typeSnapshots[type] = configInventorySha256(instances);
      for (const entry of parsedEntries.filter((item) =>
        equalIgnoreCase(item.Type, type)
      )) {
        if (!cfgEntryPresent(entry, instances)) {
          missingOrChanged.push(entry);
        }
      }
    }
    return {
      Kind: kind,
      Domain: domain,
      ActionType: actionType,
      LocalPath: captured.LocalPath,
      FileSha256: sha256Bytes(captured.ArtifactBytes),
      ArtifactBytes: captured.ArtifactBytes,
      ParsedEntries: parsedEntries,
      DesiredEntryCount: parsedEntries.length,
      MissingOrChangedEntryCount: missingOrChanged.length,
      MissingOrChangedEntries: missingOrChanged,
      BeforeTypeInventorySha256: typeSnapshots,
      Verify: cloneJson(verify),
      NeedsChange: missingOrChanged.length > 0
    };
  }

  throw new Error(`Unsupported operation kind: ${kind}`);
}

function validateBaseChangeset(changeset) {
  if (!changeset || typeof changeset !== "object" || Array.isArray(changeset)) {
    throw new Error("ABB changeset must be an object.");
  }
  if (requiredValue(changeset, "version") !== 1) {
    throw new Error("Unsupported ABB changeset version.");
  }
  const controller = psString(requiredValue(changeset, "controller"));
  if (
    controller !== controller.trim() ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(controller) ||
    ["__proto__", "prototype", "constructor"].includes(controller.toLowerCase())
  ) {
    throw new Error("ABB changeset controller must be a safe registered alias.");
  }
  const operations = requiredValue(changeset, "operations");
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("ABB job operations cannot be empty.");
  }
  if (operations.length > MAX_OPERATIONS) {
    throw new Error(
      "ABB job operations cannot exceed 250; split the work into separately " +
        "approved batches."
    );
  }
  return { controller, operations };
}

function validateRestart(changeset, operations) {
  const restart = objectValue(changeset, "restart");
  if (restart !== undefined && restart !== null) {
    const required = requiredValue(restart, "required");
    if (typeof required !== "boolean") {
      throw new Error("restart.required must be a boolean.");
    }
    if (!equalIgnoreCase(requiredValue(restart, "mode"), "restart")) {
      throw new Error("Only ordinary restart mode is supported.");
    }
    const timeoutSeconds = Number(requiredValue(restart, "timeoutSeconds"));
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 30 ||
      timeoutSeconds > 600
    ) {
      throw new Error("restart.timeoutSeconds must be between 30 and 600.");
    }
  }
  const changedConfiguration = operations.filter(
    (operation) =>
      operation.NeedsChange &&
      CONFIG_OPERATION_KINDS.has(operation.Kind)
  ).length;
  if (
    changedConfiguration > 0 &&
    (
      restart === undefined ||
      restart === null ||
      requiredValue(restart, "required") !== true
    )
  ) {
    throw new Error(
      "Configuration changes require one explicit ordinary restart in the " +
        "same changeset."
    );
  }
  return restart ?? null;
}

export class DirectChangesetPlanner {
  constructor({
    readApi,
    allowedConfigDomains,
    allowedLocalRoots,
    readConcurrency = 4,
    readFileBytes = async (filePath) => await readFile(filePath),
    now = () => Date.now(),
    tokenFactory = () => crypto.randomBytes(16).toString("hex")
  } = {}) {
    if (!readApi || typeof readApi !== "object") {
      throw new Error("An injected ABB read API is required.");
    }
    if (typeof readFileBytes !== "function") {
      throw new Error("readFileBytes must be a function.");
    }
    if (typeof now !== "function") throw new Error("now must be a function.");
    if (typeof tokenFactory !== "function") {
      throw new Error("tokenFactory must be a function.");
    }
    this.readApi = readApi;
    if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > 16) {
      throw new Error("readConcurrency must be an integer from 1 to 16.");
    }
    this.readConcurrency = readConcurrency;
    this.allowedConfigDomains = normalizeAllowedDomains(
      allowedConfigDomains
    );
    this.allowedLocalRoots = [...(allowedLocalRoots ?? [])];
    this.readFileBytes = readFileBytes;
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.prepared = new Map();
    this.usedTokens = new Map();
  }

  nowMs() {
    const value = this.now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error("now() returned an invalid time.");
    }
    return milliseconds;
  }

  async metrics(controller) {
    const method =
      this.readApi.getMetrics ??
      this.readApi.metrics;
    if (typeof method !== "function") return normalizeMetrics();
    return normalizeMetrics(
      await method.call(this.readApi, { controller })
    );
  }

  async callRead(names, args) {
    for (const name of names) {
      const method = this.readApi[name];
      if (typeof method === "function") {
        return await method.call(this.readApi, args);
      }
    }
    throw new Error(`Injected read API is missing method: ${names[0]}`);
  }

  pruneExpired(nowMs = this.nowMs()) {
    for (const [token, prepared] of this.prepared) {
      if (!prepared.Used && nowMs > prepared.ExpiresAt.getTime()) {
        this.prepared.delete(token);
      }
    }
    for (const [token, expiresAt] of this.usedTokens) {
      if (nowMs > expiresAt) this.usedTokens.delete(token);
    }
  }

  createToken() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = psString(this.tokenFactory()).toLowerCase();
      if (!TOKEN_PATTERN.test(token)) {
        throw new Error("tokenFactory must return 32 lowercase hexadecimal characters.");
      }
      if (!this.prepared.has(token) && !this.usedTokens.has(token)) return token;
    }
    throw new Error("Unable to allocate a unique ABB changeset plan token.");
  }

  async capture(changeset) {
    const started = performance.now();
    let manifestJson;
    try {
      manifestJson = JSON.stringify(changeset);
    } catch (error) {
      throw new Error(`ABB changeset is not JSON serializable: ${error.message}`);
    }
    if (!manifestJson) throw new Error("ABB changeset must be an object.");
    const manifest = JSON.parse(manifestJson);
    const { controller, operations } = validateBaseChangeset(manifest);
    const metricsBefore = await this.metrics(controller);
    const identity = normalizeIdentity(
      await this.callRead(["getIdentity", "identity"], { controller })
    );
    assertExpectedIdentity(manifest, identity);
    const state = normalizeControllerState(
      await this.callRead(
        ["getControllerState", "controllerState"],
        { controller }
      )
    );
    const readiness = evaluateSafety(manifest, state);

    const context = new PlanReadContext(this, controller, identity);
    const preparedOperations = await mapWithConcurrency(
      operations, this.readConcurrency,
      (operation) => prepareOperation(this, context, operation)
    );
    const totalArtifactBytes = preparedOperations.reduce(
      (total, operation) =>
        total + (operation.ArtifactBytes?.byteLength ?? 0),
      0
    );
    if (totalArtifactBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new Error(
        `Prepared artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES}-byte ` +
          "changeset planning limit."
      );
    }
    assertNoOperationConflicts(preparedOperations);
    const restart = validateRestart(manifest, preparedOperations);
    const metricsAfter = await this.metrics(controller);

    const nowMs = this.nowMs();
    this.pruneExpired(nowMs);
    const createdAt = new Date(nowMs);
    const expiresAt = new Date(nowMs + TOKEN_LIFETIME_MS);
    const manifestHash = sha256Text(manifestJson);
    const prepared = {
      ManifestPath: null,
      ManifestHash: manifestHash,
      ManifestJson: manifestJson,
      Manifest: manifest,
      Alias: controller,
      Identity: cloneJson(identity),
      State: cloneJson(state),
      Operations: preparedOperations,
      MetricsAtStart: metricsBefore,
      CreatedAt: createdAt,
      ExpiresAt: expiresAt,
      Used: false
    };
    const result = {
      Prepared: false,
      ...readiness,
      Controller: controller,
      Identity: cloneJson(identity),
      State: cloneJson(state),
      ManifestSha256: manifestHash,
      OperationCount: preparedOperations.length,
      ChangesRequired: preparedOperations.filter(
        (operation) => operation.NeedsChange
      ).length,
      Operations: preparedOperations.map(publicPreparedOperation),
      RestartRequired: restart === null ? false : restart.required === true,
      ControllerModified: false,
      Metrics: metricsAfter,
      RequestDelta: metricDelta(
        metricsBefore,
        metricsAfter,
        "RequestCount"
      ),
      SessionCreateDelta: metricDelta(
        metricsBefore,
        metricsAfter,
        "SessionCreateCount"
      ),
      ReconnectDelta: metricDelta(
        metricsBefore,
        metricsAfter,
        "ReconnectCount"
      ),
      TimeoutDelta: metricDelta(
        metricsBefore,
        metricsAfter,
        "TimeoutCount"
      ),
      ElapsedMs: Math.max(0, Math.floor(performance.now() - started))
    };
    return { prepared, result };
  }

  async prepare(changeset) {
    const { prepared, result } = await this.capture(changeset);
    if (result.SafetyBlocked) {
      return {
        ...result, Preview: true,
        NextAction: "Resolve WriteBlockers locally, then replan and approve the new exact plan before applying. No write token was issued."
      };
    }
    const token = this.createToken();
    prepared.Token = token;
    this.prepared.set(token, prepared);
    return {
      ...result, Prepared: true, Token: token,
      ExpiresAt: prepared.ExpiresAt.toISOString()
    };
  }

  consume(token) {
    const key = psString(token).toLowerCase();
    const usedUntil = this.usedTokens.get(key);
    if (usedUntil !== undefined) {
      if (this.nowMs() <= usedUntil) {
        throw new Error("Prepared token has already been used.");
      }
      this.usedTokens.delete(key);
    }
    const prepared = this.prepared.get(key);
    if (!prepared) throw new Error("Unknown prepared token.");
    if (prepared.Used) throw new Error("Prepared token has already been used.");
    if (this.nowMs() > prepared.ExpiresAt.getTime()) {
      this.prepared.delete(key);
      throw new Error("Prepared token has expired.");
    }
    if (sha256Text(prepared.ManifestJson) !== prepared.ManifestHash) {
      this.prepared.delete(key);
      throw new Error("Prepared changeset changed after planning.");
    }
    for (const operation of prepared.Operations) {
      if (
        operation.ArtifactBytes &&
        sha256Bytes(operation.ArtifactBytes) !== operation.FileSha256
      ) {
        this.prepared.delete(key);
        throw new Error("Prepared file bytes changed after planning.");
      }
    }
    prepared.Used = true;
    return prepared;
  }

  peek(token) {
    const key = psString(token).toLowerCase();
    const usedUntil = this.usedTokens.get(key);
    if (usedUntil !== undefined && this.nowMs() <= usedUntil) {
      throw new Error("Prepared token has already been used.");
    }
    const prepared = this.prepared.get(key);
    if (!prepared) throw new Error("Unknown prepared token.");
    if (prepared.Used) throw new Error("Prepared token has already been used.");
    if (this.nowMs() > prepared.ExpiresAt.getTime()) {
      this.prepared.delete(key);
      throw new Error("Prepared token has expired.");
    }
    return {
      Alias: prepared.Alias,
      Identity: cloneJson(prepared.Identity),
      ExpiresAt: prepared.ExpiresAt.toISOString()
    };
  }

  discard(token) {
    const key = psString(token).toLowerCase();
    const prepared = this.prepared.get(key);
    if (!prepared) return false;
    if (!prepared.Used) {
      throw new Error("Cannot discard an unused prepared token.");
    }
    this.prepared.delete(key);
    this.usedTokens.set(key, prepared.ExpiresAt.getTime());
    return true;
  }

  close() {
    this.prepared.clear();
    this.usedTokens.clear();
  }
}

const ChangesetPlanner = DirectChangesetPlanner;

export {
  BUILT_IN_CONFIG_DOMAINS,
  ChangesetPlanner,
  CONFIG_OPERATION_KINDS,
  MAX_ARTIFACT_BYTES,
  MAX_OPERATIONS,
  MAX_TOTAL_ARTIFACT_BYTES,
  TOKEN_LIFETIME_MS,
  assertNoOperationConflicts,
  configAttributesSha256,
  configInventorySha256,
  decodeCapturedText,
  getCfgTextDomain,
  parseCfgText,
  publicPreparedOperation,
  sha256Bytes,
  sha256Text
};
