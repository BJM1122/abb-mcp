import assert from "node:assert/strict";

import {
  AbbBackendRouter,
  CHANGESET_BACKEND_DIRECT_PREVIEW,
  normalizeChangesetBackend
} from "../backend-router.mjs";
import { changesetPolicySignature } from "../direct-rws/changeset-policy.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tokenFor(generation, index) {
  return (generation * 1_000_000 + index).toString(16).padStart(32, "0");
}

class FakeDirectService {
  constructor() {
    this.busy = false;
    this.closed = false;
    this.registry = {
      allowedConfigDomains: ["eio", "sio", "sys", "proc"],
      allowedLocalRoots: ["C:\\mock"],
      controllers: {}
    };
    this.registrySha256 = "registry-a";
    this.calls = [];
    this.reloads = 0;
    this.reloadFailure = null;
    this.serialized = [];
    this.queueMode = "run";
    this.queueGates = new Map();
  }

  async call(method, params) {
    this.calls.push({ method, params });
    if (method !== "health") {
      throw new Error(`Unexpected direct call: ${method}`);
    }
    return {
      ok: true,
      service: "fake-direct-rws",
      version: "test",
      powershell: "not used",
      pid: process.pid
    };
  }

  async reloadRegistry() {
    this.reloads += 1;
    if (this.reloadFailure) throw this.reloadFailure;
    return false;
  }

  gateNextSerialized(alias) {
    const gate = { entered: deferred(), release: deferred() };
    this.queueGates.set(String(alias), gate);
    return gate;
  }

  async runSerialized(alias, operation, queueTimeoutMs) {
    alias = String(alias);
    this.serialized.push({ alias, queueTimeoutMs });
    if (this.queueMode === "timeout") {
      const error = new Error("WorkerBusy: mock queue timeout");
      error.code = "WorkerBusy";
      throw error;
    }
    const gate = this.queueGates.get(alias);
    if (gate) {
      this.queueGates.delete(alias);
      gate.entered.resolve();
      await gate.release.promise;
    }
    return await operation();
  }

  async close() {
    this.closed = true;
  }
}

class FakeLegacyWorker {
  constructor() {
    this.busy = false;
    this.closed = false;
    this.calls = [];
  }

  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "health") {
      return {
        ok: true,
        service: "fake-legacy",
        version: "test",
        pid: 1234,
        powershell: "7.test"
      };
    }
    return { Backend: "legacy", Method: method, Params: params };
  }

  async close() {
    this.closed = true;
  }
}

function createFakeStack(service, generation, events = [], policy = null) {
  const tokens = new Map();
  let nextToken = 1;
  let stack;
  const manager = {
    aliasCalls: [],
    callCalls: [],
    onCall: null,
    async aliasFor(method, params = {}) {
      events.push(`g${generation}:alias:${method}`);
      this.aliasCalls.push({ method, params });
      if (method === "prepare_changeset" || method === "verify_changeset") {
        return String(params?.changeset?.controller ?? "");
      }
      const entry = tokens.get(String(params?.token ?? ""));
      if (!entry) throw new Error("Unknown prepared token.");
      return entry.alias;
    },
    async call(method, params = {}, context = {}) {
      events.push(`g${generation}:call:${method}`);
      this.callCalls.push({ method, params, context });
      if (typeof this.onCall === "function") {
        await this.onCall(method, params, context);
      }
      if (stack.closed) {
        throw new Error(`generation ${generation} closed during ${method}`);
      }
      if (params?.failDirect === true) {
        throw new Error("direct changeset failure");
      }
      if (method === "prepare_changeset") {
        const alias = String(params?.changeset?.controller ?? "");
        const token = tokenFor(generation, nextToken++);
        tokens.set(token, { alias });
        return {
          Prepared: true,
          Backend: "direct",
          Controller: alias,
          Token: token,
          ExpiresAt: "2099-01-01T00:00:00.000Z"
        };
      }
      if (method === "commit_job") {
        const token = String(params?.token ?? "");
        const entry = tokens.get(token);
        if (!entry) throw new Error("Unknown prepared token.");
        tokens.delete(token);
        return {
          Applied: true,
          Backend: "direct",
          Controller: entry.alias,
          Token: token
        };
      }
      if (method === "verify_changeset") {
        return {
          Verified: true,
          Backend: "direct",
          Controller: String(params?.changeset?.controller ?? "")
        };
      }
      throw new Error(`Unexpected fake changeset method: ${method}`);
    }
  };
  stack = {
    generation,
    protocol: "rws1+rws2",
    registrySha256: service.registrySha256,
    policySha256: changesetPolicySignature(policy ?? service.registry),
    manager,
    closed: false,
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (this.closed) return;
      this.closed = true;
      tokens.clear();
      events.push(`g${generation}:close`);
    }
  };
  return stack;
}

function createStackFactory(service, events = [], { beforeCreate } = {}) {
  const stacks = [];
  let factoryCalls = 0;
  return {
    stacks,
    get factoryCalls() {
      return factoryCalls;
    },
    async factory({ service: suppliedService, policy, protocol }) {
      assert.equal(suppliedService, service);
      assert.equal(protocol, "rws1+rws2");
      const generation = ++factoryCalls;
      if (beforeCreate) await beforeCreate(generation);
      const stack = createFakeStack(
        service,
        generation,
        events,
        policy
      );
      stacks.push(stack);
      return stack;
    }
  };
}

function isPolicyChangedReplan(error) {
  return error?.code === "PolicyChangedReplan";
}

function changePolicy(service, suffix) {
  service.registry.allowedLocalRoots = [`C:\\policy-${suffix}`];
  service.registrySha256 = `registry-policy-${suffix}`;
}

function changeset(controller = "robot2") {
  return { controller, operations: [] };
}

assert.equal(normalizeChangesetBackend(undefined), "legacy");
assert.equal(
  normalizeChangesetBackend("direct-rws-preview"),
  "direct-rws-preview"
);
assert.throws(
  () => normalizeChangesetBackend("direct"),
  /ABB_MCP_CHANGESET_BACKEND/
);
assert.throws(
  () => new AbbBackendRouter({
    directService: new FakeDirectService(),
    changesetBackend: "legacy-powershell"
  }),
  /ABB_MCP_CHANGESET_BACKEND/
);

// Legacy remains lazy and is still the default changeset route.
{
  const direct = new FakeDirectService();
  let legacyCreated = 0;
  let legacy;
  const router = new AbbBackendRouter({
    directService: direct,
    legacyWorker: { mock: true },
    legacyWorkerFactory() {
      legacyCreated += 1;
      legacy = new FakeLegacyWorker();
      return legacy;
    }
  });

  const health = await router.health();
  assert.equal(health.backends.changeset, "legacy-powershell");
  assert.equal(health.legacy.started, false);
  assert.equal(legacyCreated, 0, "health must not start PowerShell");

  const result = await router.call("prepare_changeset", {
    changeset: changeset()
  });
  assert.equal(result.Backend, "legacy");
  assert.equal(legacyCreated, 1);
  assert.deepEqual(
    legacy.calls.map(({ method }) => method),
    ["health", "prepare_changeset"]
  );

  await router.close();
  assert.equal(direct.closed, true);
  assert.equal(legacy.closed, true);
}

// A registry content change outside the two global allow-lists must not rotate
// the stack or invalidate an otherwise current approval token.
{
  const direct = new FakeDirectService();
  const events = [];
  const harness = createStackFactory(direct, events);
  let legacyCreated = 0;
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness),
    legacyWorkerFactory() {
      legacyCreated += 1;
      throw new Error("legacy must not start for direct changesets");
    }
  });

  const health = await router.health();
  assert.equal(health.backends.changeset, "direct-rws-preview");
  assert.equal(harness.factoryCalls, 0, "health must not initialize changesets");

  const plan = await router.call("prepare_changeset", {
    changeset: changeset()
  });
  assert.equal(plan.Prepared, true);
  assert.equal(harness.factoryCalls, 1);

  direct.registrySha256 = "registry-unrelated-edit";
  direct.registry.controllers.robot3 = { expectedName: "unrelated" };
  const applied = await router.call("commit_job", { token: plan.Token });
  assert.equal(applied.Applied, true);
  assert.equal(harness.factoryCalls, 1, "unrelated registry edit rotated policy");
  assert.equal(harness.stacks[0].closeCalls, 0);
  assert.equal(legacyCreated, 0);

  await assert.rejects(
    router.call("verify_changeset", {
      changeset: changeset(),
      failDirect: true
    }),
    /direct changeset failure/
  );
  assert.equal(legacyCreated, 0, "direct errors must not fall back to legacy");

  await router.close();
  assert.equal(harness.stacks[0].closeCalls, 1);
  assert.equal(direct.closed, true);
}

// If the final registry read fails after manager.plan created a token, retire
// that generation so its hidden token and planner artifact are cleared rather
// than accumulating in a still-current manager.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  await router.call("verify_changeset", { changeset: changeset("seed") });
  const oldStack = harness.stacks[0];
  oldStack.manager.onCall = async (method) => {
    if (method === "prepare_changeset") {
      direct.reloadFailure = new Error("mock registry read failure");
    }
  };
  await assert.rejects(
    router.call("prepare_changeset", { changeset: changeset("robot2") }),
    /mock registry read failure/
  );
  await waitFor(
    () => oldStack.closeCalls === 1,
    "generation retirement after final registry read failure"
  );
  direct.reloadFailure = null;
  const recovered = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  assert.equal(recovered.Prepared, true);
  assert.equal(harness.factoryCalls, 2);
  await router.close();
}

// A queue timeout happens before the manager consumes the approval token. The
// exact same token remains usable while its policy generation is still current.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const plan = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  const stack = harness.stacks[0];
  direct.queueMode = "timeout";
  await assert.rejects(
    router.call("commit_job", { token: plan.Token }, 30_000, 100),
    (error) => error?.code === "WorkerBusy"
  );
  assert.equal(
    stack.manager.callCalls.filter(({ method }) => method === "commit_job")
      .length,
    0,
    "queue timeout entered manager.call and consumed the token"
  );
  direct.queueMode = "run";
  assert.equal(
    (await router.call("commit_job", { token: plan.Token })).Applied,
    true,
    "a queue timeout made the still-current token unusable"
  );
  await router.close();
}

// A token prepared under an old policy is never transferred to the replacement
// stack. The error must explicitly instruct callers to create and approve a new
// plan rather than exposing a generic unknown-token or restart error.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness),
    legacyWorkerFactory() {
      throw new Error("legacy must not start for direct changesets");
    }
  });

  const oldPlan = await router.call("prepare_changeset", {
    changeset: changeset()
  });
  const oldStack = harness.stacks[0];
  changePolicy(direct, "old-token");

  await assert.rejects(
    router.call("commit_job", { token: oldPlan.Token }),
    isPolicyChangedReplan
  );
  assert.equal(harness.factoryCalls, 2, "policy change did not rotate once");
  assert.equal(
    oldStack.manager.callCalls.filter(({ method }) => method === "commit_job")
      .length,
    0,
    "old-policy token reached manager.call"
  );
  assert.equal(oldStack.closeCalls, 1, "retired idle stack was not closed");

  const newPlan = await router.call("prepare_changeset", {
    changeset: changeset()
  });
  assert.equal(newPlan.Prepared, true);
  assert.notEqual(newPlan.Token, oldPlan.Token);
  assert.equal(harness.factoryCalls, 2);

  await router.close();
  assert.equal(oldStack.closeCalls, 1, "shutdown closed retired stack twice");
  assert.equal(harness.stacks[1].closeCalls, 1);
}

// A plan that finishes after its generation was retired must not return a
// usable stale token to the caller. The replacement generation may serve a
// different alias while the old read-only plan drains.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  await router.call("verify_changeset", { changeset: changeset("seed") });
  const oldStack = harness.stacks[0];
  const enteredPlan = deferred();
  const releasePlan = deferred();
  oldStack.manager.onCall = async (method) => {
    if (method !== "prepare_changeset") return;
    enteredPlan.resolve();
    await releasePlan.promise;
  };
  const stalePlan = router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  await enteredPlan.promise;
  changePolicy(direct, "plan-in-flight");
  const freshPlan = router.call("prepare_changeset", {
    changeset: changeset("robot3")
  });
  assert.equal((await freshPlan).Prepared, true);
  assert.equal(oldStack.closeCalls, 0, "rotation interrupted an active plan");
  releasePlan.resolve();
  await assert.rejects(stalePlan, isPolicyChangedReplan);
  await waitFor(() => oldStack.closeCalls === 1, "stale plan generation close");
  await router.close();
}

// The policy must be checked again after waiting in the per-alias queue. The
// approval token remains unconsumed by manager.call, but is invalidated by the
// policy generation change and requires a new plan.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const plan = await router.call("prepare_changeset", {
    changeset: changeset()
  });
  const oldStack = harness.stacks[0];
  const queueGate = direct.gateNextSerialized("robot2");
  const queuedCommit = router.call("commit_job", { token: plan.Token });
  await queueGate.entered.promise;

  changePolicy(direct, "queued");
  queueGate.release.resolve();
  await assert.rejects(queuedCommit, isPolicyChangedReplan);
  assert.equal(harness.factoryCalls, 2);
  assert.equal(
    oldStack.manager.callCalls.filter(({ method }) => method === "commit_job")
      .length,
    0,
    "queue-time policy recheck occurred after token consumption"
  );
  assert.equal(oldStack.closeCalls, 1);
  await router.close();
}

// Rotation may publish a replacement for new calls while an already-admitted
// commit finishes on the old generation. The old stack must stay alive until
// that call releases its lease, then close exactly once.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const plan = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  const oldStack = harness.stacks[0];
  const enteredCommit = deferred();
  const releaseCommit = deferred();
  oldStack.manager.onCall = async (method) => {
    if (method !== "commit_job") return;
    enteredCommit.resolve();
    await releaseCommit.promise;
  };

  const activeCommit = router.call("commit_job", { token: plan.Token });
  await enteredCommit.promise;
  changePolicy(direct, "active-commit");
  const replacementPlan = router.call("prepare_changeset", {
    changeset: changeset("robot3")
  });
  await waitFor(
    () => harness.factoryCalls === 2,
    "replacement stack creation during active commit"
  );
  assert.equal(oldStack.closeCalls, 0, "rotation interrupted active commit");
  assert.equal((await replacementPlan).Prepared, true);
  assert.equal(oldStack.closeCalls, 0, "replacement closed leased stack early");

  releaseCommit.resolve();
  assert.equal((await activeCommit).Applied, true);
  await waitFor(() => oldStack.closeCalls === 1, "retired stack close");
  assert.equal(oldStack.closeCalls, 1);

  await router.close();
  assert.equal(oldStack.closeCalls, 1, "shutdown closed old generation twice");
  assert.equal(harness.stacks[1].closeCalls, 1);
}

// Concurrent callers observing one policy edit share one replacement factory
// promise. Repeated shutdown must close current and retired generations once.
{
  const direct = new FakeDirectService();
  const replacementStarted = deferred();
  const releaseReplacement = deferred();
  const harness = createStackFactory(direct, [], {
    async beforeCreate(generation) {
      if (generation !== 2) return;
      replacementStarted.resolve();
      await releaseReplacement.promise;
    }
  });
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  await router.call("prepare_changeset", { changeset: changeset("seed") });
  const oldStack = harness.stacks[0];
  changePolicy(direct, "concurrent");

  const calls = [
    router.call("prepare_changeset", { changeset: changeset("robot0") })
  ];
  await replacementStarted.promise;
  for (let index = 1; index < 8; index += 1) {
    calls.push(
      router.call("prepare_changeset", {
        changeset: changeset(`robot${index}`)
      })
    );
  }
  await Promise.resolve();
  assert.equal(
    harness.factoryCalls,
    2,
    "concurrent policy refresh started more than one replacement factory"
  );
  releaseReplacement.resolve();
  const plans = await Promise.all(calls);
  assert.equal(plans.every((plan) => plan.Prepared === true), true);
  assert.equal(harness.factoryCalls, 2);
  assert.equal(oldStack.closeCalls, 1);

  await router.close();
  await router.close();
  assert.equal(oldStack.closeCalls, 1, "retired stack closed more than once");
  assert.equal(harness.stacks[1].closeCalls, 1, "current stack closed more than once");
  assert.equal(direct.closed, true);
}

// All callers waiting on one failed replacement observe the same failure. The
// failed single-flight is cleared so a later call can build the latest policy
// generation, without falling back to legacy or reviving the old stack.
{
  const direct = new FakeDirectService();
  const replacementStarted = deferred();
  const releaseFailure = deferred();
  const harness = createStackFactory(direct, [], {
    async beforeCreate(generation) {
      if (generation !== 2) return;
      replacementStarted.resolve();
      await releaseFailure.promise;
      throw new Error("mock replacement factory failure");
    }
  });
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness),
    legacyWorkerFactory() {
      throw new Error("legacy must not start after direct factory failure");
    }
  });
  await router.call("prepare_changeset", { changeset: changeset("seed") });
  changePolicy(direct, "factory-failure");
  const calls = [
    router.call("prepare_changeset", { changeset: changeset("robot0") })
  ];
  await replacementStarted.promise;
  for (let index = 1; index < 6; index += 1) {
    calls.push(
      router.call("prepare_changeset", {
        changeset: changeset(`robot${index}`)
      })
    );
  }
  await Promise.resolve();
  assert.equal(harness.factoryCalls, 2);
  releaseFailure.resolve();
  const failures = await Promise.allSettled(calls);
  assert.equal(
    failures.every(
      (result) =>
        result.status === "rejected" &&
        /mock replacement factory failure/.test(result.reason?.message)
    ),
    true,
    "concurrent callers did not share the failed replacement"
  );
  assert.equal(harness.factoryCalls, 2);
  const recovered = await router.call("prepare_changeset", {
    changeset: changeset("recovered")
  });
  assert.equal(recovered.Prepared, true);
  assert.equal(harness.factoryCalls, 3, "failed single-flight was not retryable");
  await router.close();
}

// A policy that changes again while its replacement is being built must never
// publish the stale candidate. The candidate is closed and all callers move to
// the newest policy generation.
{
  const direct = new FakeDirectService();
  const staleBuildStarted = deferred();
  const releaseStaleBuild = deferred();
  const harness = createStackFactory(direct, [], {
    async beforeCreate(generation) {
      if (generation !== 2) return;
      staleBuildStarted.resolve();
      await releaseStaleBuild.promise;
    }
  });
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  await router.call("prepare_changeset", { changeset: changeset("seed") });
  changePolicy(direct, "build-b");
  const latestPlan = router.call("prepare_changeset", {
    changeset: changeset("latest")
  });
  await staleBuildStarted.promise;
  changePolicy(direct, "build-c");
  releaseStaleBuild.resolve();
  assert.equal((await latestPlan).Prepared, true);
  assert.equal(harness.factoryCalls, 3, "latest policy did not get a new stack");
  assert.equal(harness.stacks[1].closeCalls, 1, "stale candidate was not closed");
  assert.equal(
    harness.stacks[1].manager.callCalls.length,
    0,
    "a stale build served a changeset call"
  );
  await router.close();
}

// Returning to byte-for-byte equivalent policy values creates a new
// generation; it must never resurrect a token from the earlier generation.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const originalPlan = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  changePolicy(direct, "temporary-b");
  await router.call("prepare_changeset", { changeset: changeset("robot3") });
  direct.registry.allowedLocalRoots = ["C:\\mock"];
  direct.registrySha256 = "registry-policy-back-to-a";
  await assert.rejects(
    router.call("commit_job", { token: originalPlan.Token }),
    isPolicyChangedReplan
  );
  assert.equal(harness.factoryCalls, 3);
  assert.equal(
    harness.stacks[0].manager.callCalls.filter(
      ({ method }) => method === "commit_job"
    ).length,
    0,
    "an old token was resurrected when policy values returned to A"
  );
  await router.close();
}

// Invalid policy retires the current generation and blocks every new plan.
// Repairing the registry creates one fresh generation without reviving old
// approvals.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const oldPlan = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  direct.registry.allowedLocalRoots = [];
  direct.registrySha256 = "registry-invalid-policy";
  await assert.rejects(
    router.call("prepare_changeset", { changeset: changeset("blocked") }),
    /allowedLocalRoots.*non-empty array/i
  );
  assert.equal(harness.factoryCalls, 1, "invalid policy built a stack");
  direct.registry.allowedLocalRoots = ["C:\\repaired"];
  direct.registrySha256 = "registry-repaired-policy";
  await assert.rejects(
    router.call("commit_job", { token: oldPlan.Token }),
    isPolicyChangedReplan
  );
  assert.equal(harness.factoryCalls, 2);
  await router.close();
}

// Router shutdown drains an already-entered commit before closing its stack or
// the shared DirectRwsService, and rejects every new call once draining starts.
{
  const direct = new FakeDirectService();
  const harness = createStackFactory(direct);
  const router = new AbbBackendRouter({
    directService: direct,
    changesetBackend: CHANGESET_BACKEND_DIRECT_PREVIEW,
    directChangesetFactory: harness.factory.bind(harness)
  });
  const plan = await router.call("prepare_changeset", {
    changeset: changeset("robot2")
  });
  const stack = harness.stacks[0];
  const enteredCommit = deferred();
  const releaseCommit = deferred();
  stack.manager.onCall = async (method) => {
    if (method !== "commit_job") return;
    enteredCommit.resolve();
    await releaseCommit.promise;
  };
  const commit = router.call("commit_job", { token: plan.Token });
  await enteredCommit.promise;
  const closing = router.close();
  await Promise.resolve();
  assert.equal(stack.closeCalls, 0, "shutdown closed an active commit stack");
  assert.equal(direct.closed, false, "shutdown closed the active RWS service");
  await assert.rejects(
    router.call("verify_changeset", { changeset: changeset("late") }),
    /closing or closed/
  );
  releaseCommit.resolve();
  assert.equal((await commit).Applied, true);
  await closing;
  assert.equal(stack.closeCalls, 1);
  assert.equal(direct.closed, true);
}

console.log(
  "backend router changeset tests passed: lazy routing, policy hot rotation, " +
    "explicit replan errors, queue recheck, active leases, single-flight, and close-once lifecycle"
);
