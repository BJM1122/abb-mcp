import crypto from "node:crypto";

import {
  RWS1,
  RWS2,
  RWS2_ACCEPT,
  RwsAdapter,
  normalizeRwsProtocol,
  rws2ModuleTextFilePath
} from "./rws-adapter.mjs";
import {
  controllerSignature,
  normalizeSystemId,
  sha256Bytes
} from "./service.mjs";
import { changesetPolicySnapshot } from "./changeset-policy.mjs";

const DUAL_PROTOCOL = "rws1+rws2";
const SESSION_KIND = "abb-direct-rws-changeset-session";
const SAFE_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_ALIASES = new Set(["__proto__", "prototype", "constructor"]);
const NORMAL_TIMEOUT_SECONDS = 5;
const LONG_TIMEOUT_SECONDS = 60;
const RESTART_REQUEST_TIMEOUT_MS = 15_000;
const RESTART_POLL_MS = 2_000;
const RESTART_SETTLE_MS = 4_000;
const RESTART_ONLINE_CHECKS = 2;

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function checkedAlias(value) {
  const alias = text(value);
  if (
    alias !== alias.trim() ||
    !SAFE_ALIAS.test(alias) ||
    FORBIDDEN_ALIASES.has(alias.toLowerCase())
  ) {
    throw new Error(`Unsafe ABB controller alias: ${alias}`);
  }
  return alias;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => `${JSON.stringify(name)}:${stableJson(value[name])}`)
    .join(",")}}`;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(text(value), "utf8").digest("hex");
}

function canonicalEndpoint(value) {
  const raw = text(value).trim();
  if (!raw) throw new Error("ABB controller endpoint is required.");
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Unsafe ABB controller endpoint: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/") {
    throw new Error(
      `ABB controller endpoint must not contain a base path: ${raw}`
    );
  }
  return `${url.protocol}//${url.host}`;
}

function timeoutMilliseconds(value, fallbackSeconds) {
  const seconds = Number(value ?? fallbackSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error(`Invalid ABB RWS timeout seconds: ${value}`);
  }
  return Math.max(1, Math.round(seconds * 1_000));
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("now() returned an invalid time.");
  }
  return milliseconds;
}

function responseStatus(response) {
  return Number(
    response?.statusCode ??
      response?.StatusCode ??
      response?.status ??
      0
  );
}

function isTransportFailure(error) {
  return (
    [
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "UND_ERR_SOCKET"
    ].includes(error?.code) ||
    /timed out|timeout|connection reset|connection refused|network is unreachable|host is unreachable|socket hang up/i.test(
      error?.message || ""
    )
  );
}

function isRestartOfflineError(error) {
  if (isTransportFailure(error)) return true;
  const statusCode = Number(error?.statusCode ?? 0);
  return statusCode >= 500 && statusCode <= 599;
}

function copyMetrics(metrics = {}) {
  return {
    RequestCount: Number(metrics.RequestCount || 0),
    SessionCreateCount: Number(metrics.SessionCreateCount || 0),
    ReconnectCount: Number(metrics.ReconnectCount || 0),
    TimeoutCount: Number(metrics.TimeoutCount || 0),
    TransportFailureCount: Number(metrics.TransportFailureCount || 0),
    CircuitFastFailCount: Number(metrics.CircuitFastFailCount || 0)
  };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Bridges DirectRwsService internals to DirectChangesetPlanner and
 * DirectChangesetExecutor without adding a second transport or a shell layer.
 *
 * A changeset session pins one explicitly registered RWS1 or RWS2 service
 * binding and sets binding.noReconnect=true. This adapter never asks
 * DirectRwsService to replace a session or replay a request after a transport
 * failure.
 */
export class DirectChangesetServiceAdapter {
  constructor({
    service,
    protocol,
    policy = null,
    now = () => Date.now(),
    sleep = defaultSleep,
    restartPollMs = RESTART_POLL_MS,
    restartSettleMs = RESTART_SETTLE_MS,
    restartOnlineChecks = RESTART_ONLINE_CHECKS
  } = {}) {
    if (!service || typeof service !== "object") {
      throw new Error("DirectChangesetServiceAdapter requires DirectRwsService.");
    }
    for (const method of [
      "reloadRegistry",
      "config",
      "binding",
      "createBinding",
      "closeBinding",
      "metricsFor"
    ]) {
      if (typeof service[method] !== "function") {
        throw new Error(`DirectRwsService is missing method: ${method}`);
      }
    }
    const selectedProtocol = text(protocol).toLowerCase();
    this.allowedProtocols = selectedProtocol === DUAL_PROTOCOL || selectedProtocol === "auto"
      ? new Set([RWS1, RWS2])
      : new Set([normalizeRwsProtocol(selectedProtocol)]);
    if (typeof now !== "function" || typeof sleep !== "function") {
      throw new Error("now and sleep must be functions.");
    }
    if (
      !Number.isSafeInteger(restartPollMs) ||
      restartPollMs < 1 ||
      !Number.isSafeInteger(restartSettleMs) ||
      restartSettleMs < 0 ||
      !Number.isSafeInteger(restartOnlineChecks) ||
      restartOnlineChecks < 1
    ) {
      throw new Error("Invalid restart state-machine timing configuration.");
    }

    this.service = service;
    this.protocol = this.allowedProtocols.size === 2
      ? DUAL_PROTOCOL
      : [...this.allowedProtocols][0];
    this.policy = policy === null || policy === undefined
      ? null
      : changesetPolicySnapshot(policy);
    this.readAdapters = new Map([
      [RWS1, new RwsAdapter({ protocol: RWS1 })],
      [RWS2, new RwsAdapter({ protocol: RWS2 })]
    ]);
    this.now = now;
    this.sleep = sleep;
    this.restartPollMs = restartPollMs;
    this.restartSettleMs = restartSettleMs;
    this.restartOnlineChecks = restartOnlineChecks;
    this.sessions = new Set();
    this.closed = false;

    this.readApi = Object.freeze({
      getMetrics: (args) => this.getMetrics(args),
      metrics: (args) => this.getMetrics(args),
      getIdentity: (args) => this.getIdentity(args),
      identity: (args) => this.getIdentity(args),
      getControllerState: (args) => this.getControllerState(args),
      controllerState: (args) => this.getControllerState(args),
      getConfigInstances: (args) => this.getConfigInstances(args),
      listConfigInstances: (args) => this.getConfigInstances(args),
      getConfigInstance: (args) => this.getConfigInstance(args),
      getRapidModules: (args) => this.getRapidModules(args),
      listRapidModules: (args) => this.getRapidModules(args),
      getRapidModuleText: (args) => this.getRapidModuleText(args),
      getRapidDataValue: (args) => this.getRapidDataValue(args),
      getIoSignal: (args) => this.getIoSignal(args),
      getSignal: (args) => this.getIoSignal(args),
      readSignal: (args) => this.getIoSignal(args)
    });

    this.sessionApi = Object.freeze({
      openSession: (args) => this.openSession(args),
      closeSession: (args) => this.closeSession(args),
      executeDescriptor: (args) => this.executeDescriptor(args),
      waitForRestart: (args) => this.waitForRestart(args)
    });
  }

  assertOpen() {
    if (this.closed) {
      throw new Error("Direct changeset service adapter is closed.");
    }
  }

  async controllerLock(controller) {
    this.assertOpen();
    const alias = checkedAlias(controller);
    await this.service.reloadRegistry();
    const config = this.service.config(alias);
    const configuredProtocol = normalizeRwsProtocol(
      config.rwsProtocol ?? config.protocol
    );
    if (!this.allowedProtocols.has(configuredProtocol)) {
      throw new Error(
        `Registered controller '${alias}' uses ${configuredProtocol}, which is ` +
          `outside this changeset stack's ${this.protocol} protocol lock.`
      );
    }

    const endpoint = canonicalEndpoint(config.baseUrl);
    const expected = {
      Name: text(config.expectedName),
      SystemId: normalizeSystemId(config.expectedSystemId),
      RobotWare: text(config.expectedRobotWare)
    };
    if (!expected.Name || !expected.SystemId || !expected.RobotWare) {
      throw new Error(
        `Registered controller '${alias}' is missing its exact identity lock.`
      );
    }

    const globalPolicy = this.policy ??
      changesetPolicySnapshot(this.service.registry);
    const signaturePayload = {
      protocol: configuredProtocol,
      controller: JSON.parse(controllerSignature(config)),
      policy: globalPolicy
    };
    const controllerSignatureSha256 = sha256Text(
      stableJson(signaturePayload)
    );
    const controllerLock = sha256Text(
      stableJson({
        alias,
        endpoint,
        name: expected.Name,
        systemId: expected.SystemId,
        robotWare: expected.RobotWare,
        protocol: configuredProtocol,
        controllerSignatureSha256
      })
    );
    const registrySha256 =
      text(this.service.registrySha256) ||
      sha256Bytes(
        Buffer.from(stableJson(this.service.registry ?? {}), "utf8")
      );
    return {
      Alias: alias,
      Endpoint: endpoint,
      Name: expected.Name,
      SystemId: expected.SystemId,
      RobotWare: expected.RobotWare,
      Protocol: configuredProtocol,
      RegistrySha256: registrySha256,
      ControllerSignature: controllerSignatureSha256,
      ControllerLock: controllerLock,
      Config: config
    };
  }

  assertLiveIdentity(identity, lock) {
    if (
      text(identity?.Name) !== lock.Name ||
      normalizeSystemId(identity?.SystemId) !== lock.SystemId
    ) {
      throw new Error(
        `CONTROLLER IDENTITY MISMATCH: actual=${text(identity?.Name)}/` +
          `${normalizeSystemId(identity?.SystemId)}, expected=${lock.Name}/` +
          `${lock.SystemId}`
      );
    }
    if (text(identity?.RobotWare) !== lock.RobotWare) {
      throw new Error(
        `ROBOTWARE MISMATCH: actual=${text(identity?.RobotWare)}, ` +
          `expected=${lock.RobotWare}`
      );
    }
  }

  unwrapSession(session, controller) {
    if (
      !session ||
      session.kind !== SESSION_KIND ||
      !this.sessions.has(session) ||
      session.closed
    ) {
      throw new Error("Invalid or closed direct changeset session.");
    }
    const alias = checkedAlias(controller ?? session.controller);
    if (alias !== session.controller) {
      throw new Error(
        `Changeset session controller mismatch: ${alias}/${session.controller}`
      );
    }
    if (
      !this.allowedProtocols.has(session.protocol) ||
      session.binding?.protocol !== session.protocol ||
      session.binding?.noReconnect !== true
    ) {
      throw new Error("Changeset session lost its protocol/no-reconnect lock.");
    }
    return session;
  }

  async assertSessionCurrent(session, { allowChangedRegistry = false } = {}) {
    const current = await this.controllerLock(session.controller);
    if (
      !allowChangedRegistry &&
      (
        current.Endpoint !== session.Endpoint ||
        current.ControllerLock !== session.ControllerLock
      )
    ) {
      throw new Error(
        "Registered ABB endpoint or controller signature changed after the " +
          "changeset session was opened. Create a new plan."
      );
    }
    if (session.binding?.client?.closed) {
      throw new Error("Direct changeset RWS session is closed.");
    }
    return current;
  }

  async resolveBinding({ controller, session } = {}) {
    const alias = checkedAlias(controller);
    if (session !== undefined && session !== null) {
      return this.unwrapSession(session, alias).binding;
    }
    return await this.service.binding(alias, { bypassCircuit: true });
  }

  async readOperation(binding, operation, params = {}) {
    const adapter = this.readAdapters.get(binding.protocol);
    if (!adapter) throw new Error(`Unsupported binding protocol: ${binding.protocol}`);
    const descriptor = adapter.operation(operation, params);
    const response = await this.service.bindingRequest(
      binding,
      descriptor.request,
      `Changeset read ${operation}`,
      [200],
      false
    );
    if (operation === "moduleText" && binding.protocol === RWS2) {
      const filePath = rws2ModuleTextFilePath(response);
      if (filePath) {
        const fileResponse = await this.service.bindingRequest(
          binding,
          {
            method: "GET",
            path: `/fileservice${filePath}`,
            accept: "application/octet-stream;v=2.0"
          },
          "Changeset read moduleText temporary FileService handoff",
          [200],
          false
        );
        return fileResponse.bytes.toString("utf8");
      }
    }
    return descriptor.parse(response);
  }

  async getMetrics({ controller } = {}) {
    this.assertOpen();
    return copyMetrics(this.service.metricsFor(checkedAlias(controller)));
  }

  async getIdentity({ controller, session } = {}) {
    const alias = checkedAlias(controller);
    const lock = session
      ? await this.assertSessionCurrent(this.unwrapSession(session, alias))
      : await this.controllerLock(alias);
    const binding = await this.resolveBinding({ controller: alias, session });
    const identity = await this.readOperation(binding, "identity");
    this.assertLiveIdentity(identity, lock);
    return {
      Name: lock.Name,
      SystemId: lock.SystemId,
      RobotWare: lock.RobotWare,
      Endpoint: lock.Endpoint,
      Protocol: lock.Protocol,
      RegistrySha256: lock.RegistrySha256,
      ControllerSignature: lock.ControllerSignature,
      ControllerLock: lock.ControllerLock
    };
  }

  async getControllerState({ controller, session } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    // Keep the three reads sequential inside the same authenticated session.
    // ABB controllers have a low session/socket budget, and a single Digest
    // nonce sequence should not be raced by concurrent state requests.
    const opmode = await this.readOperation(binding, "opmode");
    const controllerState = await this.readOperation(binding, "ctrlstate");
    const rapidState = await this.readOperation(binding, "rapidState");
    return {
      Opmode: text(opmode),
      ControllerState: text(controllerState),
      RapidState: text(rapidState)
    };
  }

  async getConfigInstances({
    controller,
    session,
    domain,
    type,
    pageSize = 70
  } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    const limit = Number(pageSize);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error("Configuration pageSize must be an integer from 1 to 5000.");
    }
    const output = [];
    const adapter = this.readAdapters.get(binding.protocol);
    const params = {
      domain,
      type,
      limit: binding.protocol === RWS2 ? Math.min(limit, 10) : limit,
      ...(binding.protocol === RWS1 ? { start: 0 } : {})
    };
    const descriptor = adapter.operation("configInstances", params);
    let next = descriptor.request.path;
    const visited = new Set();
    while (next) {
      if (visited.has(next)) {
        throw new Error(`Configuration pagination loop detected: ${domain}/${type}`);
      }
      visited.add(next);
      const response = await this.service.bindingRequest(
        binding,
        {
          method: "GET",
          path: next,
          ...(binding.protocol === RWS2 ? { accept: RWS2_ACCEPT } : {})
        },
        "Changeset read configInstances",
        [200],
        false
      );
      const page = descriptor.parse(response);
      output.push(...page.Instances);
      if (!page.Next || page.Instances.length === 0) return output;
      if (output.length > 5_000) break;
      next = page.Next;
    }
    throw new Error(`Configuration pagination guard exceeded: ${domain}/${type}`);
  }

  async getConfigInstance({
    controller,
    session,
    domain,
    type,
    instance,
    allowMissing = false
  } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    try {
      return await this.readOperation(binding, "configInstance", {
        domain,
        type,
        instance
      });
    } catch (error) {
      if (allowMissing && Number(error?.statusCode) === 404) return null;
      throw error;
    }
  }

  async getRapidModules({ controller, session, task } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    return await this.readOperation(binding, "modules", { task });
  }

  async getRapidModuleText({
    controller,
    session,
    task,
    module,
    allowMissing = false
  } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    try {
      return await this.readOperation(binding, "moduleText", {
        task,
        module
      });
    } catch (error) {
      if (allowMissing && Number(error?.statusCode) === 404) return null;
      throw error;
    }
  }

  async getRapidDataValue({
    controller,
    session,
    task,
    module,
    name
  } = {}) {
    const binding = await this.resolveBinding({ controller, session });
    return await this.readOperation(binding, "rapidData", {
      task,
      module,
      name
    });
  }

  async getIoSignal({ controller, session, name } = {}) {
    const alias = checkedAlias(controller);
    const binding = await this.resolveBinding({ controller: alias, session });
    return await this.readOperation(binding, "signal", {
      network: binding.config.ioNetwork,
      device: binding.config.ioDevice,
      name
    });
  }

  async openSession({
    controller,
    fresh = false,
    bypassCircuit = true
  } = {}) {
    this.assertOpen();
    const alias = checkedAlias(controller);
    const lock = await this.controllerLock(alias);
    if (fresh) {
      await this.service.closeBinding(alias, { logout: true });
    }
    const binding = fresh
      ? await this.service.createBinding(alias, { bypassCircuit })
      : await this.service.binding(alias, { bypassCircuit });
    if (binding.protocol !== lock.Protocol) {
      throw new Error(
        `Changeset binding protocol mismatch: binding=${binding.protocol}, ` +
          `registry=${lock.Protocol}`
      );
    }
    binding.noReconnect = true;

    const session = {
      kind: SESSION_KIND,
      protocol: lock.Protocol,
      controller: alias,
      binding,
      Endpoint: lock.Endpoint,
      RegistrySha256: lock.RegistrySha256,
      ControllerSignature: lock.ControllerSignature,
      ControllerLock: lock.ControllerLock,
      mastershipHeld: false,
      openedAtMs: clockMilliseconds(this.now),
      closed: false
    };
    this.sessions.add(session);
    return session;
  }

  async closeSession({
    controller,
    session,
    logout = true
  } = {}) {
    const wrapped = this.unwrapSession(session, controller);
    if (wrapped.mastershipHeld && logout !== true) {
      throw new Error(
        "Cannot close a mastership-holding changeset session without logout."
      );
    }
    wrapped.closed = true;
    wrapped.mastershipHeld = false;
    this.sessions.delete(wrapped);

    const active = this.service.bindings?.get(wrapped.controller);
    if (active === wrapped.binding) {
      await this.service.closeBinding(wrapped.controller, { logout });
      return;
    }
    await wrapped.binding.client.close({ logout });
  }

  descriptorTimeout(binding, descriptor) {
    const normal = timeoutMilliseconds(
      binding.config.requestTimeoutSeconds,
      NORMAL_TIMEOUT_SECONDS
    );
    const long = timeoutMilliseconds(
      binding.config.longRequestTimeoutSeconds,
      LONG_TIMEOUT_SECONDS
    );
    if (descriptor.operation === "ordinaryRestart") {
      return Math.min(long, RESTART_REQUEST_TIMEOUT_MS);
    }
    return descriptor.timeoutClass === "long" ? long : normal;
  }

  async executeDescriptor({
    controller,
    session,
    descriptor,
    request
  } = {}) {
    const wrapped = this.unwrapSession(session, controller);
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      descriptor.protocol !== wrapped.protocol ||
      !descriptor.request ||
      typeof descriptor.parse !== "function"
    ) {
      throw new Error("Invalid or cross-protocol changeset request descriptor.");
    }
    if (
      request &&
      (
        text(request.method).toUpperCase() !==
          text(descriptor.request.method).toUpperCase() ||
        text(request.path) !== text(descriptor.request.path)
      )
    ) {
      throw new Error("Changeset descriptor request changed before execution.");
    }
    if (
      descriptor.requiresMastership === true &&
      wrapped.mastershipHeld !== true
    ) {
      throw new Error(
        `${descriptor.operation} requires mastership in the same RWS session.`
      );
    }
    if (
      descriptor.operation === "mastershipRequest" &&
      wrapped.mastershipHeld === true
    ) {
      throw new Error("ABB mastership was requested twice in one session.");
    }
    if (
      descriptor.mutating === true &&
      descriptor.operation !== "mastershipRelease"
    ) {
      await this.assertSessionCurrent(wrapped);
    }

    const options = {
      ...descriptor.request,
      timeoutMs: this.descriptorTimeout(wrapped.binding, descriptor)
    };
    const metrics = this.service.metricsFor(wrapped.controller);
    let response;
    try {
      // Call the pinned session client directly. RWS1 may answer its initial
      // Digest challenge; neither protocol gets a service reconnect or a
      // transport retry for this descriptor.
      response = await wrapped.binding.client.request(options);
      metrics.RequestCount += 1;
      this.service.transportFailures?.delete(wrapped.controller);
    } catch (error) {
      if (error?.code === "ETIMEDOUT") metrics.TimeoutCount += 1;
      this.service.registerTransportFailure?.(wrapped.controller, error);
      throw error;
    }

    const statusCode = responseStatus(response);
    if (
      descriptor.operation === "mastershipRequest" &&
      descriptor.allowedStatusCodes.includes(statusCode)
    ) {
      wrapped.mastershipHeld = true;
    }
    if (
      descriptor.operation === "mastershipRelease" &&
      descriptor.allowedStatusCodes.includes(statusCode)
    ) {
      wrapped.mastershipHeld = false;
    }
    return response;
  }

  async waitForRestart({
    controller,
    timeoutSeconds,
    requestResult,
    requestError = "",
    transportUnknown = false
  } = {}) {
    this.assertOpen();
    const alias = checkedAlias(controller);
    const timeoutMs = timeoutMilliseconds(timeoutSeconds, 30);
    const acknowledged =
      requestResult?.Accepted === true &&
      responseStatus(requestResult) >= 200 &&
      responseStatus(requestResult) < 300;
    if (!acknowledged && transportUnknown !== true) {
      throw new Error(
        "Ordinary restart wait requires either a definitive 2xx response or " +
          "an explicitly unknown transport outcome."
      );
    }

    const startedAt = clockMilliseconds(this.now);
    const deadline = startedAt + timeoutMs;
    let offlineObserved = false;
    let consecutiveOnlineChecks = 0;
    let checks = 0;
    let lastError = text(requestError);

    while (clockMilliseconds(this.now) < deadline) {
      const remaining = deadline - clockMilliseconds(this.now);
      await this.sleep(Math.min(this.restartPollMs, remaining));
      checks += 1;
      let session = null;
      try {
        session = await this.openSession({
          controller: alias,
          fresh: true,
          bypassCircuit: true
        });
        await this.getIdentity({ controller: alias, session });
        const elapsedMs = clockMilliseconds(this.now) - startedAt;

        if (offlineObserved) {
          await this.closeSession({
            controller: alias,
            session,
            logout: true
          });
          return {
            Requested: acknowledged,
            RequestTransportUnknown: transportUnknown === true,
            OfflineObserved: true,
            ConsecutiveOnlineChecks: consecutiveOnlineChecks,
            Online: true,
            TimeoutSeconds: timeoutSeconds,
            SettledMs: elapsedMs,
            Checks: checks
          };
        }

        if (
          acknowledged &&
          elapsedMs >= this.restartSettleMs
        ) {
          consecutiveOnlineChecks += 1;
        } else {
          consecutiveOnlineChecks = 0;
        }
        await this.closeSession({
          controller: alias,
          session,
          logout: true
        });
        session = null;

        if (
          acknowledged &&
          consecutiveOnlineChecks >= this.restartOnlineChecks
        ) {
          return {
            Requested: true,
            RequestTransportUnknown: false,
            OfflineObserved: false,
            ConsecutiveOnlineChecks: consecutiveOnlineChecks,
            Online: true,
            TimeoutSeconds: timeoutSeconds,
            SettledMs: elapsedMs,
            Checks: checks
          };
        }
        lastError = transportUnknown
          ? "Restart request was transport-unknown; no offline transition observed."
          : "Restart acknowledged; waiting for independent settled sessions.";
      } catch (error) {
        if (session) {
          try {
            await this.closeSession({
              controller: alias,
              session,
              logout: false
            });
          } catch {}
        }
        if (!isRestartOfflineError(error)) throw error;
        offlineObserved = true;
        consecutiveOnlineChecks = 0;
        lastError = text(error?.message || error);
      }
    }

    throw new Error(
      `Controller did not return after restart within ${timeoutSeconds} ` +
        `seconds: ${lastError || "no verified online session"}`
    );
  }

  async close() {
    if (this.closed) return;
    const sessions = [...this.sessions];
    for (const session of sessions) {
      try {
        await this.closeSession({
          controller: session.controller,
          session,
          logout: true
        });
      } catch {}
    }
    this.closed = true;
  }
}

export function createDirectChangesetServiceApis(options) {
  const adapter = new DirectChangesetServiceAdapter(options);
  return {
    adapter,
    readApi: adapter.readApi,
    sessionApi: adapter.sessionApi
  };
}

export {
  RESTART_ONLINE_CHECKS,
  RESTART_POLL_MS,
  RESTART_REQUEST_TIMEOUT_MS,
  RESTART_SETTLE_MS,
  DUAL_PROTOCOL,
  RWS1,
  RWS2,
  SESSION_KIND,
  canonicalEndpoint,
  isTransportFailure,
  stableJson
};
