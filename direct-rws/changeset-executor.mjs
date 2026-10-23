import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  configAttributesSha256,
  configInventorySha256,
  sha256Text
} from "./changeset-planner.mjs";
import {
  Rws1WriteAdapter,
  Rws1WriteResponseError
} from "./rws1-write-adapter.mjs";
import { Rws2WriteAdapter } from "./rws2-write-adapter.mjs";

const RAPID_MODULE_KINDS = new Set([
  "rapid_module_put",
  "rapid_module_delete"
]);
const WRITE_OPERATION_KINDS = new Set([
  "cfg_set",
  "cfg_upsert",
  "cfg_delete",
  "cfg_file_load",
  "rapid_set_init",
  "rapid_module_put",
  "rapid_module_delete"
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(value, name) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, name)
  );
}

function objectValue(value, ...names) {
  for (const name of names) {
    if (hasOwn(value, name)) return value[name];
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (names.some((name) => key.toLowerCase() === String(name).toLowerCase())) {
      return item;
    }
  }
  return undefined;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function equalIgnoreCase(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

function equalExact(left, right) {
  return text(left) === text(right);
}

function parseNumericRobtarget(value) {
  const source = text(value);
  const tokens = [];
  let offset = 0;

  function skipWhitespace() {
    while (offset < source.length && /\s/.test(source[offset])) offset += 1;
  }

  function consume(expected) {
    skipWhitespace();
    if (source[offset] !== expected) return false;
    offset += 1;
    return true;
  }

  function number() {
    skipWhitespace();
    const start = offset;
    const match =
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(
        source.slice(offset)
      );
    if (!match) return false;
    const numeric = Number(match[0]);
    if (!Number.isFinite(numeric)) return false;
    offset += match[0].length;
    tokens.push({
      Start: start,
      End: offset,
      Raw: match[0],
      Numeric: numeric
    });
    return true;
  }

  if (!consume("[")) return null;
  for (const [groupIndex, count] of [3, 4, 4, 6].entries()) {
    if (!consume("[")) return null;
    for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
      if (!number()) return null;
      if (itemIndex < count - 1 && !consume(",")) return null;
    }
    if (!consume("]")) return null;
    if (groupIndex < 3 && !consume(",")) return null;
  }
  if (!consume("]")) return null;
  skipWhitespace();
  if (offset !== source.length || tokens.length !== 17) return null;
  return { Source: source, Tokens: tokens };
}

function extaxSentinelClass(value) {
  if (value >= 8.9e9) return "positive";
  if (value <= -8.9e9) return "negative";
  return null;
}

function canonicalizeRobtargetExtaxSentinels(parsed) {
  let result = "";
  let offset = 0;
  for (const [index, token] of parsed.Tokens.entries()) {
    result += parsed.Source.slice(offset, token.Start);
    const sentinelClass = index >= 11
      ? extaxSentinelClass(token.Numeric)
      : null;
    result += sentinelClass
      ? `<ABB_INVALID_EXTAX:${sentinelClass}>`
      : token.Raw;
    offset = token.End;
  }
  return result + parsed.Source.slice(offset);
}

function equalRapidSetInitReadback(actual, expected) {
  if (equalExact(actual, expected)) return true;
  const parsedActual = parseNumericRobtarget(actual);
  const parsedExpected = parseNumericRobtarget(expected);
  if (!parsedActual || !parsedExpected) return false;
  return (
    canonicalizeRobtargetExtaxSentinels(parsedActual) ===
    canonicalizeRobtargetExtaxSentinels(parsedExpected)
  );
}

function normalizeSystemId(value) {
  return text(value)
    .trim()
    .replace(/^[{]+|[}]+$/g, "")
    .toLowerCase();
}

function normalizeEndpoint(value) {
  const raw = text(value).trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid controller Endpoint: ${raw}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Unsafe controller Endpoint: ${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

function normalizeIdentity(identity) {
  const normalized = {
    Name: text(objectValue(identity, "Name", "name")),
    SystemId: normalizeSystemId(
      objectValue(identity, "SystemId", "systemId", "sysid")
    ),
    RobotWare: text(
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
  if (endpoint !== undefined && endpoint !== null && text(endpoint).trim()) {
    normalized.Endpoint = text(endpoint).trim();
  }
  if (
    controllerLock !== undefined &&
    controllerLock !== null &&
    text(controllerLock).trim()
  ) {
    normalized.ControllerLock = text(controllerLock).trim();
  }
  if (!normalized.Name || !normalized.SystemId || !normalized.RobotWare) {
    throw new Error(
      "Controller identity read is missing Name, SystemId, or RobotWare."
    );
  }
  return normalized;
}

function normalizeState(state) {
  const normalized = {
    Opmode: text(objectValue(state, "Opmode", "opmode")),
    ControllerState: text(
      objectValue(state, "ControllerState", "controllerState", "ctrlstate")
    ),
    RapidState: text(
      objectValue(state, "RapidState", "rapidState", "ctrlexecstate")
    )
  };
  if (
    !normalized.Opmode ||
    !normalized.ControllerState ||
    !normalized.RapidState
  ) {
    throw new Error(
      "Controller state read is missing Opmode, ControllerState, or RapidState."
    );
  }
  return normalized;
}

function assertIdentity(prepared, identity) {
  const expected = prepared.Manifest?.expectedController;
  if (!expected) throw new Error("Prepared changeset has no expected controller.");
  const expectedName = text(objectValue(expected, "name"));
  const expectedSystemId = normalizeSystemId(objectValue(expected, "systemId"));
  const expectedRobotWare = text(objectValue(expected, "robotWare"));
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
      `ROBOTWARE MISMATCH: actual=${identity.RobotWare}, ` +
        `expected=${expectedRobotWare}`
    );
  }
  const plannedEndpoint = normalizeEndpoint(prepared.Identity?.Endpoint);
  const plannedLock = text(prepared.Identity?.ControllerLock).trim();
  if (!plannedEndpoint || !plannedLock) {
    throw new Error(
      "Prepared controller identity must contain both Endpoint and ControllerLock; " +
        "create a new identity-locked plan."
    );
  }
  if (normalizeEndpoint(identity.Endpoint) !== plannedEndpoint) {
    throw new Error(
      `CONTROLLER ENDPOINT MISMATCH: actual=${identity.Endpoint || "<missing>"}, ` +
        `expected=${plannedEndpoint}`
    );
  }
  if (identity.ControllerLock !== plannedLock) {
    throw new Error(
      `CONTROLLER LOCK MISMATCH: actual=${identity.ControllerLock || "<missing>"}, ` +
        `expected=${plannedLock}`
    );
  }
}

function assertSafeState(prepared, state) {
  const safety = prepared.Manifest?.safety;
  if (safety?.requireRapidStopped !== true) {
    throw new Error("All ABB jobs must require RAPID stopped.");
  }
  const allowed = safety.allowedControllerStates;
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    allowed.some(
      (value) => !["guardstop", "motoroff"].includes(text(value).toLowerCase())
    )
  ) {
    throw new Error(
      "allowedControllerStates may contain only guardstop and motoroff."
    );
  }
  if (
    state.RapidState.toLowerCase() !== "stopped" ||
    !allowed.some((value) =>
      equalIgnoreCase(value, state.ControllerState)
    )
  ) {
    throw new Error(
      `Unsafe controller state: opmode=${state.Opmode}, ` +
        `ctrl=${state.ControllerState}, rapid=${state.RapidState}`
    );
  }
}

function normalizeConfigInstance(instance) {
  if (instance === null || instance === undefined) return null;
  const attributes = objectValue(instance, "Attributes", "attributes");
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new Error("Configuration instance returned invalid attributes.");
  }
  const normalizedAttributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    normalizedAttributes[name] = text(value);
  }
  const key = text(objectValue(instance, "Key", "key"));
  const instanceId = text(
    objectValue(instance, "InstanceId", "instanceId", "instanceid")
  );
  const rawDeleteKey = objectValue(instance, "DeleteKey", "deleteKey");
  return {
    Key: key,
    InstanceId: instanceId,
    DeleteKey:
      rawDeleteKey === undefined ? instanceId || key : text(rawDeleteKey),
    ReadOnly: Boolean(objectValue(instance, "ReadOnly", "readOnly")),
    Attributes: normalizedAttributes
  };
}

function attributeValue(attributes, name, { required = false } = {}) {
  const entry = Object.entries(attributes ?? {}).find(
    ([key]) => equalIgnoreCase(key, name)
  );
  if (!entry) {
    if (required) throw new Error(`Missing required property: ${name}`);
    return undefined;
  }
  return text(entry[1]);
}

function metricShape(value = {}) {
  const names = [
    "RequestCount",
    "SessionCreateCount",
    "ReconnectCount",
    "TimeoutCount",
    "TransportFailureCount",
    "CircuitFastFailCount"
  ];
  return Object.fromEntries(
    names.map((name) => {
      const raw = Number(
        objectValue(value, name, `${name[0].toLowerCase()}${name.slice(1)}`) ?? 0
      );
      return [name, Number.isSafeInteger(raw) && raw >= 0 ? raw : 0];
    })
  );
}

function metricDelta(before, after) {
  const result = {};
  for (const name of Object.keys(metricShape())) {
    result[name.replace(/Count$/, "Delta")] = after[name] - before[name];
  }
  result.Totals = after;
  return result;
}

function target(operation) {
  switch (operation.Kind) {
    case "cfg_set":
    case "cfg_upsert":
      return `${operation.Domain}/${operation.Type}/${operation.Instance}`;
    case "cfg_delete":
      return `${operation.Domain}/${operation.Type}/${operation.InstanceKey}`;
    case "rapid_set_init":
      return `${operation.Task}/${operation.Module}/${operation.Name}`;
    case "rapid_module_put":
    case "rapid_module_delete":
      return `${operation.Task}/${operation.Module}`;
    case "cfg_file_load":
      return operation.LocalPath;
    default:
      return operation.Kind;
  }
}

function knownControllerResponse(error) {
  return (
    error instanceof Rws1WriteResponseError ||
    error?.responseReceived === true ||
    Number.isInteger(error?.statusCode) ||
    Number.isInteger(error?.response?.statusCode)
  );
}

function errorMessage(error) {
  return text(error?.message || error || "Unknown ABB write failure");
}

function stagingName(now, token) {
  const date = new Date(now());
  if (!Number.isFinite(date.getTime())) {
    throw new Error("now() returned an invalid time.");
  }
  const digits = date
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  return `codex_mcp_${digits.slice(0, 8)}_${digits.slice(8)}_${token.slice(0, 8)}`;
}

function remoteFileName(operation, index) {
  const base = path.basename(text(operation.LocalPath));
  if (
    !base ||
    base === "." ||
    base === ".." ||
    !/^[A-Za-z0-9_.() -]{1,128}$/.test(base)
  ) {
    throw new Error(`Unsafe staged file name: ${operation.LocalPath}`);
  }
  return `${String(index + 1).padStart(3, "0")}_${base}`;
}

export class ControllerWriteUnknownError extends Error {
  constructor(message, { operation, cause } = {}) {
    super(`ControllerWriteUnknown: ${message}`, { cause });
    this.name = "ControllerWriteUnknownError";
    this.code = "CONTROLLER_WRITE_UNKNOWN";
    this.controllerWriteUnknown = true;
    this.operation = operation;
  }
}

/**
 * Executes only an already-prepared DirectChangesetPlanner token.
 *
 * The injected session API is intentionally small and fully mockable:
 *   openSession({ controller, fresh, bypassCircuit })
 *   closeSession({ controller, session, logout })
 *   executeDescriptor({ controller, session, descriptor, request })
 *   waitForRestart({ controller, timeoutSeconds, requestResult })
 *
 * Read methods use the same argument object shape as DirectChangesetPlanner,
 * with an additional `session` property. This module opens no sockets itself.
 */
export class DirectChangesetExecutor {
  constructor({
    planner,
    readApi = planner?.readApi,
    sessionApi,
    writeAdapter = null,
    writeAdapters = null,
    now = () => Date.now(),
    stagingNameFactory = stagingName
  } = {}) {
    if (!planner || typeof planner.consume !== "function") {
      throw new Error("DirectChangesetExecutor requires a planner with consume().");
    }
    if (!readApi || typeof readApi !== "object") {
      throw new Error("DirectChangesetExecutor requires an injected read API.");
    }
    if (!sessionApi || typeof sessionApi !== "object") {
      throw new Error("DirectChangesetExecutor requires an injected session API.");
    }
    if (
      typeof sessionApi.openSession !== "function" ||
      typeof sessionApi.closeSession !== "function" ||
      typeof sessionApi.executeDescriptor !== "function"
    ) {
      throw new Error(
        "sessionApi must implement openSession(), closeSession(), and executeDescriptor()."
      );
    }
    const adapters = writeAdapters instanceof Map
      ? new Map(writeAdapters)
      : writeAdapter
        ? new Map([["rws1", writeAdapter], ["rws2", writeAdapter]])
        : new Map([
            ["rws1", new Rws1WriteAdapter()],
            ["rws2", new Rws2WriteAdapter()]
          ]);
    for (const protocol of ["rws1", "rws2"]) {
      if (typeof adapters.get(protocol)?.operation !== "function") {
        throw new Error(
          `DirectChangesetExecutor requires a ${protocol} write adapter.`
        );
      }
    }
    if (typeof now !== "function" || typeof stagingNameFactory !== "function") {
      throw new Error("now and stagingNameFactory must be functions.");
    }
    this.planner = planner;
    this.readApi = readApi;
    this.sessionApi = sessionApi;
    this.writeAdapters = adapters;
    this.now = now;
    this.stagingNameFactory = stagingNameFactory;
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

  writeAdapterFor(session) {
    const protocol = String(session?.protocol || "rws1").toLowerCase();
    const adapter = this.writeAdapters.get(protocol);
    if (!adapter) throw new Error(`No changeset write adapter for ${protocol}.`);
    return adapter;
  }

  async metrics(controller) {
    const method = this.readApi.getMetrics ?? this.readApi.metrics;
    if (typeof method !== "function") return metricShape();
    return metricShape(await method.call(this.readApi, { controller }));
  }

  async openSession(controller, fresh = false) {
    const session = await this.sessionApi.openSession({
      controller,
      fresh,
      bypassCircuit: true
    });
    if (session === null || session === undefined) {
      throw new Error("sessionApi.openSession() returned no session.");
    }
    return session;
  }

  async closeSession(controller, session, logout = true) {
    if (session === null || session === undefined) return;
    await this.sessionApi.closeSession({ controller, session, logout });
  }

  async closeBestEffort(controller, session, logout = true) {
    try {
      await this.closeSession(controller, session, logout);
      return { Closed: true, Logout: logout };
    } catch (error) {
      return {
        Closed: false,
        Logout: logout,
        Error: errorMessage(error)
      };
    }
  }

  async executeDescriptor(controller, session, descriptor) {
    const response = await this.sessionApi.executeDescriptor({
      controller,
      session,
      descriptor,
      request: descriptor.request
    });
    return descriptor.parse(response);
  }

  async executeMutation(controller, session, descriptor) {
    if (descriptor.reconnectPolicy !== "never-replay") {
      throw new Error(
        `Unsafe mutation retry contract for ${descriptor.operation}: ` +
          `${descriptor.reconnectPolicy}`
      );
    }
    try {
      return await this.executeDescriptor(controller, session, descriptor);
    } catch (error) {
      if (knownControllerResponse(error)) throw error;
      throw new ControllerWriteUnknownError(
        `${descriptor.operation} did not return a definitive controller response. ` +
          "The mutation was not retried.",
        { operation: descriptor.operation, cause: error }
      );
    }
  }

  async readIdentityAndState(prepared, session) {
    const args = { controller: prepared.Alias, session };
    const identity = normalizeIdentity(
      await this.callRead(["getIdentity", "identity"], args)
    );
    assertIdentity(prepared, identity);
    const state = normalizeState(
      await this.callRead(
        ["getControllerState", "controllerState"],
        args
      )
    );
    return { identity, state };
  }

  async identityAndState(prepared, session) {
    const result = await this.readIdentityAndState(prepared, session);
    assertSafeState(prepared, result.state);
    return result;
  }

  async listConfig(prepared, session, domain, type) {
    const raw = await this.callRead(
      ["getConfigInstances", "listConfigInstances"],
      {
        controller: prepared.Alias,
        session,
        domain,
        type
      }
    );
    const list = Array.isArray(raw) ? raw : raw?.Instances;
    if (!Array.isArray(list)) {
      throw new Error(`Configuration inventory is not an array: ${domain}/${type}`);
    }
    return list.map(normalizeConfigInstance);
  }

  async configInstance(
    prepared,
    session,
    domain,
    type,
    instance,
    { allowMissing = false } = {}
  ) {
    if (allowMissing) {
      const list = await this.listConfig(prepared, session, domain, type);
      return (
        list.find(
          (item) =>
            equalIgnoreCase(item.Key, instance) ||
            equalIgnoreCase(item.InstanceId, instance)
        ) ?? null
      );
    }
    const raw = await this.callRead(["getConfigInstance"], {
      controller: prepared.Alias,
      session,
      domain,
      type,
      instance,
      allowMissing: false
    });
    if (raw === null || raw === undefined) {
      throw new Error(
        `Configuration instance not found: ${domain}/${type}/${instance}`
      );
    }
    return normalizeConfigInstance(raw);
  }

  async listRapidModules(prepared, session, task) {
    const raw = await this.callRead(
      ["getRapidModules", "listRapidModules"],
      { controller: prepared.Alias, session, task }
    );
    const list = Array.isArray(raw) ? raw : raw?.Modules;
    if (!Array.isArray(list)) {
      throw new Error(`RAPID module inventory is not an array: ${task}`);
    }
    return list.map((item) => ({
      Name: text(objectValue(item, "Name", "name")),
      Type: text(objectValue(item, "Type", "type"))
    }));
  }

  async rapidModuleText(
    prepared,
    session,
    task,
    module,
    { allowMissing = false } = {}
  ) {
    if (allowMissing) {
      const modules = await this.listRapidModules(prepared, session, task);
      if (!modules.some((item) => equalIgnoreCase(item.Name, module))) {
        return null;
      }
    }
    const value = await this.callRead(["getRapidModuleText"], {
      controller: prepared.Alias,
      session,
      task,
      module,
      allowMissing: false
    });
    if (value === null || value === undefined) {
      throw new Error(`No module text returned for ${task}/${module}`);
    }
    return text(value);
  }

  async rapidDataValue(prepared, session, task, module, name) {
    return text(
      await this.callRead(["getRapidDataValue"], {
        controller: prepared.Alias,
        session,
        task,
        module,
        name
      })
    );
  }

  async assertOperationPrecondition(prepared, session, operation) {
    switch (operation.Kind) {
      case "cfg_set": {
        const current = await this.configInstance(
          prepared,
          session,
          operation.Domain,
          operation.Type,
          operation.Instance
        );
        for (const [name, expected] of Object.entries(operation.Before)) {
          const actual = attributeValue(current.Attributes, name, {
            required: true
          });
          if (!equalExact(actual, expected)) {
            throw new Error(
              `cfg_set precondition changed for ${operation.Type}/` +
                `${operation.Instance}/${name}: actual=${actual} expected=${expected}`
            );
          }
        }
        return;
      }

      case "cfg_upsert": {
        const current = await this.configInstance(
          prepared,
          session,
          operation.Domain,
          operation.Type,
          operation.Instance,
          { allowMissing: true }
        );
        if ((current !== null) !== Boolean(operation.BeforeExists)) {
          throw new Error(
            `cfg_upsert existence precondition changed for ${target(operation)}`
          );
        }
        if (current) {
          for (const [name, expected] of Object.entries(operation.Before)) {
            const actual = attributeValue(current.Attributes, name, {
              required: true
            });
            if (!equalExact(actual, expected)) {
              throw new Error(
                `cfg_upsert precondition changed for ${operation.Type}/` +
                  `${operation.Instance}/${name}`
              );
            }
          }
        }
        return;
      }

      case "cfg_delete": {
        const current = await this.configInstance(
          prepared,
          session,
          operation.Domain,
          operation.Type,
          operation.InstanceKey,
          { allowMissing: true }
        );
        if ((current !== null) !== Boolean(operation.BeforeExists)) {
          throw new Error(
            `cfg_delete existence precondition changed for ${target(operation)}`
          );
        }
        if (
          current &&
          configAttributesSha256(current.Attributes) !==
            operation.BeforeAttributesSha256
        ) {
          throw new Error(
            `cfg_delete attributes changed for ${target(operation)}`
          );
        }
        return;
      }

      case "rapid_set_init": {
        const current = await this.rapidDataValue(
          prepared,
          session,
          operation.Task,
          operation.Module,
          operation.Name
        );
        if (!equalExact(current, operation.Before)) {
          throw new Error(
            `RAPID data precondition changed for ${target(operation)}`
          );
        }
        return;
      }

      case "rapid_module_put":
      case "rapid_module_delete": {
        const current = await this.rapidModuleText(
          prepared,
          session,
          operation.Task,
          operation.Module,
          { allowMissing: true }
        );
        const currentHash = current === null ? null : sha256Text(current);
        if (
          (operation.Kind === "rapid_module_delete" &&
            (current !== null) !== Boolean(operation.BeforeExists)) ||
          currentHash !== operation.BeforeSourceSha256
        ) {
          throw new Error(
            `RAPID module precondition changed for ${target(operation)}`
          );
        }
        return;
      }

      case "cfg_file_load":
        for (const [type, expected] of Object.entries(
          operation.BeforeTypeInventorySha256
        )) {
          const instances = await this.listConfig(
            prepared,
            session,
            operation.Domain,
            type
          );
          const actual = configInventorySha256(instances);
          if (actual !== expected) {
            throw new Error(
              `CFG file precondition changed for ${operation.Domain}/${type}`
            );
          }
        }
        return;

      default:
        throw new Error(`Unsupported prepared operation kind: ${operation.Kind}`);
    }
  }

  async verifyOperation(prepared, session, operation) {
    const result = {
      Kind: operation.Kind,
      Target: target(operation),
      Passed: false
    };
    try {
      switch (operation.Kind) {
        case "cfg_set":
        case "cfg_upsert": {
          const current = await this.configInstance(
            prepared,
            session,
            operation.Domain,
            operation.Type,
            operation.Instance
          );
          const mismatches = [];
          for (const [name, expected] of Object.entries(operation.Desired)) {
            const actual = attributeValue(current.Attributes, name, {
              required: true
            });
            if (!equalExact(actual, expected)) {
              mismatches.push(`${name}:${actual}!=${expected}`);
            }
          }
          return {
            ...result,
            Passed: mismatches.length === 0,
            Mismatches: mismatches
          };
        }

        case "cfg_delete": {
          const current = await this.configInstance(
            prepared,
            session,
            operation.Domain,
            operation.Type,
            operation.InstanceKey,
            { allowMissing: true }
          );
          return {
            ...result,
            Passed: current === null,
            Actual: current === null ? "absent" : "present",
            Expected: "absent"
          };
        }

        case "rapid_set_init": {
          const actual = await this.rapidDataValue(
            prepared,
            session,
            operation.Task,
            operation.Module,
            operation.Name
          );
          return {
            ...result,
            Passed: equalRapidSetInitReadback(actual, operation.Desired),
            Actual: actual,
            Expected: operation.Desired
          };
        }

        case "rapid_module_put": {
          const current = await this.rapidModuleText(
            prepared,
            session,
            operation.Task,
            operation.Module
          );
          const actual = sha256Text(current);
          return {
            ...result,
            Passed: actual === operation.SourceSha256,
            ActualSourceSha256: actual,
            ExpectedSourceSha256: operation.SourceSha256
          };
        }

        case "rapid_module_delete": {
          const current = await this.rapidModuleText(
            prepared,
            session,
            operation.Task,
            operation.Module,
            { allowMissing: true }
          );
          return {
            ...result,
            Passed: current === null,
            Actual: current === null ? "absent" : "present",
            Expected: "absent"
          };
        }

        case "cfg_file_load":
          return await this.verifyCfgFile(prepared, session, operation, result);

        default:
          throw new Error(`Unsupported prepared operation kind: ${operation.Kind}`);
      }
    } catch (error) {
      return {
        ...result,
        Error: errorMessage(error)
      };
    }
  }

  async verifyCfgFile(
    prepared,
    session,
    operation,
    base,
    { includeRuntimeSignals = true } = {}
  ) {
    const checks = [];
    const inventories = new Map();
    const inventory = async (domain, type) => {
      const key = `${domain}|${type}`.toLowerCase();
      if (!inventories.has(key)) {
        inventories.set(
          key,
          await this.listConfig(prepared, session, domain, type)
        );
      }
      return inventories.get(key);
    };
    for (const entry of operation.ParsedEntries) {
      const instances = await inventory(operation.Domain, entry.Type);
      const passed = instances.some((instance) =>
        Object.entries(entry.Fields).every(([name, expected]) => {
          const actual = attributeValue(instance.Attributes, name);
          return actual !== undefined && equalExact(actual, expected);
        })
      );
      checks.push({
        Target: `cfg-file/${operation.Domain}/${entry.Type}`,
        Passed: passed,
        ExpectedFields: cloneJson(entry.Fields),
        Error: passed ? null : "CFG entry missing or field mismatch"
      });
    }

    for (const item of operation.Verify?.cfgInstances ?? []) {
      const current = await this.configInstance(
        prepared,
        session,
        item.domain,
        item.type,
        item.instance
      );
      const mismatches = [];
      for (const [name, expected] of Object.entries(item.fields)) {
        const actual = attributeValue(current.Attributes, name, {
          required: true
        });
        if (!equalExact(actual, expected)) {
          mismatches.push(`${name}:${actual}!=${expected}`);
        }
      }
      checks.push({
        Target: `${item.domain}/${item.type}/${item.instance}`,
        Passed: mismatches.length === 0,
        Mismatches: mismatches
      });
    }

    if (includeRuntimeSignals) {
      for (const signalName of operation.Verify?.signals ?? []) {
        try {
          const signal = await this.callRead(
            ["getIoSignal", "getSignal", "readSignal"],
            {
              controller: prepared.Alias,
              session,
              name: signalName
            }
          );
          checks.push({
            Target: `signal/${signalName}`,
            Passed: true,
            Value: objectValue(signal, "Value", "value"),
            Quality: objectValue(signal, "Quality", "quality")
          });
        } catch (error) {
          checks.push({
            Target: `signal/${signalName}`,
            Passed: false,
            Error: errorMessage(error)
          });
        }
      }
    }

    if ((operation.Verify?.configSignals ?? []).length > 0) {
      const instances = await inventory("eio", "EIO_SIGNAL");
      for (const expectedSignal of operation.Verify.configSignals) {
        const current = instances.find((item) =>
          equalExact(
            attributeValue(item.Attributes, "Name"),
            expectedSignal.name
          )
        );
        if (!current) {
          checks.push({
            Target: `config-signal/${expectedSignal.name}`,
            Passed: false,
            Error: "missing"
          });
          continue;
        }
        const mismatches = [];
        for (const [name, expected] of Object.entries(
          expectedSignal.fields ?? {}
        )) {
          const actual = attributeValue(current.Attributes, name, {
            required: true
          });
          if (!equalExact(actual, expected)) {
            mismatches.push(`${name}:${actual}!=${expected}`);
          }
        }
        checks.push({
          Target: `config-signal/${expectedSignal.name}`,
          Passed: mismatches.length === 0,
          Mismatches: mismatches
        });
      }
    }

    return {
      ...base,
      Passed: checks.every((check) => check.Passed),
      Checks: checks
    };
  }

  async verifyAll(prepared, session) {
    const verification = [];
    for (const operation of prepared.Operations) {
      verification.push(
        await this.verifyOperation(prepared, session, operation)
      );
    }
    return verification;
  }

  async buildErrors(controller, session, task) {
    const errors = [];
    for (let start = 1; start <= 10_000; start += 30) {
      const descriptor = this.writeAdapterFor(session).rapidBuildErrors({
        task,
        start,
        limit: 30
      });
      const page = await this.executeDescriptor(controller, session, descriptor);
      errors.push(...page.Errors);
      if (!page.Next || page.Count < 30) break;
    }
    return errors;
  }

  async stageArtifacts(prepared, session, changed, staging, stageState) {
    const artifacts = changed.filter((operation) =>
      ["rapid_module_put", "cfg_file_load"].includes(operation.Kind)
    );
    if (artifacts.length === 0) {
      return {
        Created: false,
        MayExist: false,
        CreationOutcomeUnknown: false,
        Directory: null,
        Files: new Map(),
        Results: []
      };
    }
    const output = stageState ?? {
      Created: false,
      MayExist: false,
      CreationOutcomeUnknown: false,
      Directory: staging,
      Files: new Map(),
      Results: []
    };
    output.Directory = staging;
    const mkdir = this.writeAdapterFor(session).fileMkdir({
      root: "$HOME",
      directory: staging,
      allowExisting: false
    });
    let mkdirResult;
    try {
      mkdirResult = await this.executeMutation(
        prepared.Alias,
        session,
        mkdir
      );
    } catch (error) {
      if (error?.controllerWriteUnknown === true) {
        // The directory may have been created even though its response was
        // lost. Preserve that uncertainty so the failure path attempts one
        // separately authorized, never-replayed cleanup delete.
        output.MayExist = true;
        output.CreationOutcomeUnknown = true;
      }
      output.Results.push({
        Kind: "staging_create",
        Directory: staging,
        Accepted: false,
        ControllerWriteUnknown: error?.controllerWriteUnknown === true,
        Error: errorMessage(error)
      });
      error.stagingState = output;
      throw error;
    }
    output.Created = true;
    output.MayExist = true;
    output.Results.push(
      {
        Kind: "staging_create",
        Directory: staging,
        Http: mkdirResult.StatusCode
      }
    );
    try {
      for (const [index, operation] of artifacts.entries()) {
        const fileName = remoteFileName(operation, index);
        const relativePath = `${staging}/${fileName}`;
        const upload = this.writeAdapterFor(session).fileUpload({
          root: "$HOME",
          relativePath,
          bytes: operation.ArtifactBytes,
          contentType: "text/plain; charset=utf-8"
        });
        let uploaded;
        try {
          uploaded = await this.executeMutation(
            prepared.Alias,
            session,
            upload
          );
        } catch (error) {
          output.Results.push({
            Kind: "staging_upload",
            Target: target(operation),
            ControllerPath: upload.ControllerPath,
            Accepted: false,
            ControllerWriteUnknown: error?.controllerWriteUnknown === true,
            Error: errorMessage(error)
          });
          throw error;
        }
        output.Files.set(operation, upload.ControllerPath);
        output.Results.push({
          Kind: "staging_upload",
          Target: target(operation),
          ControllerPath: upload.ControllerPath,
          Http: uploaded.StatusCode
        });
      }
    } catch (error) {
      error.stagingState = output;
      throw error;
    }
    return output;
  }

  async cleanupStaging(prepared, session, stage) {
    if (!stage?.Created && !stage?.MayExist) {
      return {
        Attempted: false,
        Removed: true,
        OutcomeUnknown: false,
        ControllerWriteUnknown: false
      };
    }
    try {
      const descriptor = this.writeAdapterFor(session).fileDelete({
        root: "$HOME",
        relativePath: stage.Directory,
        allowMissing: true
      });
      const result = await this.executeMutation(
        prepared.Alias,
        session,
        descriptor
      );
      return {
        Attempted: true,
        Removed: true,
        OutcomeUnknown: false,
        ControllerWriteUnknown: false,
        Directory: stage.Directory,
        Http: result.StatusCode
      };
    } catch (error) {
      const outcomeUnknown = error?.controllerWriteUnknown === true;
      return {
        Attempted: true,
        Removed: false,
        OutcomeUnknown: outcomeUnknown,
        ControllerWriteUnknown: outcomeUnknown,
        Directory: stage.Directory,
        Error: errorMessage(error)
      };
    }
  }

  async performOperation(
    prepared,
    session,
    operation,
    controllerPath,
    onMutationAccepted = () => {}
  ) {
    let descriptor;
    let result;
    switch (operation.Kind) {
      case "cfg_set":
        descriptor = this.writeAdapterFor(session).cfgSet({
          domain: operation.Domain,
          type: operation.Type,
          instance: operation.Instance,
          fields: operation.Desired
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          Http: result.StatusCode
        };

      case "cfg_upsert": {
        let create = null;
        let writableInstance = operation.Instance;
        if (!operation.BeforeExists) {
          descriptor = this.writeAdapterFor(session).cfgCreateDefault({
            domain: operation.Domain,
            type: operation.Type,
            name: operation.Instance
          });
          create = await this.executeMutation(
            prepared.Alias,
            session,
            descriptor
          );
          onMutationAccepted();
          writableInstance = text(create.InstanceId).trim();
          if (!writableInstance) {
            throw new Error(
              `cfg_upsert create-default response omitted InstanceId for ` +
                `${target(operation)}; refusing to guess the writable key.`
            );
          }
        }
        descriptor = this.writeAdapterFor(session).cfgSet({
          domain: operation.Domain,
          type: operation.Type,
          instance: writableInstance,
          fields: operation.Desired
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          CreateHttp: create?.StatusCode ?? null,
          CreatedInstanceId: create?.InstanceId ?? null,
          SetInstance: writableInstance,
          SetHttp: result.StatusCode
        };
      }

      case "cfg_delete":
        descriptor = this.writeAdapterFor(session).cfgDelete({
          domain: operation.Domain,
          type: operation.Type,
          deleteKey: operation.DeleteKey
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          Http: result.StatusCode
        };

      case "rapid_set_init":
        descriptor = this.writeAdapterFor(session).rapidSetInit({
          task: operation.Task,
          module: operation.Module,
          name: operation.Name,
          value: operation.Desired
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          Http: result.StatusCode
        };

      case "rapid_module_put":
        descriptor = this.writeAdapterFor(session).rapidLoadModuleReplace({
          task: operation.Task,
          modulepath: controllerPath
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          ControllerPath: controllerPath,
          LoadHttp: result.StatusCode
        };

      case "rapid_module_delete":
        descriptor = this.writeAdapterFor(session).rapidDeleteModule({
          task: operation.Task,
          module: operation.Module
        });
        result = await this.executeMutation(prepared.Alias, session, descriptor);
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          Http: result.StatusCode
        };

      case "cfg_file_load": {
        const validate = this.writeAdapterFor(session).cfgValidate({
          filepath: controllerPath,
          actionType: operation.ActionType
        });
        const validated = await this.executeDescriptor(
          prepared.Alias,
          session,
          validate
        );
        const load = this.writeAdapterFor(session).cfgLoad({
          filepath: controllerPath,
          actionType: operation.ActionType
        });
        const loaded = await this.executeMutation(
          prepared.Alias,
          session,
          load
        );
        onMutationAccepted();
        return {
          Kind: operation.Kind,
          Target: target(operation),
          ControllerPath: controllerPath,
          ValidateHttp: validated.StatusCode,
          LoadHttp: loaded.StatusCode
        };
      }

      default:
        throw new Error(`Unsupported prepared operation kind: ${operation.Kind}`);
    }
  }

  async applyCfgFile(prepared, state, operation, controllerPath) {
    if (operation.ActionType !== "add") {
      throw new Error(
        "Direct RWS preview refuses CFG load action types other than 'add'; " +
          "add-with-reset requires a complete explicit deletion diff and " +
          "separate approval."
      );
    }
    const controller = prepared.Alias;
    const acquire = this.writeAdapterFor(state.session).mastershipRequest();
    await this.executeDescriptor(controller, state.session, acquire);
    state.mastershipHeld = true;

    await this.identityAndState(prepared, state.session);
    await this.assertOperationPrecondition(prepared, state.session, operation);

    const validate = this.writeAdapterFor(state.session).cfgValidate({
      filepath: controllerPath,
      actionType: operation.ActionType
    });
    const validated = await this.executeDescriptor(
      controller,
      state.session,
      validate
    );

    const load = this.writeAdapterFor(state.session).cfgLoad({
      filepath: controllerPath,
      actionType: operation.ActionType
    });
    let loaded = null;
    let initiallyUnknown = false;
    let initialError = null;
    try {
      loaded = await this.executeMutation(controller, state.session, load);
      state.controllerModified = true;
    } catch (error) {
      if (error?.controllerWriteUnknown !== true) throw error;
      // RW6 can reset RWS after accepting a CFG load. Never replay the load:
      // close/reconnect and let exact readback decide its outcome.
      initiallyUnknown = true;
      initialError = errorMessage(error);
      state.writeOutcomeInitiallyUnknown = true;
    }

    try {
      const release = this.writeAdapterFor(state.session).mastershipRelease();
      await this.executeDescriptor(controller, state.session, release);
    } catch (error) {
      if (!initiallyUnknown) throw error;
      // A lost load response often means the old RWS session no longer exists.
      // Closing it below is the fallback release; the load is not replayed.
    }
    state.mastershipHeld = false;
    await this.closeBestEffort(controller, state.session, true);
    state.session = null;

    try {
      state.session = await this.openSession(controller, true);
      await this.identityAndState(prepared, state.session);
      const verification = await this.verifyCfgFile(
        prepared,
        state.session,
        operation,
        {
          Kind: operation.Kind,
          Target: target(operation),
          Passed: false
        },
        {
          // Runtime signals may not materialize until the approved ordinary
          // restart. Parsed/configured instances are the authoritative
          // pre-restart proof that an unknown CFG load was accepted.
          includeRuntimeSignals: false
        }
      );
      if (!verification.Passed) {
        if (initiallyUnknown) state.controllerWriteUnknown = true;
        throw new Error(
          `CFG file independent verification failed: ${JSON.stringify(
            verification
          )}`
        );
      }
      if (initiallyUnknown) state.controllerModified = true;
      return {
        Kind: operation.Kind,
        Target: target(operation),
        ControllerPath: controllerPath,
        ValidateHttp: validated.StatusCode,
        LoadHttp: loaded?.StatusCode ?? null,
        WriteOutcomeInitiallyUnknown: initiallyUnknown,
        InitialWriteError: initialError,
        Verification: verification
      };
    } catch (error) {
      if (initiallyUnknown) state.controllerWriteUnknown = true;
      throw error;
    }
  }

  validateRestartRecovery(result, transportUnknown) {
    if (!result || result.Online !== true) {
      throw new Error("Controller did not return online after ordinary restart.");
    }
    if (transportUnknown) {
      if (result.OfflineObserved !== true) {
        throw new Error(
          "Restart request outcome was unknown and no controller offline " +
            "transition was observed; restart completion is not proven."
        );
      }
      return;
    }
    if (result.OfflineObserved === true) return;
    if (
      Number(result.SettledMs) < 4_000 ||
      Number(result.ConsecutiveOnlineChecks) < 2
    ) {
      throw new Error(
        "Restart was acknowledged but recovery lacks either an offline " +
          "transition or two fresh online checks after at least 4 seconds."
      );
    }
  }

  async restartAndWait(prepared, state, restart) {
    const controller = prepared.Alias;
    const descriptor = this.writeAdapterFor(state.session).ordinaryRestart({
      mode: restart.mode
    });
    let requestResult = null;
    let requestError = null;
    let transportUnknown = false;
    try {
      requestResult = await this.executeMutation(
        controller,
        state.session,
        descriptor
      );
    } catch (error) {
      if (error?.controllerWriteUnknown !== true) throw error;
      transportUnknown = true;
      requestError = errorMessage(error);
      state.writeOutcomeInitiallyUnknown = true;
    }

    await this.closeBestEffort(controller, state.session, false);
    state.session = null;
    if (typeof this.sessionApi.waitForRestart !== "function") {
      if (transportUnknown) state.controllerWriteUnknown = true;
      throw new Error(
        "sessionApi.waitForRestart() is required for an approved restart."
      );
    }

    let recovery;
    try {
      recovery = await this.sessionApi.waitForRestart({
        controller,
        timeoutSeconds: restart.timeoutSeconds,
        requestResult,
        requestError,
        transportUnknown
      });
      this.validateRestartRecovery(recovery, transportUnknown);
    } catch (error) {
      if (transportUnknown) state.controllerWriteUnknown = true;
      throw error;
    }
    return {
      Requested: requestResult !== null,
      RequestTransportUnknown: transportUnknown,
      InitialWriteError: requestError,
      ...cloneJson(recovery)
    };
  }

  async freshVerification(prepared, buildTasks) {
    let session;
    try {
      session = await this.openSession(prepared.Alias, true);
      const { identity, state } = await this.readIdentityAndState(prepared, session);
      const verification = await this.verifyAll(prepared, session);
      const buildVerification = [];
      for (const task of buildTasks) {
        try {
          const errors = await this.buildErrors(prepared.Alias, session, task);
          buildVerification.push({
            Task: task,
            ErrorCount: errors.length,
            Passed: errors.length === 0,
            Errors: errors
          });
        } catch (error) {
          buildVerification.push({
            Task: task,
            Passed: false,
            Error: errorMessage(error)
          });
        }
      }
      return {
        ReadbackSucceeded: true,
        Identity: identity,
        State: state,
        Verification: verification,
        Build: buildVerification,
        Passed:
          verification.every((item) => item.Passed) &&
          buildVerification.every((item) => item.Passed)
      };
    } catch (error) {
      return {
        ReadbackSucceeded: false,
        Passed: false,
        Error: errorMessage(error)
      };
    } finally {
      await this.closeBestEffort(prepared.Alias, session, true);
    }
  }

  async apply(token) {
    const prepared = this.planner.consume(token);
    const started = performance.now();
    const controller = prepared.Alias;
    const changed = prepared.Operations.filter((operation) => operation.NeedsChange);
    const buildTasks = [
      ...new Set(
        changed
          .filter((operation) => RAPID_MODULE_KINDS.has(operation.Kind))
          .map((operation) => operation.Task.toLowerCase())
      )
    ].map(
      (folded) =>
        changed.find(
          (operation) =>
            RAPID_MODULE_KINDS.has(operation.Kind) &&
            operation.Task.toLowerCase() === folded
        ).Task
    );
    const results = [];
    const phaseTimings = {
      Preflight: 0,
      Stage: 0,
      ConfigFileLoad: 0,
      BatchWriteAndBuild: 0,
      RestartAndReconnect: 0,
      IndependentReadback: 0
    };
    let metricsBefore = metricShape();
    const state = {
      session: null,
      mastershipHeld: false,
      controllerModified: false,
      controllerWriteUnknown: false,
      writeOutcomeInitiallyUnknown: false,
      stage: {
        Created: false,
        MayExist: false,
        CreationOutcomeUnknown: false,
        Directory: null,
        Files: new Map(),
        Results: []
      },
      cleanup: { Attempted: false, Removed: false }
    };

    try {
      metricsBefore = await this.metrics(controller);
      let timer = performance.now();
      // Every apply starts from a new identity-locked session. A no-op can
      // verify on this same session without paying for a redundant reconnect.
      state.session = await this.openSession(controller, true);
      const preflight = await this.identityAndState(prepared, state.session);
      phaseTimings.Preflight = Math.max(0, Math.floor(performance.now() - timer));

      if (changed.length === 0) {
        timer = performance.now();
        const verification = await this.verifyAll(prepared, state.session);
        phaseTimings.IndependentReadback = Math.max(
          0,
          Math.floor(performance.now() - timer)
        );
        if (verification.some((item) => !item.Passed)) {
          throw new Error(
            `No-op verification failed: ${JSON.stringify(verification)}`
          );
        }
        await this.closeSession(controller, state.session, true);
        state.session = null;
        const metricsAfter = await this.metrics(controller);
        return {
          Applied: true,
          NoOp: true,
          Verified: true,
          ReadbackSucceeded: true,
          VerificationMode: "independent-session",
          Controller: controller,
          Identity: preflight.identity,
          State: preflight.state,
          ManifestSha256: prepared.ManifestHash,
          ChangedOperationCount: 0,
          SkippedNoOpCount: prepared.Operations.length,
          Results: [],
          Verification: verification,
          BuildVerification: [],
          PhaseTimingsMs: phaseTimings,
          TotalElapsedMs: Math.max(
            0,
            Math.floor(performance.now() - started)
          ),
          Metrics: metricDelta(metricsBefore, metricsAfter),
          RobotStarted: false,
          MotorsEnabled: false,
          ControllerModified: false,
          ControllerWriteUnknown: false,
          WriteOutcomeInitiallyUnknown: false
        };
      }

      timer = performance.now();
      const stage = this.stagingNameFactory(this.now, prepared.Token);
      try {
        state.stage = await this.stageArtifacts(
          prepared,
          state.session,
          changed,
          stage,
          state.stage
        );
      } catch (error) {
        if (error.stagingState) state.stage = error.stagingState;
        results.push(...state.stage.Results);
        throw error;
      }
      results.push(...state.stage.Results);
      phaseTimings.Stage = Math.max(0, Math.floor(performance.now() - timer));

      const cfgFiles = changed.filter(
        (operation) => operation.Kind === "cfg_file_load"
      );
      timer = performance.now();
      for (const operation of cfgFiles) {
        results.push(
          await this.applyCfgFile(
            prepared,
            state,
            operation,
            state.stage.Files.get(operation)
          )
        );
      }
      phaseTimings.ConfigFileLoad = Math.max(
        0,
        Math.floor(performance.now() - timer)
      );

      const remaining = changed.filter(
        (operation) => operation.Kind !== "cfg_file_load"
      );
      timer = performance.now();
      if (remaining.length > 0) {
        const acquire = this.writeAdapterFor(state.session).mastershipRequest();
        await this.executeDescriptor(controller, state.session, acquire);
        state.mastershipHeld = true;

        // CFG loads may have reconnected the controller. Re-lock identity/state
        // and every remaining optimistic snapshot inside the one batch
        // mastership, before its first controller mutation.
        await this.identityAndState(prepared, state.session);
        for (const operation of remaining) {
          await this.assertOperationPrecondition(
            prepared,
            state.session,
            operation
          );
        }

        for (const operation of remaining) {
          if (!WRITE_OPERATION_KINDS.has(operation.Kind)) {
            throw new Error(
              `Unsupported prepared operation kind: ${operation.Kind}`
            );
          }
          try {
            const operationResult = await this.performOperation(
              prepared,
              state.session,
              operation,
              state.stage.Files.get(operation),
              () => {
                state.controllerModified = true;
              }
            );
            results.push(operationResult);
          } catch (error) {
            if (error?.controllerWriteUnknown === true) {
              state.controllerWriteUnknown = true;
            }
            throw error;
          }
        }

        for (const task of buildTasks) {
          const build = this.writeAdapterFor(state.session).rapidBuild({ task });
          let built;
          try {
            built = await this.executeMutation(controller, state.session, build);
          } catch (error) {
            if (error?.controllerWriteUnknown === true) {
              state.controllerWriteUnknown = true;
            }
            throw error;
          }
          const errors = await this.buildErrors(controller, state.session, task);
          results.push({
            Kind: "rapid_build",
            Target: task,
            Http: built.StatusCode,
            ErrorCount: errors.length,
            Errors: errors
          });
          if (errors.length > 0) {
            throw new Error(
              `Build reported ${errors.length} error(s) for ${task}`
            );
          }
        }

        const release = this.writeAdapterFor(state.session).mastershipRelease();
        await this.executeDescriptor(controller, state.session, release);
        state.mastershipHeld = false;
      }
      phaseTimings.BatchWriteAndBuild = Math.max(
        0,
        Math.floor(performance.now() - timer)
      );

      state.cleanup = await this.cleanupStaging(
        prepared,
        state.session,
        state.stage
      );
      if (state.cleanup.ControllerWriteUnknown) {
        state.controllerWriteUnknown = true;
        state.writeOutcomeInitiallyUnknown = true;
      }
      results.push({
        Kind: "staging_cleanup",
        Result: state.cleanup
      });

      const restart = prepared.Manifest.restart;
      timer = performance.now();
      if (restart?.required === true) {
        const restartResult = await this.restartAndWait(
          prepared,
          state,
          restart
        );
        results.push({
          Kind: "restart",
          Result: restartResult
        });
      } else {
        await this.closeSession(controller, state.session, true);
        state.session = null;
      }
      phaseTimings.RestartAndReconnect = Math.max(
        0,
        Math.floor(performance.now() - timer)
      );

      timer = performance.now();
      const readback = await this.freshVerification(prepared, buildTasks);
      phaseTimings.IndependentReadback = Math.max(
        0,
        Math.floor(performance.now() - timer)
      );
      if (!readback.Passed) {
        throw new Error(
          `Independent verification failed: ${JSON.stringify(readback)}`
        );
      }

      const metricsAfter = await this.metrics(controller);
      return {
        Applied: true,
        Controller: controller,
        Verified: true,
        ReadbackSucceeded: true,
        VerificationMode: "independent-session",
        Identity: readback.Identity,
        State: readback.State,
        ManifestSha256: prepared.ManifestHash,
        ChangedOperationCount: changed.length,
        SkippedNoOpCount: prepared.Operations.length - changed.length,
        Results: results,
        Verification: readback.Verification,
        BuildVerification: readback.Build,
        StagingCleanup: state.cleanup,
        PhaseTimingsMs: phaseTimings,
        TotalElapsedMs: Math.max(
          0,
          Math.floor(performance.now() - started)
        ),
        Metrics: metricDelta(metricsBefore, metricsAfter),
        RobotStarted: false,
        MotorsEnabled: false,
        ControllerModified: state.controllerModified,
        ControllerWriteUnknown: state.controllerWriteUnknown,
        PartialApply: state.controllerWriteUnknown,
        NeedsFreshPlan: state.controllerWriteUnknown,
        WriteOutcomeInitiallyUnknown: state.writeOutcomeInitiallyUnknown
      };
    } catch (error) {
      if (error?.controllerWriteUnknown === true) {
        state.controllerWriteUnknown = true;
      }
      if (state.mastershipHeld && state.session) {
        try {
          const release = this.writeAdapterFor(state.session).mastershipRelease();
          await this.executeDescriptor(controller, state.session, release);
        } catch {
          // Closing the authenticated session below is the authoritative
          // fallback for releasing global mastership.
        }
        state.mastershipHeld = false;
      }
      await this.closeBestEffort(controller, state.session, true);
      state.session = null;

      let cleanupSession;
      if (
        (state.stage.Created || state.stage.MayExist) &&
        !state.cleanup.Removed
      ) {
        try {
          cleanupSession = await this.openSession(controller, true);
          state.cleanup = await this.cleanupStaging(
            prepared,
            cleanupSession,
            state.stage
          );
          if (state.cleanup.ControllerWriteUnknown) {
            state.controllerWriteUnknown = true;
            state.writeOutcomeInitiallyUnknown = true;
          }
        } catch (cleanupError) {
          if (cleanupError?.controllerWriteUnknown === true) {
            state.controllerWriteUnknown = true;
            state.writeOutcomeInitiallyUnknown = true;
          }
          state.cleanup = {
            Attempted: true,
            Removed: false,
            OutcomeUnknown: cleanupError?.controllerWriteUnknown === true,
            ControllerWriteUnknown:
              cleanupError?.controllerWriteUnknown === true,
            Directory: state.stage.Directory,
            Error: errorMessage(cleanupError)
          };
        } finally {
          await this.closeBestEffort(controller, cleanupSession, true);
        }
      }
      results.push({
        Kind: "staging_cleanup",
        Result: state.cleanup
      });

      const postFailure = await this.freshVerification(prepared, buildTasks);
      const metricsAfter = await this.metrics(controller);
      return {
        Applied: false,
        PartialApply:
          state.controllerModified || state.controllerWriteUnknown,
        ControllerModified: state.controllerModified,
        ControllerWriteUnknown: state.controllerWriteUnknown,
        WriteOutcomeInitiallyUnknown: state.writeOutcomeInitiallyUnknown,
        NeedsFreshPlan: true,
        Controller: controller,
        ManifestSha256: prepared.ManifestHash,
        Failure: errorMessage(error),
        Results: results,
        PostFailureReadback: postFailure,
        StagingCleanup: state.cleanup,
        PhaseTimingsMs: phaseTimings,
        TotalElapsedMs: Math.max(
          0,
          Math.floor(performance.now() - started)
        ),
        Metrics: metricDelta(metricsBefore, metricsAfter),
        RobotStarted: false,
        MotorsEnabled: false
      };
    } finally {
      if (state.mastershipHeld && state.session) {
        try {
          const release = this.writeAdapterFor(state.session).mastershipRelease();
          await this.executeDescriptor(controller, state.session, release);
        } catch {
          // Session close below is the fallback release.
        }
      }
      await this.closeBestEffort(controller, state.session, true);
      try {
        this.planner.discard?.(prepared.Token);
      } catch {
        // Applying a token is already terminal. Do not turn a completed
        // controller result into an exception if tombstone cleanup fails.
      }
    }
  }
}

export { RAPID_MODULE_KINDS, WRITE_OPERATION_KINDS };
