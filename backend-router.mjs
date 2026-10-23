import { PowerShellWorker } from "./worker-client.mjs";
import {
  changesetPolicySignature,
  changesetPolicySnapshot
} from "./direct-rws/changeset-policy.mjs";
import {
  DIRECT_CHANGESET_PROTOCOL,
  isDirectChangesetMethod
} from "./direct-rws/method-routing.mjs";
import { DirectRwsService } from "./direct-rws/service.mjs";

const CHANGESET_BACKEND_LEGACY = "legacy";
const CHANGESET_BACKEND_DIRECT_PREVIEW = "direct-rws-preview";
const CHANGESET_BACKENDS = new Set([
  CHANGESET_BACKEND_LEGACY,
  CHANGESET_BACKEND_DIRECT_PREVIEW
]);

function normalizeChangesetBackend(value) {
  const backend = String(value ?? CHANGESET_BACKEND_LEGACY).trim();
  if (!CHANGESET_BACKENDS.has(backend)) {
    throw new Error(
      "Invalid ABB_MCP_CHANGESET_BACKEND. Expected 'legacy' or " +
        "'direct-rws-preview'."
    );
  }
  return backend;
}

function policyChangedReplanError() {
  const error = new Error(
    "ABB changeset allow-list policy changed after this plan was created. " +
      "Create and approve a fresh plan; restarting the ABB MCP is not required."
  );
  error.code = "PolicyChangedReplan";
  error.NeedsFreshPlan = true;
  return error;
}

export class AbbBackendRouter {
  constructor({
    registryPath,
    offlineCooldownMs = 5_000,
    pagination,
    maxSockets,
    legacyWorker,
    allowLegacy = true,
    changesetBackend = CHANGESET_BACKEND_LEGACY,
    directService = null,
    directChangesetFactory = null,
    directChangesetLoader = () => import("./direct-rws/changeset-stack.mjs"),
    legacyWorkerFactory = (options) => new PowerShellWorker(options)
  }) {
    this.direct =
      directService ??
      new DirectRwsService({
        registryPath,
        offlineCooldownMs,
        pagination,
        maxSockets
      });
    this.legacyWorkerOptions = legacyWorker;
    this.allowLegacy = allowLegacy;
    this.changesetBackend = normalizeChangesetBackend(changesetBackend);
    if (
      directChangesetFactory !== null &&
      typeof directChangesetFactory !== "function"
    ) {
      throw new Error("directChangesetFactory must be null or a function.");
    }
    if (typeof directChangesetLoader !== "function") {
      throw new Error("directChangesetLoader must be a function.");
    }
    if (typeof legacyWorkerFactory !== "function") {
      throw new Error("legacyWorkerFactory must be a function.");
    }
    this.directChangesetFactory = directChangesetFactory;
    this.directChangesetLoader = directChangesetLoader;
    this.legacyWorkerFactory = legacyWorkerFactory;
    this.directChangesetGeneration = null;
    this.directChangesetBuild = null;
    this.directChangesetGenerations = new Set();
    this.directChangesetTokenGenerations = new Map();
    this.directChangesetGenerationSerial = 0;
    this.directChangesetCloseErrors = [];
    this.legacy = null;
    this.legacyStarted = false;
    this.legacyHealth = null;
    this.acceptingCalls = true;
    this.activeCalls = 0;
    this.drainWaiters = [];
    this.closePromise = null;
    this.closed = false;
  }

  get busy() {
    return (
      this.activeCalls > 0 ||
      this.direct.busy ||
      Boolean(this.legacy?.busy)
    );
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

  async ensureLegacy() {
    if (!this.allowLegacy) {
      throw new Error(
        "Legacy PowerShell ABB backend is disabled; this method has not yet migrated to direct RWS."
      );
    }
    if (this.legacy && !this.legacy.closed) return this.legacy;
    this.legacy = this.legacyWorkerFactory(this.legacyWorkerOptions);
    this.legacyStarted = true;
    this.legacyHealth = await this.legacy.call("health", {}, 15_000);
    return this.legacy;
  }

  pruneDirectChangesetTokens(nowMs = Date.now()) {
    for (const [token, entry] of this.directChangesetTokenGenerations) {
      if (entry.expiresAtMs !== null && nowMs > entry.expiresAtMs) {
        this.directChangesetTokenGenerations.delete(token);
      }
    }
  }

  rememberDirectChangesetToken(result, generation) {
    const token = String(result?.Token ?? "");
    if (!/^[a-f0-9]{32}$/.test(token)) return;
    const parsedExpiry = new Date(result?.ExpiresAt).getTime();
    this.pruneDirectChangesetTokens();
    this.directChangesetTokenGenerations.set(token, {
      generationId: generation.id,
      expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : null
    });
  }

  retireDirectChangesetGeneration(generation) {
    if (!generation || generation.state !== "current") return;
    generation.state = "retiring";
    if (this.directChangesetGeneration === generation) {
      this.directChangesetGeneration = null;
    }
    if (generation.leases === 0) {
      void this.closeDirectChangesetGeneration(generation);
    }
  }

  closeDirectChangesetGeneration(generation) {
    if (generation.closePromise) return generation.closePromise;
    generation.state = "closing";
    generation.closePromise = (async () => {
      try {
        await generation.stack.close();
      } catch (error) {
        generation.closeError = error;
        this.directChangesetCloseErrors.push(error);
      } finally {
        generation.state = "closed";
        this.directChangesetGenerations.delete(generation);
      }
    })();
    return generation.closePromise;
  }

  releaseDirectChangesetGeneration(generation) {
    generation.leases -= 1;
    if (generation.leases < 0) {
      throw new Error("Direct changeset generation lease underflow.");
    }
    if (generation.leases === 0 && generation.state === "retiring") {
      void this.closeDirectChangesetGeneration(generation);
    }
  }

  async readDirectChangesetPolicy(
    retireGeneration = this.directChangesetGeneration
  ) {
    try {
      await this.direct.reloadRegistry();
      const policy = changesetPolicySnapshot(this.direct.registry);
      return {
        policy,
        policySha256: changesetPolicySignature(policy)
      };
    } catch (error) {
      this.retireDirectChangesetGeneration(retireGeneration);
      throw error;
    }
  }

  async buildDirectChangesetGeneration(expected) {
    let factory = this.directChangesetFactory;
    if (!factory) {
      const loaded = await this.directChangesetLoader();
      factory = loaded?.createDirectChangesetStack;
      if (typeof factory !== "function") {
        throw new Error(
          "Direct changeset module did not export createDirectChangesetStack()."
        );
      }
      this.directChangesetFactory = factory;
    }

    const stack = await factory({
      service: this.direct,
      policy: expected.policy,
      protocol: DIRECT_CHANGESET_PROTOCOL
    });
    if (
      !stack ||
      !stack.manager ||
      typeof stack.manager.aliasFor !== "function" ||
      typeof stack.manager.call !== "function" ||
      typeof stack.close !== "function"
    ) {
      if (typeof stack?.close === "function") {
        await stack.close().catch(() => {});
      }
      throw new Error("Direct changeset factory returned an invalid stack.");
    }
    if (stack.policySha256 !== expected.policySha256) {
      await stack.close().catch(() => {});
      throw new Error(
        "Direct changeset factory returned a stack for the wrong policy generation."
      );
    }

    const generation = {
      id: ++this.directChangesetGenerationSerial,
      policy: expected.policy,
      policySha256: expected.policySha256,
      stack,
      state: "building",
      leases: 0,
      closePromise: null,
      closeError: null
    };
    this.directChangesetGenerations.add(generation);

    let latest;
    try {
      latest = await this.readDirectChangesetPolicy();
    } catch (error) {
      generation.state = "retiring";
      await this.closeDirectChangesetGeneration(generation);
      throw error;
    }
    if (latest.policySha256 !== expected.policySha256) {
      generation.state = "retiring";
      await this.closeDirectChangesetGeneration(generation);
      if (generation.closeError) throw generation.closeError;
      return null;
    }
    if (this.closed || !this.acceptingCalls) {
      generation.state = "retiring";
      await this.closeDirectChangesetGeneration(generation);
      throw new Error("ABB backend router is closing or closed.");
    }

    generation.state = "current";
    this.directChangesetGeneration = generation;
    return generation;
  }

  async ensureDirectChangesetGeneration() {
    if (this.changesetBackend !== CHANGESET_BACKEND_DIRECT_PREVIEW) {
      throw new Error("Direct RWS changesets are not enabled.");
    }
    if (this.closed) throw new Error("ABB backend router is closed.");
    while (true) {
      const expected = await this.readDirectChangesetPolicy();
      const current = this.directChangesetGeneration;
      if (
        current?.state === "current" &&
        current.policySha256 === expected.policySha256
      ) {
        return current;
      }
      if (current) this.retireDirectChangesetGeneration(current);

      if (!this.directChangesetBuild) {
        const build = { promise: null };
        build.promise = this.buildDirectChangesetGeneration(expected)
          .finally(() => {
            if (this.directChangesetBuild === build) {
              this.directChangesetBuild = null;
            }
          });
        this.directChangesetBuild = build;
      }
      await this.directChangesetBuild.promise;
    }
  }

  async acquireDirectChangesetGeneration(method, params) {
    while (true) {
      const generation = await this.ensureDirectChangesetGeneration();
      this.pruneDirectChangesetTokens();
      if (method === "commit_job") {
        const token = String(params?.token ?? "");
        const entry = this.directChangesetTokenGenerations.get(token);
        if (entry && entry.generationId !== generation.id) {
          throw policyChangedReplanError();
        }
      }
      if (
        generation.state !== "current" ||
        this.directChangesetGeneration !== generation
      ) {
        continue;
      }
      generation.leases += 1;
      return generation;
    }
  }

  async assertDirectChangesetGenerationCurrent(generation) {
    const currentPolicy = await this.readDirectChangesetPolicy(generation);
    if (
      generation.state === "current" &&
      this.directChangesetGeneration === generation &&
      generation.policySha256 === currentPolicy.policySha256
    ) {
      return;
    }
    this.retireDirectChangesetGeneration(generation);
    await this.ensureDirectChangesetGeneration();
    throw policyChangedReplanError();
  }

  async health() {
    const direct = await this.direct.call("health", {});
    const legacyRunning = Boolean(this.legacy && !this.legacy.closed);
    const changesetRoute =
      this.changesetBackend === CHANGESET_BACKEND_DIRECT_PREVIEW
        ? CHANGESET_BACKEND_DIRECT_PREVIEW
        : this.allowLegacy
          ? "legacy-powershell"
          : "disabled";
    const legacyPowerShell = this.legacyHealth?.powershell ?? null;
    return {
      ...direct,
      backend: "hybrid",
      backends: {
        read: "direct-rws",
        changeset: changesetRoute,
        backup: "direct-rws"
      },
      legacy: {
        enabled: this.allowLegacy,
        started: this.legacyStarted,
        running: legacyRunning,
        pid: this.legacyHealth?.pid ?? null,
        powershell: legacyPowerShell
      },
      // Preserve the original flat field for clients that have not adopted the
      // structured backend report yet. Health itself never starts legacy.
      powershell: legacyPowerShell ?? (this.allowLegacy ? "not started" : "disabled")
    };
  }

  async call(
    method,
    params = {},
    timeoutMs = 60_000,
    queueTimeoutMs,
    onProgress = null
  ) {
    if (!this.acceptingCalls || this.closed) {
      throw new Error("ABB backend router is closing or closed.");
    }
    this.activeCalls += 1;
    try {
      return await this.dispatchCall(
        method,
        params,
        timeoutMs,
        queueTimeoutMs,
        onProgress
      );
    } finally {
      this.finishCall();
    }
  }

  async dispatchCall(
    method,
    params = {},
    timeoutMs = 60_000,
    queueTimeoutMs,
    onProgress = null
  ) {
    if (method === "health") return await this.health();
    if (
      this.changesetBackend === CHANGESET_BACKEND_DIRECT_PREVIEW &&
      isDirectChangesetMethod(method)
    ) {
      const generation = await this.acquireDirectChangesetGeneration(
        method,
        params
      );
      try {
        const alias = await generation.stack.manager.aliasFor(method, params);
        return await this.direct.runSerialized(
          alias,
          async () => {
            // The queue may wait behind a long controller operation. This is
            // the final policy-generation check before manager.call can retire
            // an approval token or start a controller write.
            await this.assertDirectChangesetGenerationCurrent(generation);
            let enteredManager = false;
            try {
              enteredManager = true;
              const result = await generation.stack.manager.call(
                method,
                params,
                { timeoutMs, queueTimeoutMs, onProgress }
              );
              if (method === "prepare_changeset") {
                // Never return a token whose generation changed while its
                // controller reads or local artifact capture were in flight.
                await this.assertDirectChangesetGenerationCurrent(generation);
                this.rememberDirectChangesetToken(result, generation);
              }
              return result;
            } finally {
              if (method === "commit_job" && enteredManager) {
                this.directChangesetTokenGenerations.delete(
                  String(params?.token ?? "")
                );
              }
            }
          },
          queueTimeoutMs
        );
      } finally {
        this.releaseDirectChangesetGeneration(generation);
      }
    }
    if (DirectRwsService.supports(method)) {
      return await this.direct.call(
        method,
        params,
        timeoutMs,
        queueTimeoutMs,
        onProgress
      );
    }
    const legacy = await this.ensureLegacy();
    return await legacy.call(method, params, timeoutMs, queueTimeoutMs, onProgress);
  }

  async close() {
    if (this.closePromise) return await this.closePromise;
    this.acceptingCalls = false;
    this.closePromise = (async () => {
      // Calls that already entered the router include operations waiting in a
      // per-controller queue. Drain them before clearing approval tokens or
      // closing an identity-locked RWS session.
      await this.waitForDrain();
      this.closed = true;
      let firstError = null;
      if (this.directChangesetBuild) {
        try {
          await this.directChangesetBuild.promise;
        } catch {}
      }
      if (this.directChangesetGeneration) {
        this.retireDirectChangesetGeneration(
          this.directChangesetGeneration
        );
      }
      for (const generation of this.directChangesetGenerations) {
        if (generation.state !== "closed") {
          if (generation.state === "current") {
            this.retireDirectChangesetGeneration(generation);
          }
          await this.closeDirectChangesetGeneration(generation);
        }
      }
      this.directChangesetTokenGenerations.clear();
      firstError ??= this.directChangesetCloseErrors[0] ?? null;
      try {
        await this.direct.close();
      } catch (error) {
        firstError ??= error;
      }
      if (this.legacy) {
        try {
          await this.legacy.close();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    return await this.closePromise;
  }
}

export {
  CHANGESET_BACKEND_DIRECT_PREVIEW,
  CHANGESET_BACKEND_LEGACY,
  normalizeChangesetBackend
};
