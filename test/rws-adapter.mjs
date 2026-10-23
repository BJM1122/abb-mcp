import assert from "node:assert/strict";

import {
  RWS1,
  RWS2,
  RWS2_ACCEPT,
  RwsAdapter,
  RwsProtocolDetectionError,
  UnsupportedRwsOperationError,
  detectRwsProtocol,
  rws2ModuleTextFilePath
} from "../direct-rws/rws-adapter.mjs";

function hal(states, next = "") {
  const document = {
    _links: {},
    _embedded: { _state: states }
  };
  if (next) document._links.next = { href: next };
  return { statusCode: 200, headers: {}, body: JSON.stringify(document) };
}

const common = {
  opmode: hal([{ _type: "pnl-opmode", opmode: "AUTO" }]),
  ctrlstate: hal([{ _type: "pnl-ctrlstate", ctrlstate: "guardstop" }]),
  rapidState: hal([
    {
      _type: "rap-ctrlexecstate",
      ctrlexecstate: "stopped",
      rapidexeccycle: "once"
    }
  ]),
  modules: hal([
    { _type: "rap-module-info-li", name: "MainModule", type: "ProgMod" },
    { _type: "rap-module-info-li", name: "WorldZone", type: "SysMod" }
  ]),
  rapidData: hal([{ _type: "rap-data", value: "[1,2,3]" }]),
  signal: hal([
    {
      _type: "ios-signal-li",
      _title: "PROFINET/PN_Internal_Device/PF_DI01",
      name: "PF_DI01",
      type: "DI",
      lvalue: "1",
      lstate: "not simulated",
      phstate: "valid",
      quality: "good"
    }
  ]),
  configInstance: hal([
    {
      _type: "cfg-dt-instance",
      _title: "PROFINET Network",
      rdonly: "false",
      instanceid: "19",
      attrib: [
        { _type: "cfg-ia-t", _title: "Name", value: "PROFINET Network" },
        { _type: "cfg-ia-t", _title: "Address", value: "192.0.2.100" }
      ]
    }
  ])
};

const fixtures = {
  [RWS1]: {
    identity: hal([
      {
        _type: "sys-system",
        name: "IRC5-A",
        sysid: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
        rwversion: "6.11.02"
      }
    ]),
    ...common,
    moduleText: {
      statusCode: 200,
      headers: { "content-type": "application/xhtml+xml" },
      body:
        '<html><body><span class="text">MODULE MainModule\n' +
        "  ! &lt;kept&gt; &amp; decoded\nENDMODULE</span></body></html>"
    },
    signals: hal(
      [
        {
          _type: "ios-signal-li",
          _title: "PROFINET/PN_Internal_Device/PF_DI01",
          name: "PF_DI01",
          lvalue: "1",
          lstate: "not simulated"
        },
        {
          _type: "ios-signal-li",
          _title: "PROFINET/PN_Internal_Device/PF_DO01",
          name: "PF_DO01",
          lvalue: "0",
          lstate: "simulated"
        }
      ],
      "/rw/iosystem/signals?start=2&limit=2&json=1"
    ),
    configInstances: hal(
      [
        {
          _type: "cfg-dt-instance",
          _title: "PROFINET Network",
          rdonly: "false",
          instanceid: "19",
          attrib: [
            { _type: "cfg-ia-t", _title: "Name", value: "PROFINET Network" }
          ]
        }
      ],
      "/rw/cfg/sio/IP_SETTING/instances?start=70&limit=70&json=1"
    ),
    expectedIdentity: {
      Name: "IRC5-A",
      SystemId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      RobotWare: "6.11.02"
    },
    expectedPaths: {
      identity: "/rw/system?json=1",
      opmode: "/rw/panel/opmode?json=1",
      ctrlstate: "/rw/panel/ctrlstate?json=1",
      rapidState: "/rw/rapid/execution?json=1",
      modules: "/rw/rapid/modules?task=T_ROB1&json=1",
      moduleText:
        "/rw/rapid/modules/MainModule?task=T_ROB1&startrow=1&startcol=1&endrow=10000&endcol=-1",
      rapidData:
        "/rw/rapid/symbol/data/RAPID/T_ROB1/MainModule/SharedValue?json=1",
      signal:
        "/rw/iosystem/signals/PROFINET/PN_Internal_Device/PF_DI01?json=1",
      signals: "/rw/iosystem/signals?start=0&limit=500&json=1",
      configInstances:
        "/rw/cfg/sio/IP_SETTING/instances?start=0&limit=70&json=1",
      configInstance:
        "/rw/cfg/sio/IP_SETTING/instances/PROFINET%20Network?json=1"
    },
    signalPage: { start: 0, limit: 500 },
    configPage: { start: 0, limit: 70 },
    expectedModuleText:
      "MODULE MainModule\n  ! <kept> & decoded\nENDMODULE"
  },

  [RWS2]: {
    identity: hal([
      {
        _type: "sys-system",
        name: "OmniCore-A",
        sysid: "{11111111-2222-3333-4444-555555555555}",
        rwversion: "7.20.1"
      }
    ]),
    ...common,
    moduleText: hal([
      {
        _type: "rap-module-text",
        "change-count": "42",
        "module-text":
          "MODULE MainModule\n  ! RWS2 inline module text\nENDMODULE",
        "module-length": "63"
      }
    ]),
    signals: hal(
      [
        {
          _type: "ios-signal-li",
          _title: "PROFINET/PN_Internal_Device/PF_DI01",
          name: "PF_DI01",
          lvalue: "1",
          lstate: "not simulated"
        },
        {
          _type: "ios-signal-li",
          _title: "PROFINET/PN_Internal_Device/PF_DO01",
          name: "PF_DO01",
          lvalue: "0",
          lstate: "simulated"
        }
      ],
      "/rw/iosystem/signals?controller-cursor=opaque"
    ),
    configInstances: hal([
      {
        _type: "cfg-dt-instance",
        _title: "PROFINET Network",
        rdonly: false,
        instanceid: 19,
        attrib: [
          { _type: "cfg-ia-t", _title: "Name", value: "PROFINET Network" }
        ]
      }
    ]),
    expectedIdentity: {
      Name: "OmniCore-A",
      SystemId: "11111111-2222-3333-4444-555555555555",
      RobotWare: "7.20.1"
    },
    expectedPaths: {
      identity: "/rw/system",
      opmode: "/rw/panel/opmode",
      ctrlstate: "/rw/panel/ctrl-state",
      rapidState: "/rw/rapid/execution",
      modules: "/rw/rapid/tasks/T_ROB1/modules",
      moduleText: "/rw/rapid/tasks/T_ROB1/modules/MainModule/text",
      rapidData:
        "/rw/rapid/symbol/RAPID/T_ROB1/MainModule/SharedValue/data",
      signal: "/rw/iosystem/signals/PROFINET/PN_Internal_Device/PF_DI01",
      signals: "/rw/iosystem/signals",
      configInstances: "/rw/cfg/sio/IP_SETTING/instances?limit=10",
      configInstance:
        "/rw/cfg/sio/IP_SETTING/instances/PROFINET%20Network"
    },
    signalPage: {},
    configPage: { limit: 10 },
    expectedModuleText:
      "MODULE MainModule\n  ! RWS2 inline module text\nENDMODULE"
  }
};

function buildOperations(adapter, fixture) {
  return {
    identity: adapter.identity(),
    opmode: adapter.opmode(),
    ctrlstate: adapter.ctrlstate(),
    rapidState: adapter.rapidState(),
    modules: adapter.modules({ task: "T_ROB1" }),
    moduleText: adapter.moduleText({
      task: "T_ROB1",
      module: "MainModule"
    }),
    rapidData: adapter.rapidData({
      task: "T_ROB1",
      module: "MainModule",
      name: "SharedValue"
    }),
    signal: adapter.signal({
      network: "PROFINET",
      device: "PN_Internal_Device",
      name: "PF_DI01"
    }),
    signals: adapter.signals(fixture.signalPage),
    configInstances: adapter.configInstances({
      domain: "sio",
      type: "IP_SETTING",
      ...fixture.configPage
    }),
    configInstance: adapter.configInstance({
      domain: "sio",
      type: "IP_SETTING",
      instance: "PROFINET Network"
    })
  };
}

function exerciseFixture(protocol, fixture) {
  const adapter = new RwsAdapter({ protocol });
  const operations = buildOperations(adapter, fixture);

  for (const [name, expectedPath] of Object.entries(fixture.expectedPaths)) {
    assert.equal(operations[name].request.method, "GET");
    assert.equal(operations[name].request.path, expectedPath);
    if (protocol === RWS2) {
      assert.equal(operations[name].request.accept, RWS2_ACCEPT);
    } else {
      assert.equal(operations[name].request.accept, undefined);
    }
  }

  assert.deepEqual(operations.identity.parse(fixture.identity), fixture.expectedIdentity);
  assert.equal(operations.opmode.parse(fixture.opmode), "AUTO");
  assert.equal(operations.ctrlstate.parse(fixture.ctrlstate), "guardstop");
  assert.equal(operations.rapidState.parse(fixture.rapidState), "stopped");
  assert.deepEqual(operations.modules.parse(fixture.modules), [
    { Name: "MainModule", Type: "ProgMod", Task: "T_ROB1" },
    { Name: "WorldZone", Type: "SysMod", Task: "T_ROB1" }
  ]);
  assert.equal(
    operations.moduleText.parse(fixture.moduleText),
    fixture.expectedModuleText
  );
  assert.equal(operations.rapidData.parse(fixture.rapidData), "[1,2,3]");
  assert.deepEqual(operations.signal.parse(fixture.signal), {
    Name: "PF_DI01",
    Value: "1",
    LogicalState: "not simulated",
    PhysicalState: "valid",
    Quality: "good",
    Simulated: "not simulated"
  });

  const signals = operations.signals.parse(fixture.signals);
  assert.deepEqual(
    signals.Signals.map((item) => [item.Name, item.Value, item.Simulated]),
    [
      ["PF_DI01", "1", "not simulated"],
      ["PF_DO01", "0", "simulated"]
    ]
  );
  assert.equal(signals.Next, fixture.signals.body.includes("controller-cursor")
    ? "/rw/iosystem/signals?controller-cursor=opaque"
    : "/rw/iosystem/signals?start=2&limit=2&json=1");

  const configInstances = operations.configInstances.parse(
    fixture.configInstances
  );
  assert.equal(configInstances.Instances.length, 1);
  assert.deepEqual(configInstances.Instances[0], {
    Domain: "sio",
    Type: "IP_SETTING",
    Instance: "PROFINET Network",
    Key: "PROFINET Network",
    InstanceId: "19",
    DeleteKey: "19",
    ReadOnly: false,
    Attributes: { Name: "PROFINET Network" }
  });
  assert.equal(
    configInstances.Next,
    protocol === RWS1
      ? "/rw/cfg/sio/IP_SETTING/instances?start=70&limit=70&json=1"
      : ""
  );

  assert.deepEqual(
    operations.configInstance.parse(fixture.configInstance),
    {
      Domain: "sio",
      Type: "IP_SETTING",
      Instance: "PROFINET Network",
      Key: "PROFINET Network",
      InstanceId: "19",
      DeleteKey: "19",
      ReadOnly: false,
      Attributes: {
        Name: "PROFINET Network",
        Address: "192.0.2.100"
      }
    }
  );

  return Object.keys(operations).length;
}

assert.equal(detectRwsProtocol({ explicit: "1.0" }), RWS1);
assert.equal(detectRwsProtocol({ explicit: "rws2" }), RWS2);
assert.equal(
  detectRwsProtocol({
    headers: { "www-authenticate": 'Digest realm="mock-password-only"' }
  }),
  RWS1
);
assert.equal(
  detectRwsProtocol({
    headers: { "www-authenticate": 'Basic realm="Robot Web Services"' }
  }),
  RWS2
);
assert.equal(
  detectRwsProtocol({
    headers: { "content-type": "application/hal+json;v=2.0" }
  }),
  RWS2
);
assert.throws(
  () => detectRwsProtocol({ robotWare: "7.20" }),
  RwsProtocolDetectionError
);
assert.equal(
  rws2ModuleTextFilePath({
    body: JSON.stringify({
      state: [{ _type: "rap-module-text", "file-path": "/TEMP/pusres.12345" }]
    })
  }),
  "/TEMP/pusres.12345"
);
assert.throws(
  () =>
    rws2ModuleTextFilePath({
      body: JSON.stringify({ state: [{ "file-path": "/HOME/user.mod" }] })
    }),
  /unsafe temporary file path/
);
assert.throws(
  () =>
    detectRwsProtocol({
      explicit: "rws1",
      headers: { "www-authenticate": "Basic" }
    }),
  /Conflicting RWS protocol evidence/
);

const rws1Operations = exerciseFixture(RWS1, fixtures[RWS1]);
const rws2Operations = exerciseFixture(RWS2, fixtures[RWS2]);

const rws2 = new RwsAdapter({ evidence: { authentication: "basic" } });
assert.equal(rws2.protocol, RWS2);
assert.deepEqual(rws2.identity().parse({ body: JSON.stringify({
  state: [{ name: "TEST", sysid: "{11111111-2222-3333-4444-555555555555}", rwversion: "7.20.0+1391" }],
  _embedded: { resources: [{ _type: "sys-options-li", _title: "options" }] }
}) }), { Name: "TEST", SystemId: "11111111-2222-3333-4444-555555555555", RobotWare: "7.20.0+1391" });
const resourceModules = {
  statusCode: 200,
  body: JSON.stringify({ _embedded: { resources: [
    { _type: "rap-module-info-li", name: "Product_02", type: "ProgMod" }
  ] } })
};
assert.deepEqual(rws2.modules({ task: "T_ROB1" }).parse(resourceModules), [
  { Name: "Product_02", Type: "ProgMod", Task: "T_ROB1" }
]);
assert.equal(
  rws2.moduleText({ task: "T_ROB1", module: "InlineObject" }).parse({
    body: {
      _embedded: {
        _state: [{ _type: "rap-module-text", "module-text": "MODULE InlineObject\nENDMODULE" }]
      }
    }
  }),
  "MODULE InlineObject\nENDMODULE"
);
assert.throws(
  () => rws2.signals({ start: 0, limit: 500 }),
  (error) =>
    error instanceof UnsupportedRwsOperationError &&
    error.code === "RWS_UNSUPPORTED" &&
    /not declared/.test(error.message)
);
assert.throws(
  () =>
    rws2.configInstances({
      domain: "eio",
      type: "EIO_SIGNAL",
      start: 10
    }),
  UnsupportedRwsOperationError
);
assert.throws(
  () =>
    rws2.moduleText({ task: "T_ROB1", module: "LargeModule" }).parse(
      hal([{ _type: "rap-module-text", "file-path": "HOME:/LargeModule.mod" }])
    ),
  (error) =>
    error instanceof UnsupportedRwsOperationError &&
    /file-service handoff/.test(error.message)
);
assert.throws(
  () => rws2.request("madeUpOperation"),
  UnsupportedRwsOperationError
);

// RobotWare 6 next links are relative to the HAL base and drop the type
// segment; parse must rebuild them on the canonical list path so they can be
// requested verbatim.
const rws1 = new RwsAdapter({ protocol: RWS1 });
const relativeNextPage = rws1
  .configInstances({ domain: "eio", type: "EIO_SIGNAL", start: 0, limit: 5 })
  .parse(
    hal(
      [{ _type: "cfg-dt-instance", _title: "sigA", instanceid: "1", attrib: [] }],
      "eio/instances?start=5&limit=5&json=1"
    )
  );
assert.equal(
  relativeNextPage.Next,
  "/rw/cfg/eio/EIO_SIGNAL/instances?start=5&limit=5&json=1"
);
const missingJsonNextPage = rws1
  .configInstances({ domain: "eio", type: "EIO_SIGNAL", start: 0, limit: 5 })
  .parse(
    hal(
      [{ _type: "cfg-dt-instance", _title: "sigA", instanceid: "1", attrib: [] }],
      "eio/instances?start=5&limit=5"
    )
  );
assert.equal(
  missingJsonNextPage.Next,
  "/rw/cfg/eio/EIO_SIGNAL/instances?start=5&limit=5&json=1"
);
const relativeNextSignals = rws1
  .signals({ start: 0, limit: 2 })
  .parse(hal([], "signals?start=2&limit=2&json=1"));
assert.equal(
  relativeNextSignals.Next,
  "/rw/iosystem/signals?start=2&limit=2&json=1"
);

console.log(
  JSON.stringify(
    {
      result: "PASS",
      protocols: [RWS1, RWS2],
      operationsPerFixture: rws1Operations,
      totalFixtureOperations: rws1Operations + rws2Operations,
      explicitOrEvidenceBasedProtocolSelection: true,
      unsupportedRws2Guards: [
        "signals numeric pagination",
        "CFG v2.0 numeric cursor",
        "large-module parser requires the service handoff"
      ],
      productionIntegration: false
    },
    null,
    2
  )
);
