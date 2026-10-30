import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AliasReadWriteLock } from "./alias-read-write-lock.mjs";
import { atomicReplace, DpapiCredentialProvider } from "./credential-provider.mjs";
import {
  DEFAULT_RWS_MAX_SOCKETS,
  DigestHttpClient,
  RwsHttpError
} from "./digest-http-client.mjs";
import {
  RWS1,
  RWS2,
  RWS2_ACCEPT,
  RwsAdapter,
  normalizeRwsProtocol,
  rws2ModuleTextFilePath
} from "./rws-adapter.mjs";
import { Rws2HttpClient } from "./rws2-http-client.mjs";
import {
  DIRECT_METHODS,
  SMALL_SIGNAL_EXACT_THRESHOLD,
  directMethodLockMode,
  directMethodRequestWeight,
  isDirectBackupMethod,
  isDirectRwsMethod
} from "./method-routing.mjs";
import { RequestSemaphore } from "./request-semaphore.mjs";
import { mapWithConcurrency } from "./bounded-map.mjs";
import { readDeadlineError, remainingReadTime } from "./read-deadline.mjs";
const SAFE_CONFIG_DOMAINS = new Set(["eio", "sio", "sys", "proc"]);
const DEFAULT_CONFIG_PAGE_SIZE = 70;
const DEFAULT_CONFIG_MAX_ITEMS = 20_000;
const DEFAULT_SIGNAL_PAGE_SIZE = 500;
const DEFAULT_SIGNAL_MAX_ITEMS = 50_000;
const MAX_PAGE_SIZE = 5_000;
const MAX_PAGINATION_ITEMS = 1_000_000;
const TRANSPORT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN"
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeSystemId(value) {
  return String(value || "").trim().replace(/^\{|\}$/g, "").toLowerCase();
}

function sha256(value) {
  const normalized = String(value).replace(/\r\n?/g, "\n").trim();
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function states(document) {
  const value =
    document?._embedded?._state ??
    document?._embedded?.state ??
    document?._state ??
    document?.state ??
    document?._embedded?.resources;
  return Array.isArray(value) ? value : value ? [value] : [];
}

function parseJson(response, operation) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error.message}`);
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

const ROBTARGET_COMPONENTS = [
  "x", "y", "z",
  "q1", "q2", "q3", "q4",
  "cf1", "cf4", "cf6", "cfx",
  "ej1", "ej2", "ej3", "ej4", "ej5", "ej6"
];

function parseRapidRobtarget(body) {
  const source = String(body || "");
  let payload = "";
  for (const match of source.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const className = match[1].match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const classes = String(className?.[1] ?? className?.[2] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (classes.includes("rapid-robtarget")) {
      payload = match[2];
      break;
    }
  }
  if (!payload) throw new Error("RAPID motion payload missing rapid-robtarget.");

  const raw = {};
  for (const match of payload.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
    const className = match[1].match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const key = String(className?.[1] ?? className?.[2] ?? "")
      .split(/\s+/)
      .find((item) => ROBTARGET_COMPONENTS.includes(item));
    if (!key) continue;
    raw[key] = decodeHtml(match[2].replace(/<[^>]*>/g, "")).trim();
  }

  return robtargetFromComponents(raw);
}

function robtargetFromComponents(raw) {
  for (const key of ROBTARGET_COMPONENTS) {
    const value = raw[key];
    if (
      value === undefined ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value))
    ) {
      throw new Error(`RAPID robtarget component is missing or invalid: ${key}`);
    }
  }

  const numeric = Object.fromEntries(
    ROBTARGET_COMPONENTS.map((key) => [key, Number(raw[key])])
  );
  return {
    Value:
      `[[${raw.x},${raw.y},${raw.z}],` +
      `[${raw.q1},${raw.q2},${raw.q3},${raw.q4}],` +
      `[${raw.cf1},${raw.cf4},${raw.cf6},${raw.cfx}],` +
      `[${raw.ej1},${raw.ej2},${raw.ej3},${raw.ej4},${raw.ej5},${raw.ej6}]]`,
    Trans: { X: numeric.x, Y: numeric.y, Z: numeric.z },
    Rot: {
      Q1: numeric.q1,
      Q2: numeric.q2,
      Q3: numeric.q3,
      Q4: numeric.q4
    },
    Robconf: {
      Cf1: numeric.cf1,
      Cf4: numeric.cf4,
      Cf6: numeric.cf6,
      Cfx: numeric.cfx
    },
    Extax: {
      EaxA: numeric.ej1,
      EaxB: numeric.ej2,
      EaxC: numeric.ej3,
      EaxD: numeric.ej4,
      EaxE: numeric.ej5,
      EaxF: numeric.ej6
    }
  };
}

function parseRapidRobtargetJson(response) {
  const item = states(parseJson(response, "Read current robtarget"))[0];
  if (!item) throw new Error("RAPID robtarget response contains no target.");
  const aliases = {
    ej1: "eax_a",
    ej2: "eax_b",
    ej3: "eax_c",
    ej4: "eax_d",
    ej5: "eax_e",
    ej6: "eax_f"
  };
  const raw = {};
  for (const key of ROBTARGET_COMPONENTS) {
    const value = item[key] ?? item[aliases[key]];
    const text = String(value ?? "");
    raw[key] = text;
  }
  return robtargetFromComponents(raw);
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(value))) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function checkedControllerAlias(value, label = "controller alias") {
  const alias = typeof value === "string" ? value : "";
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(alias) ||
    ["__proto__", "prototype", "constructor"].includes(alias.toLowerCase())
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return alias;
}

function rapidTaskForRead(binding, explicitTask) {
  const candidate = explicitTask === undefined
    ? binding?.config?.defaultTask
    : explicitTask;
  const task = typeof candidate === "string" ? candidate : "";
  assertIdentifier(task, "RAPID task");
  return task;
}

function assertInstanceKey(value, label) {
  const text = String(value);
  if (
    text.length < 1 ||
    text.length > 160 ||
    text !== text.trim() ||
    /[\x00-\x1f\x7f/\\?#]/.test(text)
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function normalizeDomain(value, registry) {
  const domain = String(value).trim().toLowerCase();
  const configured = registry.allowedConfigDomains;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("controller-registry.json must explicitly define allowedConfigDomains.");
  }
  if (configured.some((item) => !SAFE_CONFIG_DOMAINS.has(String(item).toLowerCase()))) {
    throw new Error(
      "allowedConfigDomains may contain only eio, sio, sys, and proc. Motion configuration is intentionally blocked."
    );
  }
  if (!configured.map((item) => String(item).toLowerCase()).includes(domain)) {
    throw new Error(`Configuration domain is not allowed by the registry: ${value}`);
  }
  return domain;
}

function ioSignalView(item, requestedName = "") {
  const title = String(item?._title ?? "");
  const name = String(item?.name ?? "") || title.split("/").at(-1) || requestedName;
  const logicalState = String(item?.lstate ?? "");
  return {
    Name: requestedName || name,
    Value: String(item?.lvalue ?? ""),
    LogicalState: logicalState,
    PhysicalState: String(item?.phstate ?? ""),
    Quality: String(item?.quality ?? ""),
    Simulated: String(item?.simstate ?? "") || logicalState
  };
}

function signalBelongsToBinding(item, binding) {
  const titleParts = String(item?._title || "").split("/");
  return (
    titleParts.length < 3 ||
    (titleParts[0] === String(binding.config.ioNetwork) &&
      titleParts[1] === String(binding.config.ioDevice))
  );
}

async function settledValues(promises) {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((item) => item.status === "rejected");
  if (rejected) throw rejected.reason;
  return settled.map((item) => item.value);
}

function boundedInteger(value, { name, fallback, minimum = 1, maximum }) {
  const candidate = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return candidate;
}

function emptyMetrics() {
  return {
    RequestCount: 0,
    SessionCreateCount: 0,
    ReconnectCount: 0,
    TimeoutCount: 0,
    TransportFailureCount: 0,
    CircuitFastFailCount: 0
  };
}

function copyMetrics(metrics) {
  return { ...metrics };
}

function metricDelta(after, before) {
  return {
    RequestCount: after.RequestCount - before.RequestCount,
    SessionCreateCount: after.SessionCreateCount - before.SessionCreateCount,
    ReconnectCount: after.ReconnectCount - before.ReconnectCount,
    TimeoutCount: after.TimeoutCount - before.TimeoutCount,
    TransportFailureCount: after.TransportFailureCount - before.TransportFailureCount,
    CircuitFastFailCount: after.CircuitFastFailCount - before.CircuitFastFailCount
  };
}

function controllerSignature(config) {
  return JSON.stringify({
    baseUrl: config.baseUrl,
    expectedName: config.expectedName,
    expectedSystemId: normalizeSystemId(config.expectedSystemId),
    expectedRobotWare: config.expectedRobotWare,
    username: config.username,
    credentialFile: config.credentialFile,
    defaultTask: config.defaultTask,
    ioNetwork: config.ioNetwork,
    ioDevice: config.ioDevice,
    rwsProtocol: config.rwsProtocol,
    validateServerCertificate: config.validateServerCertificate,
    certificateSha256: String(config.certificateSha256 || "")
      .replaceAll(":", "")
      .toUpperCase(),
    requestTimeoutSeconds: config.requestTimeoutSeconds,
    longRequestTimeoutSeconds: config.longRequestTimeoutSeconds
  });
}

function isTransportFailure(error) {
  const statusCode = Number(error?.statusCode ?? error?.status ?? 0);
  if (error instanceof RwsHttpError || (Number.isFinite(statusCode) && statusCode > 0)) {
    return false;
  }

  const code = String(error?.code || "").trim().toUpperCase();
  if (code) return TRANSPORT_ERROR_CODES.has(code);

  return /timed out|timeout|connection refused|network is unreachable|host is unreachable/i.test(
    error?.message || ""
  );
}

export class DirectRwsService {
  constructor({
    registryPath,
    offlineCooldownMs = 5_000,
    pagination = {},
    maxSockets = DEFAULT_RWS_MAX_SOCKETS,
    registryFileReader = readFile,
    backupManagerLoader = () => import("./backup-manager.mjs")
  } = {}) {
    if (typeof registryFileReader !== "function") {
      throw new Error("registryFileReader must be a function.");
    }
    if (typeof backupManagerLoader !== "function") {
      throw new Error("backupManagerLoader must be a function.");
    }
    this.registryPath = path.resolve(registryPath);
    this.registryFileReader = registryFileReader;
    this.registryReloadTail = Promise.resolve();
    this.offlineCooldownMs = Math.min(60_000, Math.max(500, offlineCooldownMs));
    this.registry = null;
    this.registrySha256 = "";
    this.bindings = new Map();
    this.bindingTransitions = new Map();
    this.metrics = new Map();
    this.transportFailures = new Map();
    this.credentialProvider = new DpapiCredentialProvider();
    this.maxSockets = boundedInteger(maxSockets, {
      name: "maxSockets",
      fallback: DEFAULT_RWS_MAX_SOCKETS,
      maximum: 16
    });
    this.aliasLocks = new Map();
    this.httpRequestSemaphores = new Map();
    this.httpRequestContext = new AsyncLocalStorage();
    this.readCallContext = new AsyncLocalStorage();
    this.clientActivity = new WeakMap();
    this.pagination = Object.freeze({
      configPageSize: boundedInteger(pagination.configPageSize, {
        name: "configPageSize",
        fallback: DEFAULT_CONFIG_PAGE_SIZE,
        maximum: MAX_PAGE_SIZE
      }),
      configMaxItems: boundedInteger(pagination.configMaxItems, {
        name: "configMaxItems",
        fallback: DEFAULT_CONFIG_MAX_ITEMS,
        maximum: MAX_PAGINATION_ITEMS
      }),
      signalPageSize: boundedInteger(pagination.signalPageSize, {
        name: "signalPageSize",
        fallback: DEFAULT_SIGNAL_PAGE_SIZE,
        maximum: MAX_PAGE_SIZE
      }),
      signalMaxItems: boundedInteger(pagination.signalMaxItems, {
        name: "signalMaxItems",
        fallback: DEFAULT_SIGNAL_MAX_ITEMS,
        maximum: MAX_PAGINATION_ITEMS
      })
    });
    this.backupManagerLoader = backupManagerLoader;
    this.backups = null;
    this.backupsReady = null;
    this.activeCalls = 0;
    this.acceptingCalls = true;
    this.drainWaiters = [];
    this.closePromise = null;
    this.closed = false;
  }

  static supports(method) {
    return isDirectRwsMethod(method);
  }

  get busy() {
    return this.activeCalls > 0;
  }

  finishCall() {
    this.activeCalls -= 1;
    if (this.activeCalls !== 0) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async waitForDrain() {
    if (this.activeCalls === 0) return;
    await new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  async ensureBackups() {
    if (this.closed) throw new Error("ABB direct RWS service is closed.");
    if (this.backups) return this.backups;
    if (this.backupsReady) return await this.backupsReady;
    this.backupsReady = (async () => {
      const loaded = await this.backupManagerLoader();
      const BackupManager = loaded?.DirectBackupManager;
      if (typeof BackupManager !== "function") {
        throw new Error(
          "Direct backup module did not export DirectBackupManager."
        );
      }
      const backups = new BackupManager(this);
      if (this.closed) {
        backups.close();
        throw new Error("ABB direct RWS service is closed.");
      }
      this.backups = backups;
      return backups;
    })().catch((error) => {
      this.backupsReady = null;
      throw error;
    });
    return await this.backupsReady;
  }

  metricsFor(alias) {
    if (!this.metrics.has(alias)) this.metrics.set(alias, emptyMetrics());
    return this.metrics.get(alias);
  }

  httpRequestSemaphore(alias) {
    alias = String(alias);
    let semaphore = this.httpRequestSemaphores.get(alias);
    if (!semaphore) {
      semaphore = new RequestSemaphore(
        this.maxSockets,
        `ABB alias '${alias}' HTTP request semaphore`
      );
      this.httpRequestSemaphores.set(alias, semaphore);
    }
    return semaphore;
  }

  async withHttpRequestPermit(alias, operation) {
    alias = String(alias);
    const context = this.httpRequestContext.getStore();
    const deadlineAt = this.readCallContext.getStore()?.deadlineAt;
    const runGlobal = async () =>
      await this.httpRequestSemaphore(alias).run(operation, deadlineAt);
    if (context?.alias !== alias) return await runGlobal();
    return await context.requests.run(runGlobal, deadlineAt);
  }

  async readRequest(client, options, operation) {
    const request = (requestOptions) => operation
      ? client.requestOk(requestOptions, operation, [200])
      : client.request(requestOptions);
    const context = this.readCallContext.getStore();
    if (!context) return await request(options);
    const remaining = remainingReadTime(context.deadlineAt);
    const started = performance.now();
    context.requestCount += 1;
    try {
      return await request({
        ...options,
        deadlineAt: context.deadlineAt,
        timeoutMs: Math.min(options.timeoutMs ?? client.requestTimeoutMs ?? 5_000, remaining)
      });
    } catch (error) {
      if (error?.code === "ETIMEDOUT" && Date.now() >= context.deadlineAt) {
        throw readDeadlineError();
      }
      throw error;
    } finally {
      context.httpElapsedMs += performance.now() - started;
    }
  }

  async reloadRegistry() {
    const reload = async () => {
      const bytes = await this.registryFileReader(this.registryPath);
      const registrySha256 = sha256Bytes(bytes);
      if (this.registry && registrySha256 === this.registrySha256) {
        return false;
      }
      const updated = JSON.parse(bytes.toString("utf8"));
      if (this.registry) {
        for (const [alias, binding] of this.bindings) {
          const next = updated.controllers?.[alias];
          if (!next || controllerSignature(next) !== controllerSignature(binding.config)) {
            // Never close a client from a concurrent registry reader. A normal
            // read transitions the stale binding before its next request; an
            // active no-reconnect changeset instead fails its ControllerLock
            // check closed and performs its normal session teardown.
            binding.registryStale = true;
          }
        }
      }
      this.registry = updated;
      this.registrySha256 = registrySha256;
      this.transportFailures.clear();
      return true;
    };

    const result = this.registryReloadTail.then(reload);
    this.registryReloadTail = result.catch(() => undefined);
    return await result;
  }

  config(alias) {
    const controllers = this.registry?.controllers;
    if (
      !controllers ||
      typeof controllers !== "object" ||
      !Object.hasOwn(controllers, alias)
    ) {
      throw new Error(`Unknown controller alias: ${alias}`);
    }
    return controllers[alias];
  }

  assertCircuit(alias, bypass = false) {
    if (bypass) return;
    const failure = this.transportFailures.get(alias);
    if (!failure) return;
    const retryAfterMs = this.offlineCooldownMs - (Date.now() - failure.failedAt);
    if (retryAfterMs <= 0) {
      this.transportFailures.delete(alias);
      return;
    }
    this.metricsFor(alias).CircuitFastFailCount += 1;
    throw new Error(
      `ControllerUnavailableCached: alias=${alias} retryAfterMs=${retryAfterMs} lastFailureKind=${failure.kind} lastError=${failure.error}`
    );
  }

  registerTransportFailure(alias, error) {
    if (!isTransportFailure(error)) return;
    this.metricsFor(alias).TransportFailureCount += 1;
    this.transportFailures.set(alias, {
      failedAt: Date.now(),
      kind: "transport",
      error: String(error.message || error).slice(0, 240)
    });
  }

  async newClient(config) {
    const protocol = normalizeRwsProtocol(config.rwsProtocol);
    const credentialProvider = async () => {
      const credential = await this.credentialProvider.get(config);
      const username = String(config.username || credential.username);
      if (
        config.username &&
        credential.username &&
        String(config.username) !== String(credential.username)
      ) {
        throw new Error(
          `ABB credential user mismatch: registry=${config.username}, credential=${credential.username}`
        );
      }
      return { username, password: credential.password };
    };
    const common = {
      baseUrl: config.baseUrl,
      requestTimeoutMs: Math.max(1, Number(config.requestTimeoutSeconds || 5)) * 1_000,
      credentialProvider,
      maxSockets: this.maxSockets,
      validateServerCertificate: config.validateServerCertificate !== false
    };
    if (protocol === RWS1) return new DigestHttpClient(common);
    if (config.validateServerCertificate === false) {
      throw new Error(
        "Registered RWS2 controllers may not disable TLS certificate validation."
      );
    }
    if (!config.certificateSha256) {
      throw new Error(
        "Registered RWS2 controllers require an exact certificateSha256 pin."
      );
    }
    return new Rws2HttpClient({
      ...common,
      certificateSha256: config.certificateSha256
    });
  }

  parseIdentity(response) {
    const document = parseJson(response, "Read ABB controller identity");
    const system = states(document)[0];
    if (!system) throw new Error("ABB controller identity response contains no system.");
    return {
      Name: String(system.name ?? system["system-name"] ?? ""),
      SystemId: normalizeSystemId(system.sysid ?? system["system-id"] ?? ""),
      RobotWare: String(system.rwversion ?? system["rw-version"] ?? "")
    };
  }

  assertIdentity(identity, config) {
    const expectedSystemId = normalizeSystemId(config.expectedSystemId);
    if (
      identity.Name !== String(config.expectedName) ||
      identity.SystemId !== expectedSystemId
    ) {
      throw new Error(
        `CONTROLLER IDENTITY MISMATCH: actual=${identity.Name}/${identity.SystemId}, ` +
          `expected=${config.expectedName}/${expectedSystemId}`
      );
    }
    if (
      config.expectedRobotWare &&
      identity.RobotWare !== String(config.expectedRobotWare)
    ) {
      throw new Error(
        `ROBOTWARE MISMATCH: actual=${identity.RobotWare}, expected=${config.expectedRobotWare}`
      );
    }
  }

  async openBinding(alias, { bypassCircuit = false } = {}) {
    this.assertCircuit(alias, bypassCircuit);
    const config = this.config(alias);
    const protocol = normalizeRwsProtocol(config.rwsProtocol);
    const adapter = new RwsAdapter({ protocol });
    const metrics = this.metricsFor(alias);
    const client = await this.newClient(config);
    metrics.SessionCreateCount += 1;
    try {
      const identityOperation = adapter.identity();
      const response = await this.withHttpRequestPermit(
        alias,
        async () => await this.readRequest(client, identityOperation.request, "Read ABB controller identity")
      );
      metrics.RequestCount += 1;
      const identity = identityOperation.parse(response);
      this.assertIdentity(identity, config);
      const timestamp = nowIso();
      const binding = {
        alias,
        config,
        protocol,
        adapter,
        client,
        identity,
        boundAt: timestamp,
        verifiedAt: timestamp,
        lastUsedAt: Date.now()
      };
      this.transportFailures.delete(alias);
      return binding;
    } catch (error) {
      if (error?.code === "ETIMEDOUT") metrics.TimeoutCount += 1;
      this.registerTransportFailure(alias, error);
      await client.close({ logout: false });
      throw error;
    }
  }

  async createBinding(alias, { bypassCircuit = false } = {}) {
    const binding = await this.openBinding(alias, { bypassCircuit });
    this.bindings.set(alias, binding);
    return binding;
  }

  beginClientRequest(client) {
    let activity = this.clientActivity.get(client);
    if (!activity) {
      activity = { active: 0, idleWaiters: [] };
      this.clientActivity.set(client, activity);
    }
    activity.active += 1;
  }

  finishClientRequest(client) {
    const activity = this.clientActivity.get(client);
    if (!activity) return;
    activity.active = Math.max(0, activity.active - 1);
    if (activity.active !== 0) return;
    const waiters = activity.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async waitForClientIdle(client) {
    const activity = this.clientActivity.get(client);
    if (!activity || activity.active === 0) return;
    await new Promise((resolve) => activity.idleWaiters.push(resolve));
  }

  async reconnectBinding(binding, failedClient = binding?.client) {
    const alias = String(binding?.alias || "");
    if (!alias || this.bindings.get(alias) !== binding) {
      const error = new Error(
        `ControllerSessionChanged: alias=${alias || "unknown"}; the active binding is no longer owned by this request.`
      );
      error.code = "ControllerSessionChanged";
      throw error;
    }
    if (binding.closing === true) {
      const error = new Error(
        `ControllerSessionChanged: alias=${alias}; the binding is closing.`
      );
      error.code = "ControllerSessionChanged";
      throw error;
    }
    if (binding.client !== failedClient) return false;
    if (binding.reconnectPromise) {
      await binding.reconnectPromise;
      return false;
    }

    const reconnectPromise = (async () => {
      await this.waitForClientIdle(failedClient);
      if (
        this.bindings.get(alias) !== binding ||
        binding.client !== failedClient ||
        binding.closing === true
      ) {
        const error = new Error(
          `ControllerSessionChanged: alias=${alias}; the failed client is no longer active.`
        );
        error.code = "ControllerSessionChanged";
        throw error;
      }
      try {
        await failedClient.close({ logout: false });
      } catch (error) {
        if (this.bindings.get(alias) === binding) this.bindings.delete(alias);
        throw error;
      }

      let rebound;
      try {
        rebound = await this.openBinding(alias, { bypassCircuit: true });
      } catch (error) {
        if (this.bindings.get(alias) === binding) this.bindings.delete(alias);
        throw error;
      }

      Object.assign(binding, rebound);
      delete binding.noReconnect;
      delete binding.registryStale;
      delete binding.closing;
      this.bindings.set(alias, binding);
      return true;
    })();
    binding.reconnectPromise = reconnectPromise;
    try {
      return await reconnectPromise;
    } finally {
      if (binding.reconnectPromise === reconnectPromise) {
        delete binding.reconnectPromise;
      }
    }
  }

  async binding(alias, { bypassCircuit = false } = {}) {
    this.assertCircuit(alias, bypassCircuit);
    const existing = this.bindings.get(alias);
    if (existing && existing.registryStale !== true && existing.closing !== true) {
      return existing;
    }
    if (existing?.noReconnect === true) {
      const error = new Error(
        `ControllerRegistryChanged: alias=${alias}; create a new identity-locked session.`
      );
      error.code = "ControllerRegistryChanged";
      throw error;
    }
    const pending = this.bindingTransitions.get(alias);
    if (pending) return await pending;

    const transition = (async () => {
      const current = this.bindings.get(alias);
      if (current?.noReconnect === true) {
        const error = new Error(
          `ControllerRegistryChanged: alias=${alias}; create a new identity-locked session.`
        );
        error.code = "ControllerRegistryChanged";
        throw error;
      }
      if (current) await this.closeBinding(alias);
      return this.bindings.get(alias) ||
        await this.createBinding(alias, { bypassCircuit });
    })();
    this.bindingTransitions.set(alias, transition);
    try {
      return await transition;
    } finally {
      if (this.bindingTransitions.get(alias) === transition) {
        this.bindingTransitions.delete(alias);
      }
    }
  }

  async closeBinding(alias, { logout = true } = {}) {
    while (true) {
      const binding = this.bindings.get(alias);
      if (!binding) return;
      binding.closing = true;
      if (binding.reconnectPromise) {
        try {
          await binding.reconnectPromise;
        } catch {}
        continue;
      }
      const client = binding.client;
      await this.waitForClientIdle(client);
      if (
        this.bindings.get(alias) !== binding ||
        binding.client !== client
      ) {
        continue;
      }
      this.bindings.delete(alias);
      await client.close({ logout });
      return;
    }
  }

  async bindingRequest(binding, options, operation, allowed = [200], reconnect = true) {
    if (binding?.noReconnect === true) reconnect = false;
    if (binding?.closing === true) {
      const error = new Error(
        `ControllerSessionChanged: alias=${binding.alias}; the binding is closing.`
      );
      error.code = "ControllerSessionChanged";
      throw error;
    }
    if (binding.reconnectPromise) await binding.reconnectPromise;
    if (this.bindings.get(binding.alias) !== binding || binding.closing === true) {
      const error = new Error(
        `ControllerSessionChanged: alias=${binding.alias}; the active binding changed before the request.`
      );
      error.code = "ControllerSessionChanged";
      throw error;
    }
    binding.lastUsedAt = Date.now();
    const metrics = this.metricsFor(binding.alias);
    try {
      const requestClient = binding.client;
      this.beginClientRequest(requestClient);
      let response;
      try {
        response = await this.withHttpRequestPermit(
          binding.alias,
          async () => await this.readRequest(requestClient, options)
        );
      } finally {
        this.finishClientRequest(requestClient);
      }
      metrics.RequestCount += 1;
      if (response.statusCode === 401 && reconnect) {
        const reconnected = await this.reconnectBinding(binding, requestClient);
        if (reconnected) {
          metrics.ReconnectCount += 1;
          const context = this.readCallContext.getStore();
          if (context) context.reconnectCount += 1;
        }
        return await this.bindingRequest(binding, options, operation, allowed, false);
      }
      if (!allowed.includes(response.statusCode)) {
        const text = String(response.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        throw new RwsHttpError(
          `${operation} failed HTTP ${response.statusCode}${text ? `: ${text}` : ""}`,
          {
            statusCode: response.statusCode,
            method: options.method || "GET",
            url: new URL(options.path, binding.config.baseUrl).href,
            body: response.body
          }
        );
      }
      this.transportFailures.delete(binding.alias);
      return response;
    } catch (error) {
      if (error?.code === "ETIMEDOUT") metrics.TimeoutCount += 1;
      this.registerTransportFailure(binding.alias, error);
      throw error;
    }
  }

  async adapterRead(binding, operation, params = {}, label = operation) {
    const descriptor = binding.adapter.operation(operation, params);
    const response = await this.bindingRequest(
      binding,
      descriptor.request,
      label,
      [200]
    );
    if (operation === "moduleText" && binding.protocol === RWS2) {
      const filePath = rws2ModuleTextFilePath(response);
      if (filePath) {
        const fileResponse = await this.bindingRequest(
          binding,
          {
            method: "GET",
            path: `/fileservice${filePath}`,
            accept: "application/octet-stream;v=2.0"
          },
          `${label} temporary FileService handoff`,
          [200]
        );
        return fileResponse.bytes.toString("utf8");
      }
    }
    return descriptor.parse(response);
  }

  async identityForRead(binding, maxAgeSeconds = 5) {
    const ageMs = Math.max(0, Date.now() - Date.parse(binding.verifiedAt));
    if (binding.identity && ageMs <= maxAgeSeconds * 1_000) {
      return { identity: binding.identity, cacheHit: true, ageMs };
    }
    const identity = await this.adapterRead(
      binding,
      "identity",
      {},
      "Read ABB controller identity"
    );
    this.assertIdentity(identity, binding.config);
    binding.identity = identity;
    binding.verifiedAt = nowIso();
    return { identity, cacheHit: false, ageMs: 0 };
  }

  async controllerState(binding, { parallel = false } = {}) {
    const reads = [
      ["opmode", "Read operation mode"],
      ["ctrlstate", "Read controller state"],
      ["rapidState", "Read RAPID state"]
    ];
    let responses;
    if (parallel) {
      responses = await settledValues(
        reads.map(([operation, label]) =>
          this.adapterRead(binding, operation, {}, label)
        )
      );
    } else {
      responses = [];
      for (const [operation, label] of reads) {
        responses.push(
          await this.adapterRead(binding, operation, {}, label)
        );
      }
    }
    const [opmode, controllerState, rapidState] = responses;
    return {
      Opmode: String(opmode),
      ControllerState: String(controllerState),
      RapidState: String(rapidState)
    };
  }

  async rapidModules(binding, task) {
    return await this.adapterRead(
      binding,
      "modules",
      { task },
      `List RAPID modules for ${task}`
    );
  }

  async rapidModuleText(binding, task, module) {
    return await this.adapterRead(
      binding,
      "moduleText",
      { task, module },
      `Read RAPID module ${task}/${module}`
    );
  }

  async rapidDataValue(binding, task, module, name) {
    return await this.adapterRead(
      binding,
      "rapidData",
      { task, module, name },
      `Read RAPID data ${task}/${module}/${name}`
    );
  }

  async currentRobtarget(binding, task, tool, wobj) {
    assertIdentifier(task, "RAPID task");
    assertIdentifier(tool, "RAPID tool");
    assertIdentifier(wobj, "RAPID work object");
    const response = await this.bindingRequest(
      binding,
      {
        method: "GET",
        path: binding.protocol === RWS2
          ? `/rw/rapid/tasks/${encodeURIComponent(task)}/motion/robtarget` +
            `?tool=${encodeURIComponent(tool)}&wobj=${encodeURIComponent(wobj)}`
          : `/rw/rapid/tasks/${encodeURIComponent(task)}/motion?resource=robtarget` +
            `&tool=${encodeURIComponent(tool)}&wobj=${encodeURIComponent(wobj)}`,
        ...(binding.protocol === RWS2 ? { accept: RWS2_ACCEPT } : {})
      },
      `Read current robtarget for ${task} with ${tool}/${wobj}`
    );
    return binding.protocol === RWS2
      ? parseRapidRobtargetJson(response)
      : parseRapidRobtarget(response.body);
  }

  async configInstance(binding, domain, type, instance) {
    domain = normalizeDomain(domain, this.registry);
    assertIdentifier(type, "configuration type");
    assertInstanceKey(instance, "configuration instance key");
    return await this.adapterRead(
      binding,
      "configInstance",
      { domain, type, instance },
      `Read configuration ${domain}/${type}/${instance}`
    );
  }

  async configInstances(
    binding,
    domain,
    type,
    pageSize = this.pagination.configPageSize,
    maxItems = this.pagination.configMaxItems
  ) {
    domain = normalizeDomain(domain, this.registry);
    assertIdentifier(type, "configuration type");
    pageSize = boundedInteger(pageSize, {
      name: "Configuration pageSize",
      fallback: this.pagination.configPageSize,
      maximum: MAX_PAGE_SIZE
    });
    maxItems = boundedInteger(maxItems, {
      name: "Configuration maxItems",
      fallback: this.pagination.configMaxItems,
      maximum: MAX_PAGINATION_ITEMS
    });
    const result = [];
    const requestLimit = binding.protocol === RWS2
      ? Math.min(10, pageSize, maxItems)
      : Math.min(pageSize, maxItems);
    const params = {
      domain,
      type,
      limit: requestLimit,
      ...(binding.protocol === RWS1 ? { start: 0 } : {})
    };
    const descriptor = binding.adapter.configInstances(params);
    let next = descriptor.request.path;
    const visited = new Set();
    while (next) {
      if (visited.has(next)) {
        throw new Error(`Configuration pagination loop detected: ${domain}/${type}`);
      }
      visited.add(next);
      const response = await this.bindingRequest(
        binding,
        {
          method: "GET",
          path: next,
          ...(binding.protocol === RWS2 ? { accept: RWS2_ACCEPT } : {})
        },
        `List configuration instances ${domain}/${type}`
      );
      const page = descriptor.parse(response);
      if (result.length + page.Instances.length > maxItems) {
        throw new Error(
          `Pagination guard exceeded for ${domain}/${type} at ${maxItems} items. ` +
            `Increase ABB_MCP_CONFIG_MAX_ITEMS (current ${maxItems}, maximum ${MAX_PAGINATION_ITEMS}) ` +
            "only after confirming the expected controller inventory size."
        );
      }
      result.push(...page.Instances);
      if (!page.Next || page.Instances.length === 0) return result;
      next = page.Next;
    }
    return result;
  }

  async exactSignal(binding, name) {
    try {
      const descriptor = binding.adapter.signal({
        network: binding.config.ioNetwork,
        device: binding.config.ioDevice,
        name
      });
      const response = await this.bindingRequest(
        binding,
        descriptor.request,
        `Read I/O signal ${name}`,
        [200]
      );
      const document = parseJson(response, `Read I/O signal ${name}`);
      const item = states(document)[0];
      if (!item || !signalBelongsToBinding(item, binding)) {
        const error = new Error(`I/O signal payload missing: ${name}`);
        error.code = "IoSignalNotFound";
        throw error;
      }
      return descriptor.parse(document);
    } catch (error) {
      if (Number(error?.statusCode) === 404) {
        error.code = "IoSignalNotFound";
      }
      throw error;
    }
  }

  async exactSignals(binding, names) {
    const uniqueNames = [...new Set(names)];
    const maxSockets = Math.max(
      1,
      Math.floor(Number(binding.client?.maxSockets) || 1)
    );
    const results = await mapWithConcurrency(
      uniqueNames,
      Math.min(maxSockets, uniqueNames.length),
      async (name) => {
        try {
          return { signal: await this.exactSignal(binding, name) };
        } catch (error) {
          if (error?.code === "IoSignalNotFound" || Number(error?.statusCode) === 404) {
            return { missing: true };
          }
          throw error;
        }
      }
    );
    const byName = new Map(uniqueNames.map((name, index) => [name, results[index]]));
    const missing = names.filter((name) => byName.get(name).missing);
    if (missing.length) {
      throw new Error(
        `I/O signals not found on ${binding.config.ioNetwork}/${binding.config.ioDevice}: ` +
          missing.join(", ")
      );
    }
    return names.map((name) => byName.get(name).signal);
  }

  async signals(
    binding,
    names,
    pageSize = this.pagination.signalPageSize,
    maxItems = this.pagination.signalMaxItems
  ) {
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error("At least one I/O signal name is required.");
    }
    if (
      binding.protocol === RWS2 ||
      new Set(names).size <= SMALL_SIGNAL_EXACT_THRESHOLD
    ) {
      return await this.exactSignals(binding, names);
    }
    pageSize = boundedInteger(pageSize, {
      name: "Signal pageSize",
      fallback: this.pagination.signalPageSize,
      maximum: MAX_PAGE_SIZE
    });
    maxItems = boundedInteger(maxItems, {
      name: "Signal maxItems",
      fallback: this.pagination.signalMaxItems,
      maximum: MAX_PAGINATION_ITEMS
    });
    const wanted = new Set(names.map((name) => String(name).toLowerCase()));
    const found = new Map();
    let morePages = false;
    for (let start = 0; start < maxItems && found.size < wanted.size; start += pageSize) {
      const requestLimit = Math.min(pageSize, maxItems - start);
      const response = await this.bindingRequest(
        binding,
        {
          method: "GET",
          path: `/rw/iosystem/signals?start=${start}&limit=${requestLimit}&json=1`
        },
        "Bulk-read I/O signals"
      );
      const document = parseJson(response, "Bulk-read I/O signals");
      const page = states(document);
      for (const item of page) {
        const view = ioSignalView(item);
        const key = view.Name.toLowerCase();
        if (!wanted.has(key)) continue;
        if (!signalBelongsToBinding(item, binding)) continue;
        found.set(key, view);
      }
      morePages = Boolean(document?._links?.next && page.length > 0);
      if (!morePages) break;
    }
    if (morePages && found.size < wanted.size) {
      throw new Error(
        `Pagination guard exceeded for I/O signals at ${maxItems} items. ` +
          `Increase ABB_MCP_SIGNAL_MAX_ITEMS (current ${maxItems}, maximum ${MAX_PAGINATION_ITEMS}) ` +
          "only after confirming the expected controller inventory size."
      );
    }
    const missing = names.filter((name) => !found.has(String(name).toLowerCase()));
    if (missing.length) {
      throw new Error(
        `I/O signals not found on ${binding.config.ioNetwork}/${binding.config.ioDevice}: ` +
          missing.join(", ")
      );
    }
    return names.map((name) => found.get(String(name).toLowerCase()));
  }

  async probeController(params) {
    const started = performance.now();
    const credentialAlias = checkedControllerAlias(
      params.credentialAlias,
      "credential alias"
    );
    const credentialConfig = this.config(credentialAlias);
    const rwsProtocol = normalizeRwsProtocol(params.rwsProtocol);
    const certificateSha256 = String(params.certificateSha256 || "")
      .replaceAll(":", "")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (rwsProtocol === RWS2 && !/^[0-9A-F]{64}$/.test(certificateSha256)) {
      throw new Error(
        "RWS2 probe requires the exact 64-hex certificateSha256 captured from this endpoint."
      );
    }
    if (rwsProtocol === RWS1 && certificateSha256) {
      throw new Error("certificateSha256 is accepted only for an explicit RWS2 probe.");
    }
    const candidate = {
      ...credentialConfig,
      baseUrl: String(params.baseUrl),
      rwsProtocol,
      ...(certificateSha256 ? { certificateSha256 } : {}),
      requestTimeoutSeconds: Number(params.requestTimeoutSeconds || 5)
    };
    const client = await this.newClient(candidate);
    try {
      const adapter = new RwsAdapter({ protocol: rwsProtocol });
      const identityOperation = adapter.identity();
      const response = await client.requestOk(
        identityOperation.request,
        "Probe ABB controller identity",
        [200]
      );
      const identity = identityOperation.parse(response);
      const resources = {};
      if (params.includeResources === true) {
        const entries = await mapWithConcurrency([
          ["RapidTasks", "/rw/rapid/tasks"],
          ["IoNetworks", "/rw/iosystem/networks"],
          ["IoDevices", "/rw/iosystem/devices"]
        ], this.maxSockets, async ([key, resourcePath]) => {
          const resource = await client.requestOk({
            method: "GET",
            path: rwsProtocol === RWS1 ? `${resourcePath}?json=1` : resourcePath,
            ...(rwsProtocol === RWS2 ? { accept: RWS2_ACCEPT } : {})
          }, `Discover ${key}`, [200]);
          const document = parseJson(resource, `Discover ${key}`);
          if (document?._links?.next) throw new Error(`Discovery returned incomplete ${key}; pagination is required.`);
          return [key, states(document)];
        });
        Object.assign(resources, Object.fromEntries(entries));
        const verified = identityOperation.parse(await client.requestOk(
          identityOperation.request, "Verify discovered ABB controller identity", [200]
        ));
        if (verified.Name !== identity.Name || verified.SystemId !== identity.SystemId ||
            verified.RobotWare !== identity.RobotWare) {
          throw new Error("CONTROLLER IDENTITY MISMATCH during resource discovery.");
        }
      }
      return {
        Probed: true,
        Endpoint: candidate.baseUrl.replace(/\/+$/, ""),
        CredentialAlias: credentialAlias,
        RwsProtocol: rwsProtocol,
        CertificateSha256: certificateSha256,
        Identity: identity,
        ...resources,
        ElapsedMs: Math.round(performance.now() - started),
        ControllerModified: false
      };
    } finally {
      await client.close();
    }
  }

  async registerController(params) {
    const alias = checkedControllerAlias(params.alias);
    const credentialAlias = checkedControllerAlias(
      params.credentialAlias,
      "credential alias"
    );
    const defaultTask = typeof params.defaultTask === "string"
      ? params.defaultTask
      : "";
    const ioNetwork = typeof params.ioNetwork === "string"
      ? params.ioNetwork
      : "";
    const ioDevice = typeof params.ioDevice === "string"
      ? params.ioDevice
      : "";
    assertIdentifier(defaultTask, "default RAPID task");
    if (!ioNetwork.trim()) throw new Error("ioNetwork must not be empty.");
    if (!ioDevice.trim()) throw new Error("ioDevice must not be empty.");
    const probe = await this.probeController(params);
    const expectedSystemId = normalizeSystemId(params.expectedSystemId);
    if (
      probe.Identity.Name !== String(params.expectedName) ||
      probe.Identity.SystemId !== expectedSystemId ||
      probe.Identity.RobotWare !== String(params.expectedRobotWare)
    ) {
      throw new Error(
        `CONTROLLER IDENTITY MISMATCH: actual=${probe.Identity.Name}/${probe.Identity.SystemId}/` +
          `${probe.Identity.RobotWare}, expected=${params.expectedName}/${expectedSystemId}/` +
          `${params.expectedRobotWare}`
      );
    }
    const credentialConfig = this.config(credentialAlias);
    const beforeSha256 = this.registrySha256;
    this.registry.controllers[alias] = {
      baseUrl: probe.Endpoint,
      // Protocol is an explicit probe input and part of the identity lock. It
      // is never inferred from RobotWare, endpoint, controller model, or alias.
      rwsProtocol: probe.RwsProtocol,
      ...(probe.CertificateSha256
        ? { certificateSha256: probe.CertificateSha256 }
        : {}),
      expectedName: String(params.expectedName),
      expectedSystemId,
      expectedRobotWare: String(params.expectedRobotWare),
      username: String(credentialConfig.username),
      credentialFile: String(credentialConfig.credentialFile),
      defaultTask,
      ioNetwork,
      ioDevice,
      requestTimeoutSeconds: Number(params.requestTimeoutSeconds || 5),
      longRequestTimeoutSeconds: Number(params.longRequestTimeoutSeconds || 60)
    };
    const currentBytes = await readFile(this.registryPath);
    if (sha256Bytes(currentBytes) !== beforeSha256) {
      throw new Error("Controller registry changed during registration. Probe again.");
    }
    const temporary = `${this.registryPath}.${crypto.randomUUID().replaceAll("-", "")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.registry, null, 2)}\n`, "utf8");
    await atomicReplace(temporary, this.registryPath);
    const elapsedMs = Math.round(probe.ElapsedMs);
    return {
      Registered: true,
      Alias: alias,
      CredentialAlias: credentialAlias,
      Endpoint: probe.Endpoint,
      RwsProtocol: this.registry.controllers[alias].rwsProtocol,
      CertificateSha256: String(
        this.registry.controllers[alias].certificateSha256 || ""
      ),
      Identity: probe.Identity,
      RequestTimeoutSeconds: this.registry.controllers[alias].requestTimeoutSeconds,
      LongRequestTimeoutSeconds: this.registry.controllers[alias].longRequestTimeoutSeconds,
      ProbeElapsedMs: elapsedMs,
      ElapsedMs: elapsedMs,
      RegistryReloadOnNextCall: true,
      ControllerModified: false
    };
  }

  async invoke(method, params = {}, context = {}) {
    const registryReloaded = method === "health" ? false : await this.reloadRegistry();
    if (isDirectBackupMethod(method)) {
      const backups = await this.ensureBackups();
      return await backups.call(method, params, context);
    }
    switch (method) {
      case "health": {
        await this.reloadRegistry();
        const version = "1.7.0";
        let diskVersion = null;
        let versionCheckError;
        try {
          diskVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
          if (typeof diskVersion !== "string" || !diskVersion) throw new Error("Package version is missing.");
        } catch (error) {
          diskVersion = null;
          versionCheckError = error.message;
        }
        return {
          ok: true,
          service: "abb-direct-rws",
          version,
          diskVersion,
          restartRequired: diskVersion !== null && diskVersion !== version,
          ...(versionCheckError ? { versionCheckError } : {}),
          backend: "direct-rws",
          runtime: process.version,
          powershell: "not used",
          pid: process.pid
        };
      }
      case "list_controllers":
        return {
          RegistryReloaded: registryReloaded,
          Controllers: Object.entries(this.registry.controllers || {}).map(([alias, config]) => ({
            Alias: alias,
            Endpoint: String(config.baseUrl),
            RwsProtocol: String(config.rwsProtocol || ""),
            CertificateSha256: String(config.certificateSha256 || ""),
            ExpectedName: String(config.expectedName),
            ExpectedSystemId: normalizeSystemId(config.expectedSystemId),
            RobotWare: String(config.expectedRobotWare)
          }))
        };
      case "probe_controller":
        return await this.probeController(params);
      case "register_controller":
        return await this.registerController(params);
      case "bind": {
        const alias = String(params.alias);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const alreadyBound = this.bindings.has(alias);
        const binding = await this.binding(alias);
        const identityRead = alreadyBound
          ? await this.identityForRead(binding, 30)
          : { identity: binding.identity, cacheHit: false, ageMs: 0 };
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Bound: true,
          Alias: alias,
          Endpoint: String(binding.config.baseUrl),
          RwsProtocol: binding.protocol,
          CertificateSha256: String(binding.config.certificateSha256 || ""),
          Identity: identityRead.identity,
          BoundAt: binding.boundAt,
          VerifiedAt: binding.verifiedAt,
          IdentityCacheHit: identityRead.cacheHit,
          IdentityAgeMs: Math.round(identityRead.ageMs),
          ReusedSession: after.SessionCreateCount - before.SessionCreateCount === 0,
          RegistryReloaded: registryReloaded,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          SessionCreateDelta: after.SessionCreateCount - before.SessionCreateCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "disconnect": {
        const alias = String(params.alias);
        await this.closeBinding(alias);
        this.transportFailures.delete(alias);
        return { Disconnected: true, Alias: alias };
      }
      case "disconnect_idle": {
        const idleSeconds = Number(params.idleSeconds || 180);
        if (idleSeconds < 30) throw new Error("idleSeconds must be at least 30.");
        const cutoff = Date.now() - idleSeconds * 1_000;
        const aliases = [];
        const busyAliases = [];
        for (const alias of [...this.bindings.keys()]) {
          try {
            const disconnected = await this.runInAliasQueue(
              alias,
              context.queueTimeoutMs,
              async () => {
                const binding = this.bindings.get(alias);
                if (!binding || binding.lastUsedAt > cutoff) return false;
                await this.closeBinding(alias);
                return true;
              }
            );
            if (disconnected) aliases.push(alias);
          } catch (error) {
            if (error?.code !== "WorkerBusy") throw error;
            busyAliases.push(alias);
          }
        }
        return {
          Disconnected: aliases.length > 0,
          Count: aliases.length,
          Aliases: aliases,
          BusyCount: busyAliases.length,
          BusyAliases: busyAliases,
          IdleSeconds: idleSeconds,
          CheckedAtUtc: nowIso()
        };
      }
      case "snapshot": {
        const alias = String(params.alias);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const identityRead = await this.identityForRead(binding, 5);
        const task = rapidTaskForRead(binding, undefined);
        const [state, modules, network] = await settledValues([
          this.controllerState(binding, { parallel: true }),
          this.rapidModules(binding, task),
          this.configInstance(
            binding,
            "eio",
            "INDUSTRIAL_NETWORK",
            String(binding.config.ioNetwork)
          )
        ]);
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Endpoint: String(binding.config.baseUrl),
          Identity: identityRead.identity,
          IdentityCacheHit: identityRead.cacheHit,
          IdentityAgeMs: Math.round(identityRead.ageMs),
          State: state,
          RapidModules: modules,
          IndustrialNetwork: network.Attributes,
          Session: {
            BoundAt: binding.boundAt,
            Metrics: after,
            RequestDelta: after.RequestCount - before.RequestCount,
            ReconnectDelta: after.ReconnectCount - before.ReconnectCount
          },
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "read_signals": {
        const alias = String(params.alias);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const result = await this.signals(binding, params.names.map(String));
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Signals: result,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "list_modules": {
        const alias = String(params.alias);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const task = rapidTaskForRead(binding, params.task);
        const modules = await this.rapidModules(binding, task);
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Task: task,
          Modules: modules,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "list_config_instances": {
        const alias = String(params.alias);
        const domain = normalizeDomain(params.domain, this.registry);
        const type = String(params.type);
        const filterAttribute = String(params.filterAttribute || "");
        const prefix = String(params.prefix || "");
        assertIdentifier(type, "configuration type");
        if (filterAttribute) assertIdentifier(filterAttribute, "configuration filter attribute");
        if (!filterAttribute && prefix) throw new Error("prefix requires filterAttribute.");
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        let instances = await this.configInstances(binding, domain, type);
        if (filterAttribute) {
          instances = instances.filter((item) =>
            String(item.Attributes[filterAttribute] || "")
              .toLowerCase()
              .startsWith(prefix.toLowerCase())
          );
        }
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Domain: domain,
          Type: type,
          FilterAttribute: filterAttribute,
          Prefix: prefix,
          Count: instances.length,
          Instances: instances,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "read_config_instance": {
        const alias = String(params.alias);
        const domain = normalizeDomain(params.domain, this.registry);
        const type = String(params.type);
        const instance = String(params.instance);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const result = await this.configInstance(binding, domain, type, instance);
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Domain: domain,
          Type: type,
          Instance: result,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "read_module": {
        const alias = String(params.alias);
        const module = String(params.module);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const task = rapidTaskForRead(binding, params.task);
        const text = await this.rapidModuleText(binding, task, module);
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Task: task,
          Module: module,
          SourceSha256: sha256(text),
          Text: text,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "read_rapid_data": {
        const alias = String(params.alias);
        const module = String(params.module);
        const name = String(params.name);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const task = rapidTaskForRead(binding, params.task);
        const value = await this.rapidDataValue(binding, task, module, name);
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Task: task,
          Module: module,
          Name: name,
          Value: value,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started)
        };
      }
      case "read_current_robtarget": {
        const alias = String(params.alias);
        const started = performance.now();
        const before = copyMetrics(this.metricsFor(alias));
        const binding = await this.binding(alias);
        const task = rapidTaskForRead(binding, params.task);
        const tool = String(params.tool);
        const wobj = String(params.wobj);
        const robtarget = await this.currentRobtarget(
          binding,
          task,
          tool,
          wobj
        );
        const after = copyMetrics(this.metricsFor(alias));
        return {
          Alias: alias,
          Endpoint: String(binding.config.baseUrl),
          Identity: binding.identity,
          Task: task,
          Tool: tool,
          WorkObject: wobj,
          ...robtarget,
          Metrics: after,
          RequestDelta: after.RequestCount - before.RequestCount,
          ReconnectDelta: after.ReconnectCount - before.ReconnectCount,
          ElapsedMs: Math.round(performance.now() - started),
          ControllerModified: false
        };
      }
      default:
        throw new Error(`Direct RWS method is not implemented: ${method}`);
    }
  }

  async call(
    method,
    params = {},
    timeoutMs = 60_000,
    queueTimeoutMs = 2_000,
    onProgress = null
  ) {
    if (directMethodLockMode(method) === "read") {
      const started = performance.now();
      const context = {
        deadlineAt: Date.now() + timeoutMs,
        requestCount: 0,
        reconnectCount: 0,
        queueWaitMs: 0,
        httpElapsedMs: 0
      };
      return await this.readCallContext.run(context, async () => {
        const result = await this.callCore(method, params, timeoutMs, queueTimeoutMs, onProgress);
        remainingReadTime(context.deadlineAt);
        return {
          ...result,
          RequestDelta: context.requestCount,
          ReconnectDelta: context.reconnectCount,
          ...(result.Session ? {
            Session: { ...result.Session,
              RequestDelta: context.requestCount, ReconnectDelta: context.reconnectCount }
          } : {}),
          QueueWaitMs: Math.round(context.queueWaitMs),
          HttpElapsedMs: Math.round(context.httpElapsedMs),
          ElapsedMs: Math.round(performance.now() - started)
        };
      });
    }
    return await this.callCore(method, params, timeoutMs, queueTimeoutMs, onProgress);
  }

  async callCore(method, params, timeoutMs, queueTimeoutMs, onProgress) {
    if (!this.acceptingCalls || this.closed) {
      throw new Error("ABB direct RWS service is closing or closed.");
    }
    this.activeCalls += 1;
    try {
      let alias = params?.alias === undefined ? "" : String(params.alias);
      if (!alias && isDirectBackupMethod(method)) {
        if (!this.registry) await this.reloadRegistry();
        const backups = await this.ensureBackups();
        alias = await backups.aliasFor(method, params);
      }
      const context = { timeoutMs, queueTimeoutMs, onProgress };
      if (!alias) return await this.invoke(method, params, context);
      let protocol;
      if (method === "read_signals" && new Set(params.names).size > SMALL_SIGNAL_EXACT_THRESHOLD) {
        await this.reloadRegistry();
        protocol = this.registry.controllers?.[alias]?.rwsProtocol ?? this.bindings.get(alias)?.protocol;
      }
      return await this.runWithAliasLock(
        alias,
        directMethodLockMode(method),
        queueTimeoutMs,
        async () => await this.invoke(method, params, context),
        directMethodRequestWeight(method, params, this.maxSockets, protocol)
      );
    } finally {
      this.finishCall();
    }
  }

  aliasLock(alias) {
    alias = String(alias);
    let lock = this.aliasLocks.get(alias);
    if (!lock) {
      lock = new AliasReadWriteLock(alias, this.maxSockets);
      this.aliasLocks.set(alias, lock);
    }
    return lock;
  }

  async runWithAliasLock(
    alias,
    mode,
    queueTimeoutMs,
    operation,
    requestWeight = mode === "write" ? this.maxSockets : 1
  ) {
    if (this.closed) throw new Error("ABB direct RWS service is closed.");
    alias = String(alias);
    if (!alias) throw new Error("ABB controller alias is required.");
    if (typeof operation !== "function") {
      throw new Error("ABB queued operation must be a function.");
    }
    const lock = this.aliasLock(alias);
    let release = null;
    try {
      const reservedRequests = mode === "write" ? this.maxSockets : requestWeight;
      const context = this.readCallContext.getStore();
      const queueStarted = performance.now();
      release = await lock.acquire(mode, queueTimeoutMs, reservedRequests, context?.deadlineAt);
      if (context) context.queueWaitMs += performance.now() - queueStarted;
      remainingReadTime(context?.deadlineAt);
      const requests = new RequestSemaphore(
        reservedRequests,
        `ABB alias '${alias}' operation request reservation`
      );
      return await this.httpRequestContext.run(
        { alias, requests },
        operation
      );
    } finally {
      release?.();
      if (lock.idle && this.aliasLocks.get(alias) === lock) {
        this.aliasLocks.delete(alias);
      }
    }
  }

  async runInAliasQueue(alias, queueTimeoutMs, operation) {
    return await this.runWithAliasLock(
      alias,
      "write",
      queueTimeoutMs,
      operation
    );
  }

  async runSerialized(alias, operation, queueTimeoutMs = 2_000) {
    if (!this.acceptingCalls || this.closed) {
      throw new Error("ABB direct RWS service is closing or closed.");
    }
    this.activeCalls += 1;
    try {
      return await this.runInAliasQueue(alias, queueTimeoutMs, operation);
    } finally {
      this.finishCall();
    }
  }

  async close() {
    if (this.closePromise) return await this.closePromise;
    this.acceptingCalls = false;
    this.closePromise = (async () => {
      await this.waitForDrain();
      this.closed = true;
      const aliases = [...this.bindings.keys()];
      for (const alias of aliases) await this.closeBinding(alias);
      if (this.backupsReady) {
        try {
          await this.backupsReady;
        } catch {}
      }
      this.backups?.close();
      this.credentialProvider.clear();
      this.httpRequestSemaphores.clear();
    })();
    return await this.closePromise;
  }
}

export {
  DIRECT_METHODS,
  controllerSignature,
  metricDelta,
  normalizeSystemId,
  parseRapidRobtarget,
  sha256Bytes
};
