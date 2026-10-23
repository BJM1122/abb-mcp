import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DirectChangesetExecutor
} from "../direct-rws/changeset-executor.mjs";
import {
  DirectChangesetPlanner,
  MAX_ARTIFACT_BYTES
} from "../direct-rws/changeset-planner.mjs";

const SENTINEL_ROBTARGET =
  "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
  "[8.999999e+09,-8.999999e+09,8.9e9,-8.9e9,9000000000,-9000000000]]";
const NORMALIZED_SENTINEL_ROBTARGET =
  "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
  "[9E+09,-9E+09,9E+09,-9E+09,9E+09,-9E+09]]";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseChangeset(operations, restart) {
  const changeset = {
    version: 1,
    controller: "mock",
    expectedController: {
      name: "MOCK-ABB",
      systemId: "11111111-2222-3333-4444-555555555555",
      robotWare: "6.13.0164"
    },
    safety: {
      requireRapidStopped: true,
      allowedControllerStates: ["guardstop", "motoroff"]
    },
    operations
  };
  if (restart !== undefined) changeset.restart = restart;
  return changeset;
}

function pathParts(requestPath) {
  return requestPath
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
}

class MockAbb {
  constructor() {
    this.identity = {
      Name: "MOCK-ABB",
      SystemId: "11111111-2222-3333-4444-555555555555",
      RobotWare: "6.13.0164",
      Endpoint: "http://192.0.2.10/",
      ControllerLock: "registry-sha256:mock-v1"
    };
    this.state = {
      Opmode: "AUTO",
      ControllerState: "guardstop",
      RapidState: "stopped"
    };
    this.config = new Map();
    this.rapidData = new Map();
    this.modules = new Map();
    this.signals = new Map();
    this.files = new Map();
    this.calls = [];
    this.opens = [];
    this.closes = [];
    this.waits = [];
    this.failures = new Map();
    this.rapidSetInitTransform = (value) => value;
    this.nextSessionId = 1;
    this.metrics = {
      RequestCount: 0,
      SessionCreateCount: 0,
      ReconnectCount: 0,
      TimeoutCount: 0,
      TransportFailureCount: 0,
      CircuitFastFailCount: 0
    };

    this.setConfig("sio", "IP_SETTING", {
      Key: "PROFINET Network",
      InstanceId: "10",
      DeleteKey: "10",
      ReadOnly: false,
      Attributes: {
        Name: "PROFINET Network",
        Address: "192.0.2.100",
        StationName: "robot1"
      }
    });
    this.rapidData.set("t_rob1|mainmodule|p_start", "1");
    this.setModule(
      "T_ROB1",
      "ModuleA",
      "MODULE ModuleA\n  CONST num value := 1;\nENDMODULE\n"
    );
    this.setModule(
      "T_ROB1",
      "ModuleB",
      "MODULE ModuleB\n  CONST num value := 1;\nENDMODULE\n"
    );
  }

  cfgKey(domain, type) {
    return `${domain}|${type}`.toLowerCase();
  }

  setConfig(domain, type, instance) {
    const key = this.cfgKey(domain, type);
    const list = this.config.get(key) ?? [];
    const index = list.findIndex(
      (item) =>
        item.Key.toLowerCase() === instance.Key.toLowerCase() ||
        (item.InstanceId &&
          item.InstanceId.toLowerCase() === instance.InstanceId?.toLowerCase())
    );
    if (index < 0) list.push(clone(instance));
    else list[index] = clone(instance);
    this.config.set(key, list);
  }

  getConfig(domain, type, instance) {
    return (
      this.config
        .get(this.cfgKey(domain, type))
        ?.find(
          (item) =>
            item.Key.toLowerCase() === String(instance).toLowerCase() ||
            item.InstanceId.toLowerCase() === String(instance).toLowerCase()
        ) ?? null
    );
  }

  taskModules(task) {
    const key = task.toLowerCase();
    if (!this.modules.has(key)) this.modules.set(key, new Map());
    return this.modules.get(key);
  }

  setModule(task, name, source, type = "ProgMod") {
    this.taskModules(task).set(name.toLowerCase(), {
      Name: name,
      Type: type,
      Text: source
    });
  }

  failOnce(operation, action) {
    const list = this.failures.get(operation) ?? [];
    list.push(action);
    this.failures.set(operation, list);
  }

  count(operation) {
    return this.calls.filter((item) => item.operation === operation).length;
  }

  bumpRead() {
    this.metrics.RequestCount += 1;
  }

  readApi() {
    return {
      getMetrics: async () => clone(this.metrics),
      getIdentity: async () => {
        this.bumpRead();
        return clone(this.identity);
      },
      getControllerState: async () => {
        this.bumpRead();
        return clone(this.state);
      },
      getConfigInstances: async ({ domain, type }) => {
        this.bumpRead();
        return clone(this.config.get(this.cfgKey(domain, type)) ?? []);
      },
      getConfigInstance: async ({ domain, type, instance }) => {
        this.bumpRead();
        const value = this.getConfig(domain, type, instance);
        if (!value) {
          throw new Error(
            `Configuration instance not found: ${domain}/${type}/${instance}`
          );
        }
        return clone(value);
      },
      getRapidModules: async ({ task }) => {
        this.bumpRead();
        return [...this.taskModules(task).values()].map(({ Name, Type }) => ({
          Name,
          Type,
          Task: task
        }));
      },
      getRapidModuleText: async ({ task, module }) => {
        this.bumpRead();
        const value = this.taskModules(task).get(module.toLowerCase());
        if (!value) throw new Error(`RAPID module not found: ${task}/${module}`);
        return value.Text;
      },
      getRapidDataValue: async ({ task, module, name }) => {
        this.bumpRead();
        const key = `${task}|${module}|${name}`.toLowerCase();
        if (!this.rapidData.has(key)) throw new Error(`RAPID data not found: ${key}`);
        return this.rapidData.get(key);
      },
      getIoSignal: async ({ name }) => {
        this.bumpRead();
        if (!this.signals.has(name.toLowerCase())) {
          throw new Error(`Signal not found: ${name}`);
        }
        return clone(this.signals.get(name.toLowerCase()));
      }
    };
  }

  sessionApi() {
    return {
      openSession: async ({ controller, fresh }) => {
        const session = {
          id: this.nextSessionId++,
          controller,
          fresh,
          closed: false
        };
        this.opens.push({ id: session.id, controller, fresh });
        this.metrics.SessionCreateCount += 1;
        return session;
      },
      closeSession: async ({ session, logout }) => {
        if (session.closed) return;
        session.closed = true;
        this.closes.push({ id: session.id, logout });
      },
      executeDescriptor: async ({ session, descriptor }) => {
        assert.equal(session.closed, false, "descriptor used a closed session");
        this.calls.push({
          sessionId: session.id,
          operation: descriptor.operation,
          request: descriptor.request
        });
        this.metrics.RequestCount += 1;
        const failures = this.failures.get(descriptor.operation);
        if (failures?.length) {
          const action = failures.shift();
          if (action instanceof Error) throw action;
          if (typeof action === "function") {
            return await action({ session, descriptor });
          }
          return action;
        }
        return this.handleDescriptor(descriptor);
      },
      waitForRestart: async (args) => {
        this.waits.push(clone(args));
        return {
          Requested: true,
          Online: true,
          TimeoutSeconds: args.timeoutSeconds,
          OfflineObserved: args.transportUnknown === true,
          SettledMs: 4_000,
          ConsecutiveOnlineChecks: args.transportUnknown ? 0 : 2
        };
      }
    };
  }

  handleDescriptor(descriptor) {
    const { operation, request } = descriptor;
    const parts = pathParts(request.path);
    switch (operation) {
      case "mastershipRequest":
      case "mastershipRelease":
        return { statusCode: 204, body: "", headers: {} };

      case "fileMkdir":
        return { statusCode: 201, body: "", headers: {} };

      case "fileUpload":
        this.files.set(descriptor.ControllerPath, Buffer.from(request.bytes));
        return { statusCode: 201, body: "", headers: {} };

      case "fileDelete":
        for (const name of [...this.files.keys()]) {
          if (name.includes(`/${descriptor.relativePath}/`)) {
            this.files.delete(name);
          }
        }
        return { statusCode: 204, body: "", headers: {} };

      case "cfgSet": {
        const domain = parts[2];
        const type = parts[3];
        const instance = parts[5];
        const current = this.getConfig(domain, type, instance);
        if (!current) return { statusCode: 404, body: "missing", headers: {} };
        Object.assign(current.Attributes, request.form);
        return { statusCode: 204, body: "", headers: {} };
      }

      case "cfgCreateDefault": {
        const domain = parts[2];
        const type = parts[3];
        const instance = request.form.name;
        this.setConfig(domain, type, {
          Key: instance,
          InstanceId: instance,
          DeleteKey: instance,
          ReadOnly: false,
          Attributes: { Name: instance }
        });
        return {
          statusCode: 201,
          body:
            `<span class="instancename">${instance}</span>` +
            `<span class="instanceid">${instance}</span>`,
          headers: {}
        };
      }

      case "cfgDelete": {
        const domain = parts[2];
        const type = parts[3];
        const instance = parts[5];
        const key = this.cfgKey(domain, type);
        this.config.set(
          key,
          (this.config.get(key) ?? []).filter(
            (item) =>
              item.Key.toLowerCase() !== instance.toLowerCase() &&
              item.InstanceId.toLowerCase() !== instance.toLowerCase()
          )
        );
        return { statusCode: 204, body: "", headers: {} };
      }

      case "rapidSetInit": {
        const rapidIndex = parts.indexOf("RAPID");
        const [task, module, name] = parts.slice(rapidIndex + 1);
        this.rapidData.set(
          `${task}|${module}|${name}`.toLowerCase(),
          this.rapidSetInitTransform(request.form.value)
        );
        return { statusCode: 204, body: "", headers: {} };
      }

      case "rapidLoadModuleReplace": {
        const task = parts[3];
        const bytes = this.files.get(request.form.modulepath);
        assert.ok(bytes, `missing staged module ${request.form.modulepath}`);
        const source = bytes.toString("utf8");
        const module = source.match(/^\s*MODULE\s+([A-Za-z0-9_.-]+)/im)?.[1];
        assert.ok(module, "staged RAPID source has no module declaration");
        this.setModule(task, module, source);
        return { statusCode: 204, body: "", headers: {} };
      }

      case "rapidDeleteModule": {
        const task = parts[3];
        this.taskModules(task).delete(request.form.module.toLowerCase());
        return { statusCode: 204, body: "", headers: {} };
      }

      case "rapidBuild":
        return { statusCode: 204, body: "", headers: {} };

      case "rapidBuildErrors":
        return { statusCode: 200, body: "<html></html>", headers: {} };

      case "cfgValidate":
        return {
          statusCode: 200,
          body: '<span class="domain">eio</span>',
          headers: {}
        };

      case "cfgLoad":
        {
          const bytes = this.files.get(request.form.filepath);
          assert.ok(bytes, `missing staged CFG ${request.form.filepath}`);
          const source = bytes.toString("utf8");
          const signalSection = source.match(
            /EIO_SIGNAL:\s*([\s\S]*?)(?:\r?\n#|$)/i
          )?.[1];
          if (signalSection) {
            const fields = {};
            for (const match of signalSection.matchAll(
              /-([A-Za-z0-9_]+)\s+(?:"([^"]*)"|([^\s\\]+))/g
            )) {
              fields[match[1]] = match[2] ?? match[3];
            }
            if (fields.Name) {
              this.setConfig("eio", "EIO_SIGNAL", {
                Key: fields.Name,
                InstanceId: fields.Name,
                DeleteKey: fields.Name,
                ReadOnly: false,
                Attributes: fields
              });
            }
          }
        }
        return { statusCode: 204, body: "", headers: {} };

      case "ordinaryRestart":
        return { statusCode: 204, body: "", headers: {} };

      default:
        throw new Error(`Unhandled mock descriptor: ${operation}`);
    }
  }
}

function createHarness(root) {
  const mock = new MockAbb();
  const readApi = mock.readApi();
  let tokenNumber = 0;
  const planner = new DirectChangesetPlanner({
    readApi,
    allowedConfigDomains: ["eio", "sio", "sys", "proc"],
    allowedLocalRoots: [root],
    tokenFactory: () => (++tokenNumber).toString(16).padStart(32, "0")
  });
  const executor = new DirectChangesetExecutor({
    planner,
    readApi,
    sessionApi: mock.sessionApi(),
    now: () => Date.parse("2026-07-29T01:02:03.000Z")
  });
  return { mock, planner, executor };
}

const temp = await mkdtemp(
  path.join(os.tmpdir(), "abb-direct-changeset-executor-")
);
const jobs = path.join(temp, "jobs");
await mkdir(jobs, { recursive: true });
const moduleAPath = path.join(jobs, "ModuleA.mod");
const moduleBPath = path.join(jobs, "ModuleB.mod");
const moduleCasePath = path.join(jobs, "ModuleCase.mod");
const cfgPath = path.join(jobs, "Signals.cfg");
const oversizedPath = path.join(jobs, "Oversized.mod");
await writeFile(
  moduleAPath,
  Buffer.from("MODULE ModuleA\r\n  CONST num value := 2;\r\nENDMODULE\r\n")
);
const oversizedHandle = await open(oversizedPath, "w");
await oversizedHandle.truncate(MAX_ARTIFACT_BYTES + 1);
await oversizedHandle.close();
await writeFile(
  moduleBPath,
  Buffer.from("MODULE ModuleB\r\n  CONST num value := 2;\r\nENDMODULE\r\n")
);
await writeFile(
  moduleCasePath,
  Buffer.from(
    'MODULE ModuleCase\r\n  CONST string value := "Robot2";\r\nENDMODULE\r\n'
  )
);
await writeFile(
  cfgPath,
  Buffer.from(
    [
      "EIO:CFG_1.0:6:1::",
      "#",
      "EIO_SIGNAL:",
      '  -Name "SigNew" -SignalType "DO" -Device "PN" -DeviceMap "0"',
      "#",
      ""
    ].join("\r\n")
  )
);

try {
  {
    const { mock, planner, executor } = createHarness(temp);
    const manifest = baseChangeset([{ kind: "rapid_module_put", task: "T_ROB1",
      module: "ModuleA", localPath: moduleAPath }]);
    for (const state of [
      { Opmode: "AUTO", ControllerState: "motoron", RapidState: "running" },
      { Opmode: "AUTO", ControllerState: "motoron", RapidState: "stopped" },
      { Opmode: "AUTO", ControllerState: "emergencystop", RapidState: "stopped" },
      { Opmode: "", ControllerState: "motoroff", RapidState: "stopped" }
    ]) {
      mock.state = state;
      const preview = await planner.prepare(manifest);
      assert.equal(preview.Prepared, false);
      assert.equal(preview.Preview, true);
      assert.equal(preview.SafetyBlocked, true);
      assert.equal(Object.hasOwn(preview, "Token"), false);
      assert.ok(preview.WriteBlockers.length > 0);
      assert.ok(preview.Operations[0].SourceDiff);
      assert.equal(planner.prepared.size, 0);
    }
    await assert.rejects(planner.prepare({ ...manifest,
      safety: { requireRapidStopped: false, allowedControllerStates: ["motoroff"] }
    }), /require RAPID stopped/);
    mock.state = { Opmode: "AUTO", ControllerState: "motoroff", RapidState: "stopped" };
    const plan = await planner.prepare(manifest);
    mock.state = { Opmode: "AUTO", ControllerState: "motoron", RapidState: "running" };
    const blocked = await executor.apply(plan.Token);
    assert.equal(blocked.Applied, false);
    assert.match(blocked.Failure, /Unsafe controller state/);
    assert.equal(mock.count("mastershipRequest"), 0);
    assert.equal(mock.count("rapidLoadModuleReplace"), 0);

    mock.setModule("T_ROB1", "ModuleA", "MODULE ModuleA\n  CONST num value := 2;\nENDMODULE\n");
    const { prepared } = await planner.capture(manifest);
    const verified = await executor.freshVerification(prepared, ["T_ROB1"]);
    assert.equal(verified.Passed, true);
    assert.equal(verified.State.RapidState, "running");
    assert.equal(mock.count("mastershipRequest"), 0);
    mock.identity.Name = "DIFFERENT-CABINET";
    const mismatch = await executor.freshVerification(prepared, []);
    assert.equal(mismatch.ReadbackSucceeded, false);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_set",
            domain: "sio",
            type: "IP_SETTING",
            instance: "PROFINET Network",
            fields: {
              Address: "192.0.2.101",
              StationName: "robot2"
            }
          },
          {
            kind: "rapid_set_init",
            task: "T_ROB1",
            module: "MainModule",
            name: "P_start",
            value: "2"
          },
          {
            kind: "rapid_module_put",
            task: "T_ROB1",
            module: "ModuleA",
            localPath: moduleAPath
          },
          {
            kind: "rapid_module_put",
            task: "T_ROB1",
            module: "ModuleB",
            localPath: moduleBPath
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    assert.equal(plan.ChangesRequired, 4);
    assert.equal(planner.peek(plan.Token).Alias, "mock");
    assert.equal(plan.Identity.Endpoint, "http://192.0.2.10/");
    assert.equal(plan.Identity.ControllerLock, "registry-sha256:mock-v1");

    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(applied.Verified, true);
    assert.equal(applied.VerificationMode, "independent-session");
    assert.equal(applied.ControllerModified, true);
    assert.equal(applied.ControllerWriteUnknown, false);
    assert.equal(applied.ChangedOperationCount, 4);
    assert.equal(mock.count("mastershipRequest"), 1);
    assert.equal(mock.count("mastershipRelease"), 1);
    assert.equal(mock.count("cfgSet"), 1);
    assert.equal(mock.count("rapidSetInit"), 1);
    assert.equal(mock.count("rapidLoadModuleReplace"), 2);
    assert.equal(mock.count("rapidBuild"), 1, "task was built more than once");
    assert.equal(mock.count("ordinaryRestart"), 1);
    assert.equal(mock.waits.length, 1);
    assert.equal(mock.count("fileDelete"), 1);
    assert.equal(mock.files.size, 0);
    assert.ok(mock.opens.some((item) => item.fresh === true));
    assert.equal(
      mock.getConfig("sio", "IP_SETTING", "PROFINET Network").Attributes.Address,
      "192.0.2.101"
    );
    assert.equal(
      mock.getConfig("sio", "IP_SETTING", "PROFINET Network").Attributes.StationName,
      "robot2"
    );
    assert.match(
      mock.taskModules("T_ROB1").get("modulea").Text,
      /value := 2/
    );
    assert.ok(applied.Verification.every((item) => item.Passed));
    assert.ok(applied.BuildVerification.every((item) => item.Passed));
    assert.equal(planner.prepared.size, 0, "consumed artifact bytes were retained");
    assert.equal(planner.usedTokens.size, 1, "used-token tombstone was not kept");

    await assert.rejects(
      executor.apply(plan.Token),
      /already been used/i,
      "a consumed token was accepted twice"
    );
    assert.equal(mock.count("cfgSet"), 1, "token replay repeated a mutation");
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    mock.rapidSetInitTransform = (value) =>
      value === SENTINEL_ROBTARGET
        ? NORMALIZED_SENTINEL_ROBTARGET
        : value;
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: SENTINEL_ROBTARGET
        }
      ])
    );
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(
      mock.rapidData.get("t_rob1|mainmodule|p_start"),
      NORMALIZED_SENTINEL_ROBTARGET
    );
    assert.equal(
      applied.Verification.find((item) => item.Kind === "rapid_set_init")
        ?.Passed,
      true,
      "Equivalent robtarget extax sentinel normalization failed verification."
    );
  }

  {
    const verificationCases = [
      {
        label: "ordinary robtarget numeric mismatch",
        desired: SENTINEL_ROBTARGET,
        actual: NORMALIZED_SENTINEL_ROBTARGET.replace("544.2", "544.3")
      },
      {
        label: "sentinel-sized number outside extax remains exact",
        desired: SENTINEL_ROBTARGET.replace("544.2", "8.999999e+09"),
        actual: NORMALIZED_SENTINEL_ROBTARGET.replace("544.2", "9E+09")
      },
      {
        label: "ordinary extax numeric mismatch",
        desired:
          "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
          "[0,1,2,3,4,5]]",
        actual:
          "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
          "[0,1,2,3,4,6]]"
      },
      {
        label: "incomplete robtarget structure",
        desired: SENTINEL_ROBTARGET,
        actual:
          "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0]," +
          "[1,9E+09,-9E+09,9E+09,-9E+09,9E+09,-9E+09]]"
      },
      {
        label: "non-robtarget string case mismatch",
        desired: "true",
        actual: "TRUE"
      }
    ];

    for (const scenario of verificationCases) {
      const { mock, planner, executor } = createHarness(temp);
      const plan = await planner.prepare(
        baseChangeset([
          {
            kind: "rapid_set_init",
            task: "T_ROB1",
            module: "MainModule",
            name: "P_start",
            value: scenario.desired
          }
        ])
      );
      const prepared = planner.consume(plan.Token);
      mock.rapidData.set("t_rob1|mainmodule|p_start", scenario.actual);
      const readback = await executor.freshVerification(prepared, []);
      assert.equal(readback.ReadbackSucceeded, true, scenario.label);
      assert.equal(readback.Passed, false, scenario.label);
      assert.equal(
        readback.Verification.find((item) => item.Kind === "rapid_set_init")
          ?.Passed,
        false,
        scenario.label
      );
      assert.equal(planner.discard(plan.Token), true);
    }
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: "1"
        }
      ])
    );
    assert.equal(plan.ChangesRequired, 0);
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(applied.NoOp, true);
    assert.equal(mock.count("mastershipRequest"), 0);
    assert.equal(mock.count("rapidSetInit"), 0);
    assert.equal(mock.opens.length, 1, "no-op opened a redundant session");
    assert.equal(mock.opens[0].fresh, true);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    mock.rapidData.set("t_rob1|mainmodule|case_value", "TRUE");
    mock.setModule(
      "T_ROB1",
      "ModuleCase",
      'MODULE ModuleCase\n  CONST string value := "robot2";\nENDMODULE\n'
    );
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_set",
            domain: "sio",
            type: "IP_SETTING",
            instance: "PROFINET Network",
            fields: { StationName: "Robot1" }
          },
          {
            kind: "rapid_set_init",
            task: "T_ROB1",
            module: "MainModule",
            name: "case_value",
            value: "true"
          },
          {
            kind: "rapid_module_put",
            task: "T_ROB1",
            module: "ModuleCase",
            localPath: moduleCasePath
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    assert.equal(plan.ChangesRequired, 3);
    assert.ok(
      plan.Operations.every((operation) => operation.NeedsChange === true),
      "case-only configuration/RAPID differences were treated as no-ops"
    );

    const prepared = planner.consume(plan.Token);
    const readback = await executor.freshVerification(prepared, []);
    assert.equal(readback.ReadbackSucceeded, true);
    assert.equal(readback.Passed, false);
    for (const kind of [
      "cfg_set",
      "rapid_set_init",
      "rapid_module_put"
    ]) {
      assert.equal(
        readback.Verification.find((item) => item.Kind === kind)?.Passed,
        false,
        `${kind} case-only mismatch passed fresh verification`
      );
    }
    assert.equal(planner.discard(plan.Token), true);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_set",
            domain: "sio",
            type: "IP_SETTING",
            instance: "PROFINET Network",
            fields: { Address: "192.0.2.101" }
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    mock.getConfig(
      "sio",
      "IP_SETTING",
      "PROFINET Network"
    ).Attributes.Address = "192.0.2.77";
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, false);
    assert.equal(failed.ControllerModified, false);
    assert.equal(failed.ControllerWriteUnknown, false);
    assert.match(failed.Failure, /precondition changed/i);
    assert.equal(mock.count("mastershipRequest"), 1);
    assert.equal(mock.count("mastershipRelease"), 1);
    assert.equal(mock.count("cfgSet"), 0);
    assert.equal(mock.count("ordinaryRestart"), 0);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: "2"
        }
      ])
    );
    const reset = new Error("socket reset before an HTTP response");
    reset.code = "ECONNRESET";
    mock.failOnce("rapidSetInit", reset);
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, true);
    assert.equal(failed.ControllerModified, false);
    assert.equal(failed.ControllerWriteUnknown, true);
    assert.match(failed.Failure, /^ControllerWriteUnknown:/);
    assert.equal(mock.count("rapidSetInit"), 1, "unknown mutation was replayed");
    assert.equal(
      mock.rapidData.get("t_rob1|mainmodule|p_start"),
      "1"
    );
    assert.equal(failed.NeedsFreshPlan, true);
    assert.ok(failed.PostFailureReadback);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "ModuleA",
          localPath: moduleAPath
        }
      ])
    );
    mock.failOnce("fileMkdir", ({ descriptor }) => {
      mock.handleDescriptor(descriptor);
      const reset = new Error("mkdir response lost after controller acceptance");
      reset.code = "ECONNRESET";
      throw reset;
    });
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, true);
    assert.equal(failed.ControllerWriteUnknown, true);
    assert.match(failed.Failure, /^ControllerWriteUnknown:/);
    assert.equal(mock.count("fileMkdir"), 1, "unknown mkdir was replayed");
    assert.equal(mock.count("fileUpload"), 0);
    assert.equal(mock.count("rapidLoadModuleReplace"), 0);
    assert.equal(mock.count("fileDelete"), 1, "possible staging directory was not cleaned");
    assert.equal(failed.StagingCleanup.Attempted, true);
    assert.equal(failed.StagingCleanup.Removed, true);
    assert.equal(
      failed.Results.find((item) => item.Kind === "staging_create")
        ?.ControllerWriteUnknown,
      true
    );
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "ModuleA",
          localPath: moduleAPath
        }
      ])
    );
    mock.failOnce("fileUpload", ({ descriptor }) => {
      mock.handleDescriptor(descriptor);
      const reset = new Error("upload response lost after controller acceptance");
      reset.code = "ECONNRESET";
      throw reset;
    });
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, true);
    assert.equal(failed.ControllerWriteUnknown, true);
    assert.match(failed.Failure, /^ControllerWriteUnknown:/);
    assert.equal(mock.count("fileUpload"), 1, "unknown upload was replayed");
    assert.equal(mock.count("rapidLoadModuleReplace"), 0);
    assert.equal(mock.count("fileDelete"), 1);
    assert.equal(failed.StagingCleanup.Removed, true);
    assert.equal(mock.files.size, 0);
    assert.equal(
      failed.Results.find((item) => item.Kind === "staging_upload")
        ?.ControllerWriteUnknown,
      true
    );
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "ModuleA",
          localPath: moduleAPath
        }
      ])
    );
    mock.failOnce("fileDelete", ({ descriptor }) => {
      mock.handleDescriptor(descriptor);
      const reset = new Error("cleanup response lost after controller acceptance");
      reset.code = "ECONNRESET";
      throw reset;
    });
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(applied.ControllerModified, true);
    assert.equal(applied.ControllerWriteUnknown, true);
    assert.equal(applied.PartialApply, true);
    assert.equal(applied.NeedsFreshPlan, true);
    assert.equal(applied.WriteOutcomeInitiallyUnknown, true);
    assert.equal(mock.count("fileDelete"), 1, "unknown cleanup was replayed");
    assert.equal(applied.StagingCleanup.Attempted, true);
    assert.equal(applied.StagingCleanup.Removed, false);
    assert.equal(applied.StagingCleanup.OutcomeUnknown, true);
    assert.equal(applied.StagingCleanup.ControllerWriteUnknown, true);
    assert.match(applied.StagingCleanup.Error, /^ControllerWriteUnknown:/);
    assert.equal(mock.files.size, 0);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    mock.rapidData.set("t_rob1|mainmodule|second", "1");
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: "2"
        },
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "Second",
          value: "2"
        }
      ])
    );
    mock.failOnce("rapidSetInit", ({ descriptor }) =>
      mock.handleDescriptor(descriptor)
    );
    mock.failOnce("rapidSetInit", {
      statusCode: 500,
      body: "explicit controller rejection",
      headers: {}
    });
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, true);
    assert.equal(failed.ControllerModified, true);
    assert.equal(failed.ControllerWriteUnknown, false);
    assert.match(failed.Failure, /failed HTTP 500/i);
    assert.equal(mock.count("rapidSetInit"), 2);
    assert.equal(
      mock.rapidData.get("t_rob1|mainmodule|p_start"),
      "2"
    );
    assert.equal(
      mock.rapidData.get("t_rob1|mainmodule|second"),
      "1"
    );
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const createdInstanceId = "4711";
    mock.failOnce("cfgCreateDefault", ({ descriptor }) => {
      const parts = pathParts(descriptor.request.path);
      const logicalName = descriptor.request.form.name;
      mock.setConfig(parts[2], parts[3], {
        Key: logicalName,
        InstanceId: createdInstanceId,
        DeleteKey: createdInstanceId,
        ReadOnly: false,
        Attributes: { Name: logicalName }
      });
      return {
        statusCode: 201,
        body:
          `<span class="instancename">${logicalName}</span>` +
          `<span class="instanceid">${createdInstanceId}</span>`,
        headers: {}
      };
    });
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_upsert",
            domain: "eio",
            type: "EIO_SIGNAL",
            instance: "PF_NEW",
            fields: {
              Name: "PF_NEW",
              SignalType: "DO",
              Device: "PN",
              DeviceMap: "88"
            }
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(mock.count("cfgCreateDefault"), 1);
    assert.equal(mock.count("cfgSet"), 1);
    const setCall = mock.calls.find((item) => item.operation === "cfgSet");
    assert.equal(
      pathParts(setCall.request.path)[5],
      createdInstanceId,
      "cfg_upsert set guessed the logical name instead of using InstanceId"
    );
    const upsertResult = applied.Results.find(
      (item) => item.Kind === "cfg_upsert"
    );
    assert.equal(upsertResult.CreatedInstanceId, createdInstanceId);
    assert.equal(upsertResult.SetInstance, createdInstanceId);
    assert.equal(
      mock.getConfig("eio", "EIO_SIGNAL", "PF_NEW").Attributes.DeviceMap,
      "88",
      "fresh verification could not read the logical instance name"
    );
    assert.ok(applied.Verification.every((item) => item.Passed));
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    mock.failOnce("cfgCreateDefault", ({ descriptor }) => {
      const parts = pathParts(descriptor.request.path);
      const logicalName = descriptor.request.form.name;
      mock.setConfig(parts[2], parts[3], {
        Key: logicalName,
        InstanceId: "8128",
        DeleteKey: "8128",
        ReadOnly: false,
        Attributes: { Name: logicalName }
      });
      return {
        statusCode: 201,
        body: `<span class="instancename">${logicalName}</span>`,
        headers: {}
      };
    });
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_upsert",
            domain: "eio",
            type: "EIO_SIGNAL",
            instance: "PF_NO_ID",
            fields: { Name: "PF_NO_ID", SignalType: "DO" }
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, true);
    assert.equal(failed.ControllerModified, true);
    assert.match(failed.Failure, /omitted InstanceId/i);
    assert.equal(mock.count("cfgCreateDefault"), 1);
    assert.equal(mock.count("cfgSet"), 0, "missing InstanceId guessed a set path");
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_file_load",
            domain: "eio",
            actionType: "add",
            localPath: cfgPath,
            verify: {
              configSignals: [
                {
                  name: "SigNew",
                  fields: {
                    SignalType: "DO",
                    Device: "PN",
                    DeviceMap: "0"
                  }
                }
              ]
            }
          },
          {
            kind: "rapid_set_init",
            task: "T_ROB1",
            module: "MainModule",
            name: "P_start",
            value: "2"
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    mock.failOnce("cfgLoad", ({ descriptor }) => {
      mock.handleDescriptor(descriptor);
      const reset = new Error("RW6 reset RWS after accepting CFG load");
      reset.code = "ECONNRESET";
      throw reset;
    });
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(applied.ControllerWriteUnknown, false);
    assert.equal(applied.WriteOutcomeInitiallyUnknown, true);
    assert.equal(mock.count("cfgLoad"), 1, "unknown CFG load was replayed");
    assert.equal(mock.count("mastershipRequest"), 2);
    assert.equal(mock.count("mastershipRelease"), 2);
    const cfgCall = mock.calls.find((item) => item.operation === "cfgLoad");
    const rapidCall = mock.calls.find(
      (item) => item.operation === "rapidSetInit"
    );
    assert.notEqual(
      cfgCall.sessionId,
      rapidCall.sessionId,
      "remaining writes reused the CFG-load RWS session"
    );
    const cfgResult = applied.Results.find(
      (item) => item.Kind === "cfg_file_load"
    );
    assert.equal(cfgResult.WriteOutcomeInitiallyUnknown, true);
    assert.equal(cfgResult.Verification.Passed, true);
    assert.ok(mock.getConfig("eio", "EIO_SIGNAL", "SigNew"));
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_set",
            domain: "sio",
            type: "IP_SETTING",
            instance: "PROFINET Network",
            fields: { Address: "192.0.2.101" }
          }
        ],
        {
          required: true,
          mode: "restart",
          timeoutSeconds: 60
        }
      )
    );
    mock.failOnce("ordinaryRestart", ({ descriptor }) => {
      mock.handleDescriptor(descriptor);
      const reset = new Error("restart response connection reset");
      reset.code = "ECONNRESET";
      throw reset;
    });
    const applied = await executor.apply(plan.Token);
    assert.equal(applied.Applied, true);
    assert.equal(applied.ControllerWriteUnknown, false);
    assert.equal(applied.WriteOutcomeInitiallyUnknown, true);
    assert.equal(mock.count("ordinaryRestart"), 1, "restart was replayed");
    assert.equal(mock.waits.length, 1);
    assert.equal(mock.waits[0].transportUnknown, true);
    assert.equal(
      applied.Results.find((item) => item.Kind === "restart").Result
        .OfflineObserved,
      true
    );
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: "2"
        }
      ])
    );
    mock.identity.Endpoint = "http://192.0.2.11/";
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.equal(failed.PartialApply, false);
    assert.match(failed.Failure, /CONTROLLER ENDPOINT MISMATCH/);
    assert.equal(mock.count("mastershipRequest"), 0);
    assert.equal(mock.count("rapidSetInit"), 0);
  }

  {
    const { mock, planner, executor } = createHarness(temp);
    delete mock.identity.Endpoint;
    delete mock.identity.ControllerLock;
    const plan = await planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "P_start",
          value: "2"
        }
      ])
    );
    const failed = await executor.apply(plan.Token);
    assert.equal(failed.Applied, false);
    assert.match(
      failed.Failure,
      /must contain both Endpoint and ControllerLock/i
    );
    assert.equal(mock.count("mastershipRequest"), 0);
  }

  {
    const { planner } = createHarness(temp);
    await assert.rejects(
      planner.prepare(
        baseChangeset([
          {
            kind: "rapid_module_put",
            task: "T_ROB1",
            module: "Oversized",
            localPath: oversizedPath
          }
        ])
      ),
      new RegExp(`${MAX_ARTIFACT_BYTES}-byte planning limit`),
      "oversized artifact was read into the prepared token"
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        offlineOnly: true,
        scenarios: [
          "mixed batched success with one task build and one restart",
          "robtarget extax invalid-sentinel normalization remains exact elsewhere",
          "no-op fresh-session verification",
          "case-only content differences require change and fail fresh verification",
          "post-mastership optimistic-lock race",
          "unknown mutation is never replayed",
          "mkdir response loss is unknown and cleaned without replay",
          "upload response loss is unknown and cleaned without replay",
          "cleanup response loss is reported without replay",
          "known rejection after partial apply",
          "cfg_upsert uses create-default InstanceId for set",
          "cfg_upsert without InstanceId fails closed",
          "RW6 CFG load response loss resolved by fresh-session readback",
          "restart response loss is not replayed and requires offline recovery",
          "endpoint identity-lock mismatch",
          "legacy identity without endpoint or controller lock fails closed",
          "oversized artifact rejected before file read"
        ]
      },
      null,
      2
    )
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
