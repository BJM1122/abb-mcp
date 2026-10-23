import assert from "node:assert/strict";

import { UnsupportedRwsOperationError } from "../direct-rws/rws-adapter.mjs";
import {
  OFFICIAL_RWS2_REFERENCES,
  SAFETY_EXCLUDED_OPERATIONS
} from "../direct-rws/rws1-write-adapter.mjs";
import { Rws2WriteAdapter } from "../direct-rws/rws2-write-adapter.mjs";

function response(statusCode, body = "", headers = {}) {
  return { statusCode, body, headers };
}

const adapter = new Rws2WriteAdapter();
for (const operation of [
  adapter.rapidLoadModuleReplace({ task: "T_ROB1", modulepath: "HOME:/stage/Test.mod" }),
  adapter.rapidBuild({ task: "T_ROB1" }),
  adapter.rapidBuildErrors({ task: "T_ROB1" }),
  adapter.fileDelete({ root: "$HOME", relativePath: "stage/Test.mod" })
]) {
  assert.equal(operation.request.accept, "application/xhtml+xml;v=2.0");
}
const cases = [
  [adapter.mastershipRequest(), "POST", "/rw/mastership/request"],
  [adapter.mastershipRelease(), "POST", "/rw/mastership/release"],
  [
    adapter.cfgSet({
      domain: "eio",
      type: "EIO_SIGNAL",
      instance: "PF_DI01",
      fields: { SignalType: "DI" }
    }),
    "POST",
    "/rw/cfg/eio/EIO_SIGNAL/instances/PF_DI01"
  ],
  [
    adapter.cfgCreateDefault({
      domain: "eio",
      type: "EIO_SIGNAL",
      name: "PF_NEW"
    }),
    "POST",
    "/rw/cfg/eio/EIO_SIGNAL/instances/create-default"
  ],
  [
    adapter.cfgDelete({
      domain: "eio",
      type: "EIO_SIGNAL",
      deleteKey: "77"
    }),
    "DELETE",
    "/rw/cfg/eio/EIO_SIGNAL/instances/77"
  ],
  [
    adapter.cfgValidate({ filepath: "HOME:/stage/eio.cfg", actionType: "add" }),
    "POST",
    "/rw/cfg/validate"
  ],
  [
    adapter.cfgLoad({ filepath: "HOME:/stage/eio.cfg", actionType: "add" }),
    "POST",
    "/rw/cfg/load"
  ],
  [
    adapter.rapidSetInit({
      task: "T_ROB1",
      module: "MainModule",
      name: "SharedValue",
      value: "1"
    }),
    "POST",
    "/rw/rapid/symbol/RAPID/T_ROB1/MainModule/SharedValue/data?initval=true"
  ],
  [
    adapter.rapidLoadModuleReplace({
      task: "T_ROB1",
      modulepath: "$HOME/stage/MainModule.mod"
    }),
    "POST",
    "/rw/rapid/tasks/T_ROB1/loadmod"
  ],
  [
    adapter.rapidDeleteModule({ task: "T_ROB1", module: "OldModule" }),
    "POST",
    "/rw/rapid/tasks/T_ROB1/unloadmod"
  ],
  [adapter.rapidBuild({ task: "T_ROB1" }), "POST", "/rw/rapid/tasks/T_ROB1/build"],
  [
    adapter.rapidBuildErrors({ task: "T_ROB1", start: 1, limit: 30 }),
    "GET",
    "/rw/rapid/tasks/T_ROB1/program/builderror?start=1&limit=30"
  ],
  [adapter.ordinaryRestart(), "POST", "/rw/panel/restart"],
  [
    adapter.fileMkdir({ root: "$HOME", directory: "stage/modules" }),
    "POST",
    "/fileservice/$HOME/stage/create"
  ],
  [
    adapter.fileUpload({
      root: "$HOME",
      relativePath: "stage/MainModule.mod",
      bytes: Buffer.from("MODULE MainModule\nENDMODULE\n")
    }),
    "PUT",
    "/fileservice/$HOME/stage/MainModule.mod"
  ],
  [
    adapter.fileDelete({ root: "$HOME", relativePath: "stage" }),
    "DELETE",
    "/fileservice/$HOME/stage"
  ]
];

for (const [descriptor, method, path] of cases) {
  assert.equal(descriptor.protocol, "rws2");
  assert.equal(descriptor.request.method, method);
  assert.equal(descriptor.request.path, path);
  assert.equal(
    descriptor.officialReference,
    OFFICIAL_RWS2_REFERENCES[descriptor.operation]
  );
  assert.equal(
    descriptor.reconnectPolicy,
    descriptor.mutating ? "never-replay" : "safe-read"
  );
  assert.doesNotMatch(
    path.toLowerCase(),
    /action=(?:start|jog|force|motor)|\/motion(?:\/|\?|$)/
  );
}

assert.deepEqual(cases[13][0].request.form, { "fs-newname": "modules" });
assert.equal(cases[13][0].ControllerDirectory, "$HOME/stage/modules");
assert.equal(cases[14][0].ControllerPath, "$HOME/stage/MainModule.mod");
assert.equal(cases[14][0].request.contentType, "application/octet-stream;v=2.0");
assert.equal(cases[5][0].parse(response(200)).OfficialStatusCode, true);
assert.equal(cases[6][0].parse(response(202)).OfficialStatusCode, true);
assert.equal(cases[8][0].parse(response(200)).OfficialStatusCode, true);
assert.deepEqual(
  cases[3][0].parse(
    response(201, "", {
      location: "/rw/cfg/eio/EIO_SIGNAL/instances/77"
    })
  ),
  {
    Accepted: true,
    StatusCode: 201,
    OfficialStatusCode: true,
    CompatibilityStatusCode: false,
    Location: "/rw/cfg/eio/EIO_SIGNAL/instances/77",
    InstanceName: "77",
    InstanceId: "77"
  }
);

const parsedErrors = cases[11][0].parse(
  response(
    200,
    JSON.stringify({
      state: [
        {
          _type: "rap-builderrs",
          ModuleName: "MainModule",
          row: "9",
          column: "4",
          error: "Unexpected token"
        }
      ],
      _links: { next: { href: "/rw/rapid/tasks/T_ROB1/program/builderror?cursor=2" } }
    })
  )
);
assert.equal(parsedErrors.Count, 1);
assert.equal(parsedErrors.Errors[0].Module, "MainModule");
assert.equal(parsedErrors.Next, "/rw/rapid/tasks/T_ROB1/program/builderror?cursor=2");

for (const operation of SAFETY_EXCLUDED_OPERATIONS) {
  assert.throws(
    () => adapter.operation(operation),
    (error) =>
      error instanceof UnsupportedRwsOperationError &&
      error.protocol === "rws2" &&
      error.operation === operation
  );
}

console.log(
  JSON.stringify(
    {
      result: "PASS",
      protocol: "rws2",
      descriptorCount: cases.length,
      officialOpenApiPaths: true,
      exactNeverReplayMutations: true,
      liveControllerCalls: 0
    },
    null,
    2
  )
);
