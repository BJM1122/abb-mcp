import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DirectChangesetPlanner,
  TOKEN_LIFETIME_MS,
  assertNoOperationConflicts,
  configAttributesSha256,
  configInventorySha256,
  sha256Text
} from "../direct-rws/changeset-planner.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digestText(text) {
  return crypto
    .createHash("sha256")
    .update(String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim(), "utf8")
    .digest("hex");
}

function baseChangeset(operations, restart = undefined) {
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

const root = await mkdtemp(path.join(os.tmpdir(), "abb-changeset-planner-"));
const escapeRoot = await mkdtemp(
  path.join(os.tmpdir(), "abb-changeset-planner-escape-")
);
const jobsRoot = path.join(root, "jobs");
await mkdir(jobsRoot, { recursive: true });

const putModulePath = path.join(jobsRoot, "PutModule.mod");
const sameModulePath = path.join(jobsRoot, "SameModule.mod");
const caseModulePath = path.join(jobsRoot, "CaseModule.mod");
const cfgPath = path.join(jobsRoot, "MockEIO.cfg");
const putModuleBytes = Buffer.from(
  "MODULE PutModule\r\n  CONST num wanted := 2;\r\nENDMODULE\r\n",
  "utf8"
);
const putModuleOnline =
  "MODULE PutModule\n  CONST num wanted := 1;\nENDMODULE\n";
const sameModuleBytes = Buffer.from(
  "MODULE SameModule\r\n  CONST num value := 5;\r\nENDMODULE\r\n",
  "utf8"
);
const sameModuleOnline =
  "MODULE SameModule\n  CONST num value := 5;\nENDMODULE\n";
const caseModuleBytes = Buffer.from(
  'MODULE CaseModule\r\n  CONST string value := "Robot2";\r\nENDMODULE\r\n',
  "utf8"
);
const caseModuleOnline =
  'MODULE CaseModule\n  CONST string value := "robot2";\nENDMODULE\n';
const cfgBytes = Buffer.from(
  [
    "EIO:CFG_1.0:6:1::",
    "#",
    "INDUSTRIAL_NETWORK:",
    '  -Name "PROFINET" \\',
    '  -StationName "robot2" -Address "192.0.2.100"',
    "#",
    "EIO_SIGNAL:",
    '  -Name "SigOne" -SignalType "DO" -Device "PN" -DeviceMap "0"',
    "#",
    ""
  ].join("\r\n"),
  "utf8"
);

await writeFile(putModulePath, putModuleBytes);
await writeFile(sameModulePath, sameModuleBytes);
await writeFile(caseModulePath, caseModuleBytes);
await writeFile(cfgPath, cfgBytes);

const baseInventories = new Map([
  [
    "eio|type_a",
    [
      {
        Key: "Existing",
        InstanceId: "1",
        DeleteKey: "1",
        ReadOnly: false,
        Attributes: { A: "old", B: "same" }
      }
    ]
  ],
  ["eio|type_b", []],
  [
    "eio|type_c",
    [
      {
        Key: "DeleteMe",
        InstanceId: "42",
        DeleteKey: "42",
        ReadOnly: false,
        Attributes: { Name: "DeleteMe", Value: "1" }
      }
    ]
  ],
  [
    "eio|type_u",
    [
      {
        Key: "UpsertExisting",
        InstanceId: "7",
        DeleteKey: "7",
        ReadOnly: false,
        Attributes: { Enabled: "True" }
      }
    ]
  ],
  ["eio|type_missing", []],
  [
    "eio|industrial_network",
    [
      {
        Key: "PROFINET",
        InstanceId: "11",
        DeleteKey: "11",
        ReadOnly: false,
        Attributes: {
          Name: "PROFINET",
          StationName: "robot2",
          Address: "192.0.2.100"
        }
      }
    ]
  ]
]);

let cfgFileExact = false;
let cfgFileExtra = false;
let requestCount = 0;
let fakeNow = Date.parse("2026-07-29T01:00:00.000Z");
let tokenCounter = 0;
const fileReads = new Map();

function inventory(domain, type) {
  const key = `${domain}|${type}`.toLowerCase();
  if (key === "eio|eio_signal") {
    const signals = [
      {
        Key: "SigOne",
        InstanceId: "12",
        DeleteKey: "12",
        ReadOnly: false,
        Attributes: {
          Name: "SigOne",
          SignalType: "DO",
          Device: "PN",
          DeviceMap: cfgFileExact ? "0" : "9"
        }
      }
    ];
    if (cfgFileExtra) {
      signals.push({
        Key: "ExtraSignal",
        InstanceId: "13",
        DeleteKey: "13",
        ReadOnly: false,
        Attributes: {
          Name: "ExtraSignal",
          SignalType: "DI",
          Device: "PN",
          DeviceMap: "1"
        }
      });
    }
    return signals;
  }
  return clone(baseInventories.get(key) ?? []);
}

const rapidModules = [
  { Name: "PutModule", Type: "ProgMod" },
  { Name: "OldModule", Type: "ProgMod" },
  { Name: "SameModule", Type: "ProgMod" },
  { Name: "CaseModule", Type: "ProgMod" },
  { Name: "SysModule", Type: "SysMod" }
];
const rapidTexts = new Map([
  ["putmodule", putModuleOnline],
  ["oldmodule", "MODULE OldModule\nENDMODULE\n"],
  ["samemodule", sameModuleOnline],
  ["casemodule", caseModuleOnline],
  ["sysmodule", "MODULE SysModule\nENDMODULE\n"]
]);

const readApi = {
  async getMetrics() {
    return {
      RequestCount: requestCount,
      SessionCreateCount: 1,
      ReconnectCount: 0,
      TimeoutCount: 0,
      TransportFailureCount: 0,
      CircuitFastFailCount: 0
    };
  },
  async getIdentity({ controller }) {
    requestCount += 1;
    assert.equal(controller, "mock");
    return {
      Name: "MOCK-ABB",
      SystemId: "{11111111-2222-3333-4444-555555555555}",
      RobotWare: "6.13.0164"
    };
  },
  async getControllerState({ controller }) {
    requestCount += 1;
    assert.equal(controller, "mock");
    return {
      Opmode: "AUTO",
      ControllerState: "guardstop",
      RapidState: "stopped"
    };
  },
  async getConfigInstance({ domain, type, instance }) {
    requestCount += 1;
    const match = inventory(domain, type).find(
      (item) =>
        item.Key.toLowerCase() === instance.toLowerCase() ||
        item.InstanceId.toLowerCase() === instance.toLowerCase()
    );
    return match ?? null;
  },
  async getConfigInstances({ domain, type }) {
    requestCount += 1;
    return inventory(domain, type);
  },
  async getRapidDataValue({ name }) {
    requestCount += 1;
    if (name === "InitValue") return "5";
    if (name === "PutData") return "1";
    if (name === "CaseValue") return "TRUE";
    throw new Error(`Unexpected RAPID data read: ${name}`);
  },
  async getRapidModules({ task }) {
    requestCount += 1;
    assert.equal(task, "T_ROB1");
    return clone(rapidModules);
  },
  async getRapidModuleText({ task, module }) {
    requestCount += 1;
    assert.equal(task, "T_ROB1");
    const text = rapidTexts.get(module.toLowerCase());
    if (text === undefined) throw new Error(`Unexpected module read: ${module}`);
    return text;
  }
};

const planner = new DirectChangesetPlanner({
  readApi,
  allowedConfigDomains: ["eio", "sio", "sys", "proc"],
  allowedLocalRoots: [root],
  now: () => fakeNow,
  tokenFactory: () => {
    tokenCounter += 1;
    return tokenCounter.toString(16).padStart(32, "0");
  },
  readFileBytes: async (filePath) => {
    fileReads.set(filePath, (fileReads.get(filePath) ?? 0) + 1);
    return await readFile(filePath);
  }
});

const restartRequired = {
  required: true,
  mode: "restart",
  timeoutSeconds: 120
};
const combinedChangeset = baseChangeset(
  [
    {
      kind: "cfg_set",
      domain: "eio",
      type: "TYPE_A",
      instance: "Existing",
      fields: { A: "new", B: "same" }
    },
    {
      kind: "cfg_upsert",
      domain: "eio",
      type: "TYPE_B",
      instance: "NewInstance",
      fields: { Enabled: true, Count: 2 }
    },
    {
      kind: "cfg_delete",
      domain: "eio",
      type: "TYPE_C",
      instanceKey: "DeleteMe",
      ifPresent: true
    },
    {
      kind: "cfg_file_load",
      domain: "eio",
      actionType: "add",
      localPath: cfgPath,
      verify: { signals: ["SigOne"] }
    },
    {
      kind: "rapid_set_init",
      task: "T_ROB1",
      module: "DataModule",
      name: "InitValue",
      value: 6
    },
    {
      kind: "rapid_module_put",
      task: "T_ROB1",
      module: "PutModule",
      localPath: putModulePath
    },
    {
      kind: "rapid_module_delete",
      task: "T_ROB1",
      module: "OldModule",
      ifPresent: true
    }
  ],
  restartRequired
);

try {
  const beforeRequests = requestCount;
  const combined = await planner.prepare(combinedChangeset);
  assert.equal(combined.Prepared, true);
  assert.equal(combined.ControllerModified, false);
  assert.equal(combined.Controller, "mock");
  assert.equal(combined.OperationCount, 7);
  assert.equal(combined.ChangesRequired, 7);
  assert.equal(combined.RestartRequired, true);
  assert.equal(combined.RequestDelta, requestCount - beforeRequests);
  assert.equal(combined.SessionCreateDelta, 0);
  assert.match(combined.Token, /^[a-f0-9]{32}$/);
  assert.equal(
    combined.ExpiresAt,
    new Date(fakeNow + TOKEN_LIFETIME_MS).toISOString()
  );
  assert.equal(
    combined.ManifestSha256,
    digestText(JSON.stringify(combinedChangeset))
  );

  const cfgSet = combined.Operations.find((item) => item.Kind === "cfg_set");
  assert.deepEqual(cfgSet.Before, { A: "old", B: "same" });
  assert.deepEqual(cfgSet.Desired, { A: "new", B: "same" });
  assert.equal(cfgSet.NeedsChange, true);

  const upsert = combined.Operations.find((item) => item.Kind === "cfg_upsert");
  assert.equal(upsert.BeforeExists, false);
  assert.deepEqual(upsert.Before, {});
  assert.deepEqual(upsert.Desired, { Enabled: "True", Count: "2" });

  const deletion = combined.Operations.find((item) => item.Kind === "cfg_delete");
  assert.equal(deletion.DeleteKey, "42");
  assert.equal(deletion.BeforeExists, true);
  assert.deepEqual(deletion.Before, { Name: "DeleteMe", Value: "1" });
  assert.equal(
    deletion.BeforeAttributesSha256,
    configAttributesSha256(deletion.Before)
  );

  const cfgFile = combined.Operations.find(
    (item) => item.Kind === "cfg_file_load"
  );
  assert.equal(cfgFile.DesiredEntryCount, 2);
  assert.equal(cfgFile.MissingOrChangedEntryCount, 1);
  assert.equal(cfgFile.MissingOrChangedEntries[0].Type, "EIO_SIGNAL");
  assert.equal(
    cfgFile.BeforeTypeInventorySha256.INDUSTRIAL_NETWORK,
    configInventorySha256(inventory("eio", "INDUSTRIAL_NETWORK"))
  );
  assert.equal(
    cfgFile.BeforeTypeInventorySha256.EIO_SIGNAL,
    configInventorySha256(inventory("eio", "EIO_SIGNAL"))
  );
  assert.equal(Object.hasOwn(cfgFile, "ArtifactBytes"), false);
  assert.equal(Object.hasOwn(cfgFile, "ParsedEntries"), false);

  const rapidSet = combined.Operations.find(
    (item) => item.Kind === "rapid_set_init"
  );
  assert.equal(rapidSet.Before, "5");
  assert.equal(rapidSet.Desired, "6");

  const rapidPut = combined.Operations.find(
    (item) => item.Kind === "rapid_module_put"
  );
  assert.equal(rapidPut.BeforeExists, true);
  assert.equal(rapidPut.BeforeSourceSha256, sha256Text(putModuleOnline));
  assert.equal(rapidPut.SourceSha256, sha256Text(putModuleBytes.toString("utf8")));
  assert.deepEqual(rapidPut.SourceDiff, {
    StartLine: 2, BeforeLineCount: 1, AfterLineCount: 1,
    Before: "  CONST num wanted := 1;", After: "  CONST num wanted := 2;", Truncated: false
  });
  assert.equal(
    rapidPut.FileSha256,
    crypto.createHash("sha256").update(putModuleBytes).digest("hex")
  );
  assert.equal(Object.hasOwn(rapidPut, "ArtifactBytes"), false);

  const rapidDelete = combined.Operations.find(
    (item) => item.Kind === "rapid_module_delete"
  );
  assert.equal(rapidDelete.ModuleType, "ProgMod");
  assert.equal(rapidDelete.BeforeExists, true);
  assert.equal(rapidDelete.NeedsChange, true);

  assert.equal(fileReads.get(path.resolve(cfgPath)), 1);
  assert.equal(fileReads.get(path.resolve(putModulePath)), 1);

  await writeFile(putModulePath, Buffer.from("changed after plan", "utf8"));
  await writeFile(cfgPath, Buffer.from("changed after plan", "utf8"));
  const consumed = planner.consume(combined.Token);
  assert.equal(consumed.Used, true);
  assert.equal(consumed.ExpiresAt.getTime() - consumed.CreatedAt.getTime(), TOKEN_LIFETIME_MS);
  const internalPut = consumed.Operations.find(
    (item) => item.Kind === "rapid_module_put"
  );
  assert.deepEqual(internalPut.ArtifactBytes, putModuleBytes);
  const internalCfg = consumed.Operations.find(
    (item) => item.Kind === "cfg_file_load"
  );
  assert.deepEqual(internalCfg.ArtifactBytes, cfgBytes);
  assert.equal(internalCfg.ParsedEntries.length, 2);
  assert.throws(
    () => planner.consume(combined.Token),
    /already been used/i
  );
  await writeFile(putModulePath, putModuleBytes);
  await writeFile(cfgPath, cfgBytes);

  cfgFileExact = true;
  const noOpChangeset = baseChangeset(
    [
      {
        kind: "cfg_set",
        domain: "eio",
        type: "TYPE_A",
        instance: "Existing",
        fields: { B: "same" }
      },
      {
        kind: "cfg_upsert",
        domain: "eio",
        type: "TYPE_U",
        instance: "UpsertExisting",
        fields: { Enabled: true }
      },
      {
        kind: "cfg_delete",
        domain: "eio",
        type: "TYPE_MISSING",
        instanceKey: "Gone",
        ifPresent: true
      },
      {
        kind: "cfg_file_load",
        domain: "eio",
        actionType: "add",
        localPath: cfgPath,
        verify: {
          cfgInstances: [
            {
              domain: "eio",
              type: "INDUSTRIAL_NETWORK",
              instance: "PROFINET",
              fields: { StationName: "robot2" }
            }
          ]
        }
      },
      {
        kind: "rapid_set_init",
        task: "T_ROB1",
        module: "DataModule",
        name: "InitValue",
        value: 5
      },
      {
        kind: "rapid_module_replace",
        task: "T_ROB1",
        module: "SameModule",
        localPath: sameModulePath
      },
      {
        kind: "rapid_module_delete",
        task: "T_ROB1",
        module: "MissingModule",
        ifPresent: true
      }
    ],
    { required: false, mode: "restart", timeoutSeconds: 120 }
  );
  const noOp = await planner.prepare(noOpChangeset);
  assert.equal(noOp.OperationCount, 7);
  assert.equal(noOp.ChangesRequired, 0);
  assert.equal(noOp.RestartRequired, false);
  assert.ok(noOp.Operations.every((item) => item.NeedsChange === false));
  const normalizedReplace = noOp.Operations.find(
    (item) => item.Module === "SameModule"
  );
  assert.equal(normalizedReplace.Kind, "rapid_module_put");
  assert.equal(normalizedReplace.SourceSha256, normalizedReplace.BeforeSourceSha256);
  assert.equal(fileReads.get(path.resolve(cfgPath)), 2);
  assert.equal(fileReads.get(path.resolve(sameModulePath)), 1);

  const caseOnly = await planner.prepare(
    baseChangeset(
      [
        {
          kind: "cfg_set",
          domain: "eio",
          type: "TYPE_A",
          instance: "Existing",
          fields: { B: "SAME" }
        },
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "DataModule",
          name: "CaseValue",
          value: "true"
        },
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "CaseModule",
          localPath: caseModulePath
        }
      ],
      restartRequired
    )
  );
  assert.equal(caseOnly.ChangesRequired, 3);
  assert.ok(
    caseOnly.Operations.every((operation) => operation.NeedsChange === true),
    "case-only configuration/RAPID differences were treated as no-ops"
  );

  cfgFileExtra = true;
  assert.equal(
    inventory("eio", "EIO_SIGNAL").length,
    2,
    "add-with-reset regression fixture must include an extra online instance"
  );
  await assert.rejects(
    planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_file_load",
            domain: "eio",
            actionType: "add-with-reset",
            localPath: cfgPath,
            verify: {
              cfgInstances: [
                {
                  domain: "eio",
                  type: "INDUSTRIAL_NETWORK",
                  instance: "PROFINET",
                  fields: {
                    StationName: "robot2",
                    Address: "192.0.2.100"
                  }
                }
              ]
            }
          }
        ],
        restartRequired
      )
    ),
    /rejects cfg_file_load actionType='add-with-reset'.*complete explicit deletion diff/i
  );
  cfgFileExtra = false;

  fakeNow += TOKEN_LIFETIME_MS + 1;
  assert.throws(() => planner.consume(noOp.Token), /expired/i);

  const rapidOnly = await planner.prepare(
    baseChangeset([
      {
        kind: "rapid_set_init",
        task: "T_ROB1",
        module: "DataModule",
        name: "InitValue",
        value: 7
      }
    ])
  );
  assert.equal(rapidOnly.ChangesRequired, 1);
  assert.equal(rapidOnly.RestartRequired, false);

  await assert.rejects(
    planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_set",
            domain: "eio",
            type: "TYPE_A",
            instance: "Existing",
            fields: { A: "newer" }
          }
        ],
        { required: false, mode: "restart", timeoutSeconds: 120 }
      )
    ),
    /configuration changes require one explicit ordinary restart/i
  );

  await assert.rejects(
    planner.prepare(
      baseChangeset(
        [
          {
            kind: "cfg_file_load",
            domain: "eio",
            actionType: "add",
            localPath: cfgPath,
            verify: { signals: ["SigOne"] }
          },
          {
            kind: "cfg_set",
            domain: "eio",
            type: "EIO_SIGNAL",
            instance: "SigOne",
            fields: { DeviceMap: "1" }
          }
        ],
        restartRequired
      )
    ),
    /cfg_set conflicts with cfg_file_load/i
  );

  await assert.rejects(
    planner.prepare(
      baseChangeset([
        {
          kind: "rapid_set_init",
          task: "T_ROB1",
          module: "PutModule",
          name: "PutData",
          value: 2
        },
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "PutModule",
          localPath: putModulePath
        }
      ])
    ),
    /conflicting rapid module operations/i
  );

  await assert.rejects(
    planner.prepare(
      baseChangeset([
        {
          kind: "rapid_module_delete",
          task: "T_ROB1",
          module: "SysModule",
          ifPresent: true
        }
      ])
    ),
    /refusing to delete rapid system module/i
  );

  const unsafeAlias = baseChangeset([
    {
      kind: "rapid_set_init",
      task: "T_ROB1",
      module: "DataModule",
      name: "InitValue",
      value: 7
    }
  ]);
  unsafeAlias.controller = "__proto__";
  await assert.rejects(
    planner.prepare(unsafeAlias),
    /safe registered alias/i
  );

  const escapedModule = path.join(escapeRoot, "Escaped.mod");
  const junction = path.join(root, "junction");
  await writeFile(
    escapedModule,
    "MODULE Escaped\nENDMODULE\n",
    "utf8"
  );
  await symlink(escapeRoot, junction, "junction");
  await assert.rejects(
    planner.prepare(
      baseChangeset([
        {
          kind: "rapid_module_put",
          task: "T_ROB1",
          module: "Escaped",
          localPath: path.join(junction, "Escaped.mod")
        }
      ])
    ),
    /resolves outside allowed roots/i
  );
  const allowedSystemDelete = await planner.prepare(
    baseChangeset([
      {
        kind: "rapid_module_delete",
        task: "T_ROB1",
        module: "SysModule",
        ifPresent: true,
        allowSystemModule: true
      }
    ])
  );
  assert.equal(allowedSystemDelete.ChangesRequired, 1);
  assert.equal(allowedSystemDelete.Operations[0].AllowSystemModule, true);

  assert.throws(
    () =>
      assertNoOperationConflicts([
        {
          Kind: "cfg_upsert",
          Domain: "eio",
          Type: "TYPE_A",
          Instance: "Existing",
          Desired: { A: "1" }
        },
        {
          Kind: "cfg_set",
          Domain: "eio",
          Type: "TYPE_A",
          Instance: "Existing",
          Desired: { B: "2" }
        }
      ]),
    /cfg_upsert cannot be combined/i
  );
  assert.throws(
    () =>
      assertNoOperationConflicts([
        {
          Kind: "cfg_set",
          Domain: "eio",
          Type: "TYPE_A",
          Instance: "Existing",
          Desired: { A: "1" }
        },
        {
          Kind: "cfg_set",
          Domain: "eio",
          Type: "TYPE_A",
          Instance: "Existing",
          Desired: { A: "2" }
        }
      ]),
    /duplicate cfg_set target/i
  );
  assert.throws(
    () =>
      assertNoOperationConflicts([
        {
          Kind: "rapid_set_init",
          Task: "T_ROB1",
          Module: "DataModule",
          Name: "Value"
        },
        {
          Kind: "rapid_set_init",
          Task: "T_ROB1",
          Module: "DataModule",
          Name: "Value"
        }
      ]),
    /duplicate rapid data target/i
  );

  const singleInventory = inventory("eio", "INDUSTRIAL_NETWORK");
  const attributes = {
    Address: "192.0.2.100",
    Name: "PROFINET",
    StationName: "robot2"
  };
  const manualAttributesHash = digestText(JSON.stringify(attributes));
  assert.equal(
    configAttributesSha256(singleInventory[0].Attributes),
    manualAttributesHash
  );
  const manualInventoryHash = digestText(
    JSON.stringify({
      Key: "PROFINET",
      InstanceId: "11",
      AttributesSha256: manualAttributesHash
    })
  );
  assert.equal(configInventorySha256(singleInventory), manualInventoryHash);

  const longModule = ["MODULE PutModule", ...Array.from({ length: 150 },
    (_, index) => `  CONST num value_${index} := ${index};`), "ENDMODULE"].join("\n");
  await writeFile(putModulePath, longModule);
  const longPlan = await planner.prepare(baseChangeset([{ kind: "rapid_module_put",
    task: "T_ROB1", module: "PutModule", localPath: putModulePath }]));
  assert.equal(longPlan.Operations[0].SourceDiff.Truncated, true);
  assert.equal(longPlan.Operations[0].SourceDiff.After.split("\n").length, 100);
  assert.equal(planner.consume(longPlan.Token).Operations[0].ArtifactBytes.toString("utf8"), longModule);

  console.log(
    JSON.stringify(
      {
        ok: true,
        operationKinds: [
          "cfg_set",
          "cfg_upsert",
          "cfg_delete",
          "cfg_file_load",
          "rapid_set_init",
          "rapid_module_put",
          "rapid_module_replace",
          "rapid_module_delete"
        ],
        combinedChanges: combined.ChangesRequired,
        noOpChanges: noOp.ChangesRequired,
        filesCapturedOnce: true,
        cfgInventoryHashVerified: true,
        singleUseTokenVerified: true,
        expiryMinutes: TOKEN_LIFETIME_MS / 60_000,
        conflictsRejected: true,
        restartGuardVerified: true,
        controllerWrites: 0
      },
      null,
      2
    )
  );
} finally {
  planner.close();
  await rm(root, { recursive: true, force: true });
  await rm(escapeRoot, { recursive: true, force: true });
}
