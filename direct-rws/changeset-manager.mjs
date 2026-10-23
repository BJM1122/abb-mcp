import {
  CHANGESET_METHODS,
  isDirectChangesetMethod
} from "./method-routing.mjs";
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RAPID_MODULE_KINDS = new Set([
  "rapid_module_put",
  "rapid_module_delete"
]);
const RETIRED_TOKEN_TTL_MS = 10 * 60 * 1_000;

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function requireMethod(method) {
  const name = text(method);
  if (!CHANGESET_METHODS.has(name)) {
    throw new Error(`Unknown direct changeset method: ${name}`);
  }
  return name;
}

function requireChangeset(params) {
  const changeset = params?.changeset;
  if (
    changeset === null ||
    changeset === undefined ||
    typeof changeset !== "object" ||
    Array.isArray(changeset)
  ) {
    throw new Error("ABB changeset must be an object.");
  }
  const alias = text(changeset.controller);
  if (
    alias !== alias.trim() ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(alias) ||
    ["__proto__", "prototype", "constructor"].includes(alias.toLowerCase())
  ) {
    throw new Error(
      "ABB changeset controller must be a non-empty, trimmed registered alias."
    );
  }
  return { changeset, alias };
}

function requireToken(params) {
  const token = text(params?.token);
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "ABB changeset token must be 32 lowercase hexadecimal characters."
    );
  }
  return token;
}

function expirationMilliseconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("ABB changeset plan returned an invalid expiration time.");
  }
  return milliseconds;
}

function preparedAlias(prepared) {
  return text(
    prepared?.Alias ??
      prepared?.Controller ??
      prepared?.Manifest?.controller
  );
}

function buildTasks(prepared) {
  const output = [];
  const seen = new Set();
  for (const operation of prepared?.Operations ?? []) {
    if (!RAPID_MODULE_KINDS.has(text(operation?.Kind))) continue;
    const task = text(operation?.Task);
    const folded = task.toLowerCase();
    if (!task || seen.has(folded)) continue;
    seen.add(folded);
    output.push(task);
  }
  return output;
}

/**
 * Isolated routing/lifecycle wrapper for DirectChangesetPlanner and
 * DirectChangesetExecutor.
 *
 * This class deliberately opens no network connection and owns no service
 * queue. A service must call aliasFor() before entering its per-controller
 * queue and call() only after the queue has been acquired. In particular,
 * aliasFor("commit_job") never consumes the approval token.
 */
export class DirectChangesetManager {
  constructor({
    planner,
    executor,
    now = () => Date.now()
  } = {}) {
    if (
      !planner ||
      typeof planner.capture !== "function" ||
      typeof planner.prepare !== "function" ||
      typeof planner.consume !== "function"
    ) {
      throw new Error(
        "DirectChangesetManager requires a planner with capture(), prepare() and consume()."
      );
    }
    if (
      !executor ||
      typeof executor.apply !== "function" ||
      typeof executor.freshVerification !== "function"
    ) {
      throw new Error(
        "DirectChangesetManager requires an executor with apply() and freshVerification()."
      );
    }
    if (typeof now !== "function") throw new Error("now must be a function.");

    this.planner = planner;
    this.executor = executor;
    this.now = now;
    this.tokens = new Map();
    this.retiredTokens = new Map();
    this.closed = false;
  }

  static supports(method) {
    return isDirectChangesetMethod(text(method));
  }

  nowMs() {
    const value = this.now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) {
      throw new Error("now() returned an invalid time.");
    }
    return milliseconds;
  }

  assertOpen() {
    if (this.closed) throw new Error("Direct changeset manager is closed.");
  }

  pruneRetired(nowMs = this.nowMs()) {
    for (const [token, expiresAtMs] of this.retiredTokens) {
      if (nowMs > expiresAtMs) this.retiredTokens.delete(token);
    }
  }

  async discardPlannerToken(token) {
    if (typeof this.planner.discard !== "function") return false;
    await this.planner.discard(token);
    return true;
  }

  rememberPlan(plan, expectedAlias) {
    if (!plan || typeof plan !== "object" || plan.Prepared !== true) {
      throw new Error("ABB changeset planner did not return a prepared plan.");
    }
    const token = text(plan.Token);
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error("ABB changeset planner returned an invalid token.");
    }
    const alias = text(plan.Controller);
    if (!alias || alias !== expectedAlias) {
      throw new Error(
        "ABB changeset planner returned a different controller alias."
      );
    }
    this.pruneRetired();
    if (this.tokens.has(token) || this.retiredTokens.has(token)) {
      throw new Error("ABB changeset planner returned a duplicate token.");
    }
    const expiresAtMs = expirationMilliseconds(plan.ExpiresAt);
    this.tokens.set(token, {
      alias,
      expiresAtMs
    });
    return token;
  }

  retireToken(token, entry) {
    this.tokens.delete(token);
    const nowMs = this.nowMs();
    const planExpiry =
      entry?.expiresAtMs === null || entry?.expiresAtMs === undefined
        ? nowMs + RETIRED_TOKEN_TTL_MS
        : entry.expiresAtMs;
    this.retiredTokens.set(
      token,
      Math.max(nowMs + 1, planExpiry)
    );
  }

  async peekToken(token) {
    this.pruneRetired();
    if (this.retiredTokens.has(token)) {
      throw new Error("Prepared token has already been used.");
    }
    const entry = this.tokens.get(token);
    if (!entry) throw new Error("Unknown prepared token.");
    if (
      entry.expiresAtMs !== null &&
      this.nowMs() > entry.expiresAtMs
    ) {
      this.retireToken(token, entry);
      await this.discardPlannerToken(token).catch(() => {});
      throw new Error("Prepared token has expired.");
    }

    // Validate expiration and the immutable token metadata before entering
    // the service queue without consuming the approval token. consume() still
    // performs the authoritative manifest/artifact hash check inside the queue.
    if (typeof this.planner.peek === "function") {
      const prepared = await this.planner.peek(token);
      const alias = preparedAlias(prepared);
      if (!alias || alias !== entry.alias) {
        throw new Error(
          "Prepared token controller alias changed after planning."
        );
      }
    }
    return { token, ...entry };
  }

  async aliasFor(method, params = {}) {
    this.assertOpen();
    const name = requireMethod(method);
    if (name === "prepare_changeset" || name === "verify_changeset") {
      return requireChangeset(params).alias;
    }
    const token = requireToken(params);
    return (await this.peekToken(token)).alias;
  }

  async plan(params = {}) {
    this.assertOpen();
    const { changeset, alias } = requireChangeset(params);
    const plan = await this.planner.prepare(changeset);
    if (
      plan?.Prepared === false && plan?.Preview === true &&
      plan?.SafetyBlocked === true && !plan.Token &&
      plan.Controller === alias && plan.ControllerModified === false
    ) return plan;
    let token;
    try {
      token = this.rememberPlan(plan, alias);
      return plan;
    } catch (error) {
      if (token || TOKEN_PATTERN.test(text(plan?.Token))) {
        await this.discardPlannerToken(token ?? text(plan.Token)).catch(() => {});
      }
      throw error;
    }
  }

  async apply(params = {}) {
    this.assertOpen();
    const token = requireToken(params);
    const entry = await this.peekToken(token);

    // Retire inside the controller queue, immediately before the executor
    // consumes the token. A queue timeout therefore leaves the token usable,
    // while any started apply is never replayable.
    this.retireToken(token, entry);
    try {
      const result = await this.executor.apply(token);
      if (
        !result ||
        typeof result !== "object" ||
        text(result.Controller) !== entry.alias
      ) {
        throw new Error(
          "ABB changeset executor returned a different controller alias."
        );
      }
      return result;
    } finally {
      await this.discardPlannerToken(token);
    }
  }

  async verify(params = {}) {
    this.assertOpen();
    const { changeset, alias } = requireChangeset(params);
    const { prepared } = await this.planner.capture(changeset);
    const actualAlias = preparedAlias(prepared);
    if (!actualAlias || actualAlias !== alias) {
      throw new Error(
        "Prepared verification controller alias changed after planning."
      );
    }
    const readback = await this.executor.freshVerification(
      prepared,
      buildTasks(prepared)
    );
    return {
      Verified:
        readback?.ReadbackSucceeded === true &&
        readback?.Passed === true,
      Controller: alias,
      Identity: readback?.Identity,
      State: readback?.State,
      Verification: readback?.Verification ?? [],
      BuildVerification: readback?.Build ?? [],
      ReadbackSucceeded: readback?.ReadbackSucceeded === true,
      ...(readback?.Error ? { Failure: text(readback.Error) } : {}),
      ControllerModified: false
    };
  }

  async call(method, params = {}, _context = {}) {
    this.assertOpen();
    const name = requireMethod(method);
    if (name === "prepare_changeset") return await this.plan(params);
    if (name === "commit_job") return await this.apply(params);
    if (name === "verify_changeset") return await this.verify(params);
    throw new Error(`Unknown direct changeset method: ${name}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.tokens.clear();
    this.retiredTokens.clear();

    let firstError = null;
    try {
      if (typeof this.planner.close === "function") {
        await this.planner.close();
      }
    } catch (error) {
      firstError = error;
    }
    try {
      if (typeof this.executor.close === "function") {
        await this.executor.close();
      }
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }
}

export {
  CHANGESET_METHODS,
  RAPID_MODULE_KINDS,
  TOKEN_PATTERN,
  buildTasks
};
