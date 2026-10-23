import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DirectChangesetServiceAdapter,
  createDirectChangesetServiceApis
} from "../direct-rws/changeset-service-adapter.mjs";
import { DirectChangesetExecutor } from "../direct-rws/changeset-executor.mjs";
import { DirectChangesetManager } from "../direct-rws/changeset-manager.mjs";
import { DirectChangesetPlanner } from "../direct-rws/changeset-planner.mjs";
import {
  changesetPolicySignature,
  changesetPolicySnapshot
} from "../direct-rws/changeset-policy.mjs";
import { createDirectChangesetStack } from "../direct-rws/changeset-stack.mjs";
import { Rws1WriteAdapter } from "../direct-rws/rws1-write-adapter.mjs";
import { DirectRwsService } from "../direct-rws/service.mjs";

const SYSTEM_ID = "11111111-2222-3333-4444-555555555555";
const SENTINEL_ROBTARGET =
  "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
  "[8.999999e+09,-8.999999e+09,8.9e9,-8.9e9,9000000000,-9000000000]]";
const NORMALIZED_SENTINEL_ROBTARGET =
  "[[544.2,-94.01,953.61],[0.5,0.5,0.5,0.5],[0,0,0,1]," +
  "[9E+09,-9E+09,9E+09,-9E+09,9E+09,-9E+09]]";
const controllerModel = {
  rapidRevision: "7",
  normalizeRapidExtaxSentinels: false
};

function jsonResponse(state, extra = {}) {
  return {
    statusCode: 200,
    headers: {},
    body: JSON.stringify({
      _embedded: { _state: Array.isArray(state) ? state : [state] },
      ...extra
    })
  };
}

class FakeDigestClient {
  constructor(config, serial) {
    this.config = config;
    this.serial = serial;
    this.closed = false;
    this.requests = [];
    this.closeCalls = [];
    this.failOnce = null;
  }

  async request(options) {
    if (this.closed) {
      const error = new Error("fake session closed");
      error.code = "ECONNRESET";
      throw error;
    }
    this.requests.push({
      method: String(options.method || "GET"),
      path: String(options.path),
      timeoutMs: Number(options.timeoutMs || 0)
    });
    if (this.failOnce && String(options.path).includes(this.failOnce.path)) {
      const failure = this.failOnce;
      this.failOnce = null;
      const error = new Error(failure.message);
      error.code = failure.code;
      throw error;
    }

    const requestPath = String(options.path);
    if (requestPath === "/rw/system?json=1") {
      return jsonResponse({
        name: "MOCK-ABB",
        sysid: `{${SYSTEM_ID}}`,
        rwversion: "6.13.0164"
      });
    }
    if (requestPath === "/rw/panel/opmode?json=1") {
      return jsonResponse({ opmode: "AUTO" });
    }
    if (requestPath === "/rw/panel/ctrlstate?json=1") {
      return jsonResponse({ ctrlstate: "guardstop" });
    }
    if (requestPath === "/rw/rapid/execution?json=1") {
      return jsonResponse({ ctrlexecstate: "stopped" });
    }
    if (
      String(options.method).toUpperCase() === "GET" &&
      requestPath.startsWith(
        "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/PROFINET"
      )
    ) {
      return jsonResponse({
        _title: "PROFINET",
        instanceid: "11",
        rdonly: "false",
        attrib: [
          { _title: "Name", value: "PROFINET" },
          { _title: "Address", value: "192.0.2.100" },
          { _title: "StationName", value: "robot2" }
        ]
      });
    }
    if (
      String(options.method).toUpperCase() === "GET" &&
      requestPath.startsWith(
        "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances?"
      )
    ) {
      return jsonResponse([
        {
          _title: "PROFINET",
          instanceid: "11",
          rdonly: "false",
          attrib: [
            { _title: "Name", value: "PROFINET" },
            { _title: "Address", value: "192.0.2.100" },
            { _title: "StationName", value: "robot2" }
          ]
        }
      ]);
    }
    if (requestPath.startsWith("/rw/rapid/modules?")) {
      return jsonResponse([
        { name: "MainModule", type: "ProgMod" },
        { name: "WorldZone", type: "SysMod" }
      ]);
    }
    if (requestPath.startsWith("/rw/rapid/modules/MainModule?")) {
      return {
        statusCode: 200,
        headers: {},
        body:
          '<html><body><span class="text">MODULE MainModule\n' +
          "ENDMODULE</span></body></html>"
      };
    }
    if (
      String(options.method).toUpperCase() === "GET" &&
      requestPath.startsWith(
        "/rw/rapid/symbol/data/RAPID/T_ROB1/MainModule/Revision"
      )
    ) {
      return jsonResponse({
        _type: "rap-data",
        value: controllerModel.rapidRevision
      });
    }
    if (
      requestPath.startsWith(
        "/rw/iosystem/signals/PROFINET/PN_Internal_Device/PF_READY"
      )
    ) {
      return jsonResponse({
        _title: "PROFINET/PN_Internal_Device/PF_READY",
        name: "PF_READY",
        lvalue: "1",
        lstate: "high",
        phstate: "high",
        quality: "good",
        simstate: "not-simulated"
      });
    }

    if (requestPath === "/rw/mastership?action=request") {
      return { statusCode: 204, headers: {}, body: "" };
    }
    if (requestPath === "/rw/mastership?action=release") {
      return { statusCode: 204, headers: {}, body: "" };
    }
    if (
      requestPath.includes("?action=set") ||
      requestPath.includes("?action=setInitValue") ||
      requestPath.includes("?action=validate") ||
      requestPath.includes("?action=load") ||
      requestPath.includes("?action=restart") ||
      requestPath.includes("?action=build") ||
      requestPath.includes("?action=unloadmod") ||
      requestPath.includes("?action=loadmod")
    ) {
      if (requestPath.includes("?action=setInitValue")) {
        const requested = String(options.form?.value ?? "");
        controllerModel.rapidRevision =
          controllerModel.normalizeRapidExtaxSentinels &&
          requested === SENTINEL_ROBTARGET
            ? NORMALIZED_SENTINEL_ROBTARGET
            : requested;
      }
      return { statusCode: 204, headers: {}, body: "" };
    }
    if (requestPath.startsWith("/fileservice/")) {
      const statusCode =
        String(options.method).toUpperCase() === "PUT" ? 201 : 204;
      return { statusCode, headers: {}, body: "" };
    }

    throw new Error(`Unexpected fake RWS request: ${requestPath}`);
  }

  async requestOk(options, operation, allowed = [200]) {
    const response = await this.request(options);
    if (!allowed.includes(response.statusCode)) {
      throw new Error(`${operation} failed HTTP ${response.statusCode}`);
    }
    return response;
  }

  async close({ logout = true } = {}) {
    this.closeCalls.push({ logout });
    this.closed = true;
  }
}

function registry(requestTimeoutSeconds = 3) {
  return {
    version: 1,
    allowedConfigDomains: ["eio", "sio", "sys", "proc"],
    allowedLocalRoots: [
      "C:\\ABB_MCP_DATA"
    ],
    controllers: {
      mock: {
        baseUrl: "http://192.0.2.10/",
        expectedName: "MOCK-ABB",
        expectedSystemId: SYSTEM_ID,
        expectedRobotWare: "6.13.0164",
        rwsProtocol: "rws1",
        username: "Default User",
        credentialFile: "mock-only.clixml",
        defaultTask: "T_ROB1",
        ioNetwork: "PROFINET",
        ioDevice: "PN_Internal_Device",
        requestTimeoutSeconds,
        longRequestTimeoutSeconds: 17
      }
    }
  };
}

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "abb-changeset-service-adapter-")
);
const registryPath = path.join(temporary, "controller-registry.json");
await writeFile(registryPath, `${JSON.stringify(registry(3), null, 2)}\n`);

const service = new DirectRwsService({ registryPath });
const clients = [];
service.newClient = async (config) => {
  const client = new FakeDigestClient(config, clients.length + 1);
  clients.push(client);
  return client;
};

try {
  const generationPolicy = changesetPolicySnapshot(registry(3));
  assert.equal(Object.isFrozen(generationPolicy), true);
  assert.equal(Object.isFrozen(generationPolicy.allowedConfigDomains), true);
  assert.equal(Object.isFrozen(generationPolicy.allowedLocalRoots), true);
  assert.equal(
    changesetPolicySignature(generationPolicy),
    changesetPolicySignature(registry(3)),
    "Policy signatures must accept either a registry or its immutable snapshot."
  );
  assert.throws(
    () => generationPolicy.allowedConfigDomains.push("moc"),
    TypeError,
    "A changeset generation policy must not be mutable after construction."
  );
  assert.throws(
    () => changesetPolicySnapshot({
      allowedConfigDomains: ["eio"],
      allowedLocalRoots: [" "]
    }),
    /allowedLocalRoots.*non-empty strings/i
  );

  assert.throws(
    () => new DirectChangesetServiceAdapter({ service }),
    /protocol must be explicit/i
  );
  const rws2OnlyAdapter = new DirectChangesetServiceAdapter({
    service,
    protocol: "rws2"
  });
  await assert.rejects(
    rws2OnlyAdapter.controllerLock("mock"),
    /outside this changeset stack's rws2 protocol lock/i
  );

  const { adapter, readApi, sessionApi } =
    createDirectChangesetServiceApis({
      service,
      policy: generationPolicy,
      protocol: "rws1"
    });

  const missingProtocolRegistry = registry(3);
  delete missingProtocolRegistry.controllers.mock.rwsProtocol;
  await writeFile(
    registryPath,
    `${JSON.stringify(missingProtocolRegistry, null, 2)}\n`
  );
  await assert.rejects(
    adapter.controllerLock("mock"),
    /protocol must be explicit/i
  );
  const rws2Registry = registry(3);
  rws2Registry.controllers.mock.rwsProtocol = "rws2";
  await writeFile(
    registryPath,
    `${JSON.stringify(rws2Registry, null, 2)}\n`
  );
  await assert.rejects(
    adapter.controllerLock("mock"),
    /outside this changeset stack's rws1 protocol lock/i
  );
  await writeFile(
    registryPath,
    `${JSON.stringify(registry(3), null, 2)}\n`
  );

  const identity = await readApi.getIdentity({ controller: "mock" });
  assert.deepEqual(
    {
      Name: identity.Name,
      SystemId: identity.SystemId,
      RobotWare: identity.RobotWare,
      Endpoint: identity.Endpoint,
      Protocol: identity.Protocol
    },
    {
      Name: "MOCK-ABB",
      SystemId: SYSTEM_ID,
      RobotWare: "6.13.0164",
      Endpoint: "http://192.0.2.10",
      Protocol: "rws1"
    }
  );
  assert.match(identity.RegistrySha256, /^[a-f0-9]{64}$/);
  assert.match(identity.ControllerSignature, /^[a-f0-9]{64}$/);
  assert.match(identity.ControllerLock, /^[a-f0-9]{64}$/);

  const assembledGeneration = createDirectChangesetStack({
    service,
    policy: generationPolicy,
    protocol: "rws1"
  });
  assert.deepEqual(assembledGeneration.policy, generationPolicy);
  assert.deepEqual(assembledGeneration.adapter.policy, generationPolicy);
  assert.equal(
    assembledGeneration.policySha256,
    changesetPolicySignature(generationPolicy)
  );
  await assembledGeneration.close();

  const session = await sessionApi.openSession({
    controller: "mock",
    fresh: false,
    bypassCircuit: true
  });
  assert.equal(session.binding.noReconnect, true);
  const sessionClient = session.binding.client;
  const clientCountBeforeReads = clients.length;

  assert.deepEqual(
    await readApi.getControllerState({
      controller: "mock",
      session
    }),
    {
      Opmode: "AUTO",
      ControllerState: "guardstop",
      RapidState: "stopped"
    }
  );
  const configList = await readApi.getConfigInstances({
    controller: "mock",
    session,
    domain: "eio",
    type: "INDUSTRIAL_NETWORK"
  });
  assert.equal(configList.length, 1);
  assert.equal(configList[0].Attributes.StationName, "robot2");
  const configInstance = await readApi.getConfigInstance({
    controller: "mock",
    session,
    domain: "eio",
    type: "INDUSTRIAL_NETWORK",
    instance: "PROFINET"
  });
  assert.equal(configInstance.Attributes.Address, "192.0.2.100");
  assert.deepEqual(
    (await readApi.getRapidModules({
      controller: "mock",
      session,
      task: "T_ROB1"
    })).map((item) => item.Name),
    ["MainModule", "WorldZone"]
  );
  assert.match(
    await readApi.getRapidModuleText({
      controller: "mock",
      session,
      task: "T_ROB1",
      module: "MainModule"
    }),
    /^MODULE MainModule/
  );
  assert.equal(
    await readApi.getRapidDataValue({
      controller: "mock",
      session,
      task: "T_ROB1",
      module: "MainModule",
      name: "Revision"
    }),
    "7"
  );
  assert.equal(
    (await readApi.getIoSignal({
      controller: "mock",
      session,
      name: "PF_READY"
    })).Value,
    "1"
  );
  assert.equal(
    clients.length,
    clientCountBeforeReads,
    "All explicit-session reads must stay on the specified RWS session."
  );

  const write = new Rws1WriteAdapter();
  const cfgSet = write.cfgSet({
    domain: "eio",
    type: "INDUSTRIAL_NETWORK",
    instance: "PROFINET",
    fields: { StationName: "robot3" }
  });
  await assert.rejects(
    sessionApi.executeDescriptor({
      controller: "mock",
      session,
      descriptor: cfgSet,
      request: cfgSet.request
    }),
    /requires mastership/i
  );

  const mastership = write.mastershipRequest();
  assert.equal(
    (await sessionApi.executeDescriptor({
      controller: "mock",
      session,
      descriptor: mastership,
      request: mastership.request
    })).statusCode,
    204
  );
  assert.equal(session.mastershipHeld, true);

  const cfgResponse = await sessionApi.executeDescriptor({
    controller: "mock",
    session,
    descriptor: cfgSet,
    request: cfgSet.request
  });
  assert.equal(cfgSet.parse(cfgResponse).Accepted, true);
  assert.equal(
    sessionClient.requests.at(-1).timeoutMs,
    3_000,
    "Normal writes must use requestTimeoutSeconds."
  );

  const cfgValidate = write.cfgValidate({
    filepath: "HOME:/codex/eio.cfg",
    actionType: "add"
  });
  await sessionApi.executeDescriptor({
    controller: "mock",
    session,
    descriptor: cfgValidate,
    request: cfgValidate.request
  });
  assert.equal(
    sessionClient.requests.at(-1).timeoutMs,
    17_000,
    "Long operations must use longRequestTimeoutSeconds."
  );

  const beforeTransportFailure = sessionClient.requests.length;
  sessionClient.failOnce = {
    path: "?action=set",
    code: "ECONNRESET",
    message: "simulated mutation transport failure"
  };
  await assert.rejects(
    sessionApi.executeDescriptor({
      controller: "mock",
      session,
      descriptor: cfgSet,
      request: cfgSet.request
    }),
    /simulated mutation transport failure/
  );
  assert.equal(
    sessionClient.requests.length,
    beforeTransportFailure + 1,
    "The service adapter must never replay a mutation after transport failure."
  );

  const restart = write.ordinaryRestart();
  await sessionApi.executeDescriptor({
    controller: "mock",
    session,
    descriptor: restart,
    request: restart.request
  });
  assert.equal(
    sessionClient.requests.at(-1).timeoutMs,
    15_000,
    "The restart acknowledgement request must be bounded before recovery polling."
  );

  const initialControllerLock = session.ControllerLock;
  const initialRegistrySha256 = session.RegistrySha256;
  const policyOnlyRegistry = registry(3);
  policyOnlyRegistry.allowedLocalRoots = [temporary];
  await writeFile(
    registryPath,
    `${JSON.stringify(policyOnlyRegistry, null, 2)}\n`
  );
  const policyOnlyLock = await adapter.controllerLock("mock");
  assert.equal(
    policyOnlyLock.ControllerLock,
    initialControllerLock,
    "A policy-only edit must not change an active generation's ControllerLock."
  );
  assert.notEqual(
    policyOnlyLock.RegistrySha256,
    initialRegistrySha256,
    "Registry content hashing must still observe a policy-only edit."
  );
  const requestsBeforePolicyOnlyMutation = sessionClient.requests.length;
  await sessionApi.executeDescriptor({
    controller: "mock",
    session,
    descriptor: cfgSet,
    request: cfgSet.request
  });
  assert.equal(
    sessionClient.requests.length,
    requestsBeforePolicyOnlyMutation + 1,
    "A linearized apply may continue under its pinned policy generation."
  );

  const release = write.mastershipRelease();
  await sessionApi.executeDescriptor({
    controller: "mock",
    session,
    descriptor: release,
    request: release.request
  });
  assert.equal(session.mastershipHeld, false);

  const requestsBeforeRegistryChange = sessionClient.requests.length;
  await writeFile(
    registryPath,
    `${JSON.stringify(registry(4), null, 2)}\n`
  );
  await assert.rejects(
    sessionApi.executeDescriptor({
      controller: "mock",
      session,
      descriptor: write.fileUpload({
        root: "$HOME",
        relativePath: "codex-stage/test.mod",
        bytes: Buffer.from("MODULE Test\nENDMODULE\n")
      })
    }),
    /changed after the changeset session was opened/i
  );
  assert.equal(
    sessionClient.requests.length,
    requestsBeforeRegistryChange,
    "Registry/controller-lock changes must fail before the next mutation."
  );

  await writeFile(
    registryPath,
    `${JSON.stringify(registry(3), null, 2)}\n`
  );
  const fresh = await sessionApi.openSession({
    controller: "mock",
    fresh: true,
    bypassCircuit: true
  });
  const freshClient = fresh.binding.client;
  await sessionApi.closeSession({
    controller: "mock",
    session: fresh,
    logout: true
  });
  assert.deepEqual(freshClient.closeCalls.at(-1), { logout: true });
  assert.equal(fresh.closed, true);

  controllerModel.rapidRevision = "7";
  const planner = new DirectChangesetPlanner({
    readApi,
    allowedConfigDomains: ["eio", "sio", "sys", "proc"],
    allowedLocalRoots: [temporary]
  });
  const executor = new DirectChangesetExecutor({
    planner,
    readApi,
    sessionApi,
    writeAdapter: write
  });
  const manager = new DirectChangesetManager({ planner, executor });
  const fullStackChangeset = {
    version: 1,
    controller: "mock",
    expectedController: {
      name: "MOCK-ABB",
      systemId: SYSTEM_ID,
      robotWare: "6.13.0164"
    },
    safety: {
      requireRapidStopped: true,
      allowedControllerStates: ["guardstop", "motoroff"]
    },
    operations: [
      {
        kind: "rapid_set_init",
        task: "T_ROB1",
        module: "MainModule",
        name: "Revision",
        value: 8
      }
    ]
  };
  const mastershipRequestsBeforeFullStack = clients
    .flatMap((client) => client.requests)
    .filter((item) => item.path === "/rw/mastership?action=request")
    .length;
  const fullStackPlan = await manager.call("prepare_changeset", {
    changeset: fullStackChangeset
  });
  assert.equal(fullStackPlan.ChangesRequired, 1);
  assert.equal(fullStackPlan.Identity.Endpoint, "http://192.0.2.10");
  assert.match(fullStackPlan.Identity.ControllerLock, /^[a-f0-9]{64}$/);
  const fullStackApply = await manager.call("commit_job", {
    token: fullStackPlan.Token
  });
  assert.equal(fullStackApply.Applied, true);
  assert.equal(fullStackApply.ControllerModified, true);
  assert.equal(controllerModel.rapidRevision, "8");
  const mastershipRequestsAfterFullStack = clients
    .flatMap((client) => client.requests)
    .filter((item) => item.path === "/rw/mastership?action=request")
    .length;
  assert.equal(
    mastershipRequestsAfterFullStack - mastershipRequestsBeforeFullStack,
    1,
    "The full planner/manager/executor/adapter path must use one mastership batch."
  );

  controllerModel.normalizeRapidExtaxSentinels = true;
  const sentinelPlan = await manager.call("prepare_changeset", {
    changeset: {
      ...fullStackChangeset,
      operations: [
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "MainModule",
          name: "Revision",
          value: SENTINEL_ROBTARGET
        }
      ]
    }
  });
  assert.equal(sentinelPlan.ChangesRequired, 1);
  const sentinelApply = await manager.call("commit_job", {
    token: sentinelPlan.Token
  });
  assert.equal(sentinelApply.Applied, true);
  assert.equal(controllerModel.rapidRevision, NORMALIZED_SENTINEL_ROBTARGET);
  assert.equal(
    sentinelApply.Verification.find(
      (item) => item.Kind === "rapid_set_init"
    )?.Passed,
    true,
    "Service-adapter readback must accept only equivalent extax sentinels."
  );
  controllerModel.normalizeRapidExtaxSentinels = false;
  await manager.close();

  // Strict restart recovery is tested with an injected monotonic clock and
  // mock sessions. No socket, controller, or real wait is involved.
  let fakeNow = 0;
  const restartAdapter = new DirectChangesetServiceAdapter({
    service,
    protocol: "rws1",
    now: () => fakeNow,
    sleep: async (milliseconds) => {
      fakeNow += milliseconds;
    },
    restartPollMs: 200,
    restartSettleMs: 400,
    restartOnlineChecks: 2
  });
  let restartOpenCount = 0;
  restartAdapter.openSession = async () => ({
    mock: true,
    id: ++restartOpenCount
  });
  restartAdapter.getIdentity = async () => identity;
  restartAdapter.closeSession = async () => {};

  const acknowledgedRecovery = await restartAdapter.waitForRestart({
    controller: "mock",
    timeoutSeconds: 2,
    requestResult: { Accepted: true, StatusCode: 204 },
    transportUnknown: false
  });
  assert.equal(acknowledgedRecovery.Online, true);
  assert.equal(acknowledgedRecovery.OfflineObserved, false);
  assert.equal(acknowledgedRecovery.ConsecutiveOnlineChecks, 2);
  assert.ok(acknowledgedRecovery.SettledMs >= 400);

  fakeNow = 0;
  restartOpenCount = 0;
  restartAdapter.openSession = async () => {
    restartOpenCount += 1;
    if (restartOpenCount === 1) {
      const error = new Error("mock controller offline");
      error.code = "ECONNREFUSED";
      throw error;
    }
    return { mock: true, id: restartOpenCount };
  };
  const unknownRecovery = await restartAdapter.waitForRestart({
    controller: "mock",
    timeoutSeconds: 2,
    requestResult: null,
    requestError: "restart response lost",
    transportUnknown: true
  });
  assert.equal(unknownRecovery.Online, true);
  assert.equal(unknownRecovery.OfflineObserved, true);

  fakeNow = 0;
  restartAdapter.openSession = async () => ({ mock: true });
  await assert.rejects(
    restartAdapter.waitForRestart({
      controller: "mock",
      timeoutSeconds: 0.6,
      requestResult: null,
      requestError: "restart response lost",
      transportUnknown: true
    }),
    /no offline transition observed|did not return after restart/i
  );

  await restartAdapter.close();
  await adapter.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        protocol: "rws1",
        controllerLockFields: [
          "Endpoint",
          "Name",
          "SystemId",
          "RobotWare",
          "ControllerSignature",
          "RegistrySha256"
        ],
        explicitSessionReads: true,
        mutationTransportRetries: 0,
        normalTimeoutMs: 3_000,
        longTimeoutMs: 17_000,
        restartRequestTimeoutMs: 15_000,
        restartAcknowledgedWithoutOffline: true,
        restartUnknownRequiresOffline: true,
        immutablePolicyGeneration: true,
        policyOnlyEditPreservesActiveApply: true,
        fullStackPlanApplyVerify: true,
        robtargetExtaxSentinelNormalization: true,
        liveControllerCalls: 0,
        networkCalls: 0
      },
      null,
      2
    )
  );
} finally {
  await service.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
