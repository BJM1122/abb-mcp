import assert from "node:assert/strict";
import { DirectChangesetManager } from "../direct-rws/changeset-manager.mjs";

const TOKENS = [
  "00000000000000000000000000000001",
  "00000000000000000000000000000002",
  "00000000000000000000000000000003",
  "00000000000000000000000000000004",
  "00000000000000000000000000000005",
  "00000000000000000000000000000006"
];

function changeset(controller = "robot2") {
  return {
    version: 1,
    controller,
    expectedController: {
      name: "4600-test",
      systemId: "00000000-0000-0000-0000-000000000001",
      robotWare: "6.13"
    },
    safety: {
      requireRapidStopped: true,
      allowedControllerStates: ["guardstop", "motoroff"]
    },
    operations: [
      {
        kind: "rapid_module_put",
        task: "T_ROB1",
        module: "MainModule"
      },
      {
        kind: "rapid_module_delete",
        task: "t_rob1",
        module: "OldModule"
      },
      {
        kind: "cfg_set",
        domain: "eio",
        type: "EIO_SIGNAL",
        instance: "diReady"
      }
    ]
  };
}

class MockPlanner {
  constructor({ withPeek = true, withDiscard = true } = {}) {
    this.tokens = new Map();
    this.tokenIndex = 0;
    this.prepareCalls = 0;
    this.captureCalls = 0;
    this.peekCalls = 0;
    this.consumeCalls = 0;
    this.discardCalls = 0;
    this.closeCalls = 0;
    if (!withPeek) this.peek = undefined;
    if (!withDiscard) this.discard = undefined;
  }

  async prepare(manifest) {
    this.prepareCalls += 1;
    const token = TOKENS[this.tokenIndex++];
    const prepared = {
      Token: token,
      Alias: manifest.controller,
      Manifest: structuredClone(manifest),
      Operations: [
        { Kind: "rapid_module_put", Task: "T_ROB1" },
        { Kind: "rapid_module_delete", Task: "t_rob1" },
        { Kind: "cfg_set" }
      ],
      Used: false
    };
    this.tokens.set(token, prepared);
    return {
      Prepared: true,
      Token: token,
      ExpiresAt: "2030-01-01T00:10:00.000Z",
      Controller: manifest.controller,
      ControllerModified: false
    };
  }

  async capture(manifest) {
    this.captureCalls += 1;
    return { prepared: {
      Alias: manifest.controller,
      Manifest: structuredClone(manifest),
      Operations: [
        { Kind: "rapid_module_put", Task: "T_ROB1" },
        { Kind: "rapid_module_delete", Task: "t_rob1" },
        { Kind: "cfg_set" }
      ]
    } };
  }

  peek(token) {
    this.peekCalls += 1;
    const prepared = this.tokens.get(token);
    if (!prepared) throw new Error("Unknown prepared token.");
    if (prepared.Used) throw new Error("Prepared token has already been used.");
    return prepared;
  }

  consume(token) {
    this.consumeCalls += 1;
    const prepared = this.tokens.get(token);
    if (!prepared) throw new Error("Unknown prepared token.");
    if (prepared.Used) throw new Error("Prepared token has already been used.");
    prepared.Used = true;
    return prepared;
  }

  discard(token) {
    this.discardCalls += 1;
    this.tokens.delete(token);
  }

  close() {
    this.closeCalls += 1;
    this.tokens.clear();
  }
}

class MockExecutor {
  constructor(planner) {
    this.planner = planner;
    this.applyCalls = 0;
    this.verifyCalls = 0;
    this.closeCalls = 0;
    this.failApply = false;
    this.failVerify = false;
    this.lastBuildTasks = null;
  }

  async apply(token) {
    this.applyCalls += 1;
    const prepared = this.planner.consume(token);
    if (this.failApply) throw new Error("mock apply outcome unknown");
    return {
      Applied: true,
      Controller: prepared.Alias,
      ManifestSha256: "a".repeat(64),
      ControllerModified: true
    };
  }

  async freshVerification(prepared, tasks) {
    this.verifyCalls += 1;
    this.lastBuildTasks = tasks;
    if (this.failVerify) throw new Error("mock verify transport failure");
    return {
      ReadbackSucceeded: true,
      Passed: true,
      Identity: { Name: "4600-test" },
      State: {
        Opmode: "AUTO",
        ControllerState: "guardstop",
        RapidState: "stopped"
      },
      Verification: [{ Kind: "cfg_set", Passed: true }],
      Build: [{ Task: "T_ROB1", ErrorCount: 0, Passed: true }]
    };
  }

  close() {
    this.closeCalls += 1;
  }
}

function managerFixture(options = {}) {
  const planner = new MockPlanner(options);
  const executor = new MockExecutor(planner);
  const manager = new DirectChangesetManager({
    planner,
    executor,
    now: () => Date.parse("2029-12-31T00:00:00.000Z")
  });
  return { planner, executor, manager };
}

assert.equal(DirectChangesetManager.supports("prepare_changeset"), true);
assert.equal(DirectChangesetManager.supports("commit_job"), true);
assert.equal(DirectChangesetManager.supports("verify_changeset"), true);

{
  const { planner, executor, manager } = managerFixture();
  planner.prepare = async () => ({ Prepared: false, Preview: true,
    SafetyBlocked: true, Controller: "robot2", ControllerModified: false });
  const preview = await manager.plan({ changeset: changeset() });
  assert.equal(preview.Preview, true);
  assert.equal(manager.tokens.size, 0);
  assert.equal(executor.applyCalls, 0);
  await manager.close();
}
assert.equal(DirectChangesetManager.supports("start_rapid"), false);

{
  const { manager } = managerFixture();
  assert.equal(
    await manager.aliasFor("prepare_changeset", {
      changeset: changeset("robot-a")
    }),
    "robot-a"
  );
  assert.equal(
    await manager.aliasFor("verify_changeset", {
      changeset: changeset("robot-b")
    }),
    "robot-b"
  );
  await assert.rejects(
    manager.aliasFor("prepare_changeset", {
      changeset: changeset(" robot2 ")
    }),
    /trimmed registered alias/
  );
  await assert.rejects(
    manager.aliasFor("prepare_changeset", {
      changeset: changeset("__proto__")
    }),
    /trimmed registered alias/
  );
  await assert.rejects(
    manager.aliasFor("unknown_method", {}),
    /Unknown direct changeset method/
  );
  await assert.rejects(
    manager.call("unknown_method", {}),
    /Unknown direct changeset method/
  );
  await manager.close();
}

{
  const { planner, executor, manager } = managerFixture();
  const plan = await manager.call("prepare_changeset", {
    changeset: changeset()
  });

  assert.equal(
    await manager.aliasFor("commit_job", { token: plan.Token }),
    "robot2"
  );
  assert.equal(
    planner.consumeCalls,
    0,
    "pre-queue alias lookup must not consume an approval token"
  );
  assert.equal(planner.peekCalls, 1);

  const applied = await manager.call("commit_job", { token: plan.Token });
  assert.equal(applied.Applied, true);
  assert.equal(executor.applyCalls, 1);
  assert.equal(planner.consumeCalls, 1);
  assert.equal(planner.discardCalls, 1);
  assert.equal(planner.tokens.has(plan.Token), false);

  await assert.rejects(
    manager.aliasFor("commit_job", { token: plan.Token }),
    /already been used/
  );
  await assert.rejects(
    manager.call("commit_job", { token: plan.Token }),
    /already been used/
  );
  assert.equal(executor.applyCalls, 1);
  await manager.close();
}

{
  const { planner, executor, manager } = managerFixture();
  const result = await manager.call("verify_changeset", {
    changeset: changeset("robot-verify")
  });
  const temporaryToken = TOKENS[0];

  assert.equal(result.Verified, true);
  assert.equal(result.Controller, "robot-verify");
  assert.equal(result.ControllerModified, false);
  assert.equal(planner.prepareCalls, 0);
  assert.equal(planner.captureCalls, 1);
  assert.equal(planner.consumeCalls, 0);
  assert.equal(planner.discardCalls, 0);
  assert.equal(planner.tokens.has(temporaryToken), false);
  assert.equal(executor.verifyCalls, 1);
  assert.deepEqual(
    executor.lastBuildTasks,
    ["T_ROB1"],
    "verification must de-duplicate RAPID build checks case-insensitively"
  );
  await assert.rejects(
    manager.aliasFor("commit_job", { token: temporaryToken }),
    /Unknown prepared token/
  );
  await manager.close();
}

{
  const { planner, executor, manager } = managerFixture();
  executor.failVerify = true;
  await assert.rejects(
    manager.call("verify_changeset", {
      changeset: changeset("robot-verify-failure")
    }),
    /mock verify transport failure/
  );
  assert.equal(planner.consumeCalls, 0);
  assert.equal(planner.discardCalls, 0);
  assert.equal(planner.tokens.size, 0);
  await assert.rejects(
    manager.aliasFor("commit_job", { token: TOKENS[0] }),
    /Unknown prepared token/
  );
  await manager.close();
}

{
  const { planner, executor, manager } = managerFixture({
    withPeek: false,
    withDiscard: false
  });
  const plan = await manager.plan({ changeset: changeset("robot-compat") });
  assert.equal(
    await manager.aliasFor("commit_job", { token: plan.Token }),
    "robot-compat"
  );
  assert.equal(planner.consumeCalls, 0);

  await manager.verify({ changeset: changeset("robot-temp-compat") });
  assert.equal(planner.tokens.has(TOKENS[1]), false);
  await assert.rejects(
    manager.aliasFor("commit_job", { token: TOKENS[1] }),
    /Unknown prepared token/
  );

  await manager.close();
  assert.equal(planner.closeCalls, 1);
  assert.equal(executor.closeCalls, 1);
  assert.equal(planner.tokens.size, 0);
  await assert.rejects(
    manager.aliasFor("prepare_changeset", {
      changeset: changeset()
    }),
    /manager is closed/
  );
  await manager.close();
  assert.equal(planner.closeCalls, 1, "close must be idempotent");
}

{
  const { executor, manager } = managerFixture();
  executor.failApply = true;
  const plan = await manager.plan({
    changeset: changeset("robot-unknown-outcome")
  });
  await manager.aliasFor("commit_job", { token: plan.Token });
  await assert.rejects(
    manager.apply({ token: plan.Token }),
    /mock apply outcome unknown/
  );
  await assert.rejects(
    manager.aliasFor("commit_job", { token: plan.Token }),
    /already been used/
  );
  assert.equal(
    executor.applyCalls,
    1,
    "a started write must never be replayed after an unknown outcome"
  );
  await manager.close();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "direct-rws-changeset-manager",
      networkUsed: false,
      controllerUsed: false,
      cases: {
        methodAndInlineAliasRouting: true,
        applyAliasPeekBeforeConsume: true,
        applySingleUse: true,
        verifyWithoutWriteTokens: true,
        verifyBuildTaskDeduplication: true,
        missingPeekDiscardCompatibility: true,
        closeCleanup: true,
        unknownOutcomeNoReplay: true
      }
    },
    null,
    2
  )
);
