import assert from "node:assert/strict";

import { UnsupportedRwsOperationError } from "../direct-rws/rws-adapter.mjs";
import {
  OFFICIAL_RWS1_REFERENCES,
  RWS1,
  Rws1WriteAdapter,
  Rws1WriteResponseError,
  SAFETY_EXCLUDED_OPERATIONS
} from "../direct-rws/rws1-write-adapter.mjs";

function response(statusCode, body = "", headers = {}) {
  return { statusCode, body, headers };
}

function isUnsupported(error, operation) {
  return (
    error instanceof UnsupportedRwsOperationError &&
    error.code === "RWS_UNSUPPORTED" &&
    error.protocol === RWS1 &&
    error.operation === operation
  );
}

const adapter = new Rws1WriteAdapter();
const descriptors = [];

const mastershipRequest = adapter.mastershipRequest();
descriptors.push(mastershipRequest);
assert.deepEqual(mastershipRequest.request, {
  method: "POST",
  path: "/rw/mastership?action=request",
  form: {}
});
assert.equal(mastershipRequest.reconnectPolicy, "never-replay");
assert.equal(mastershipRequest.requiresMastership, false);
assert.deepEqual(mastershipRequest.parse(response(204)), {
  Accepted: true,
  StatusCode: 204,
  OfficialStatusCode: true,
  CompatibilityStatusCode: false,
  Location: ""
});

const mastershipRelease = adapter.mastershipRelease();
descriptors.push(mastershipRelease);
assert.deepEqual(mastershipRelease.request, {
  method: "POST",
  path: "/rw/mastership?action=release",
  form: {}
});
assert.equal(mastershipRelease.parse(response(204)).OfficialStatusCode, true);

const cfgSet = adapter.cfgSet({
  domain: "SIO",
  type: "IP_SETTING",
  instance: "PROFINET Network",
  fields: {
    Address: "192.0.2.100",
    StationName: "robot2",
    Enabled: true,
    Vlan: 0
  }
});
descriptors.push(cfgSet);
assert.deepEqual(cfgSet.request, {
  method: "POST",
  path: "/rw/cfg/sio/IP_SETTING/instances/PROFINET%20Network?action=set",
  form: {
    Address: "192.0.2.100",
    StationName: "robot2",
    Enabled: "true",
    Vlan: "0"
  }
});
assert.equal(cfgSet.requiresMastership, true);
assert.equal(cfgSet.parse(response(204)).OfficialStatusCode, true);

const cfgCreateDefault = adapter.cfgCreateDefault({
  domain: "eio",
  type: "EIO_SIGNAL",
  name: "PF_NEW"
});
descriptors.push(cfgCreateDefault);
assert.deepEqual(cfgCreateDefault.request, {
  method: "POST",
  path: "/rw/cfg/eio/EIO_SIGNAL/instances?action=create-default",
  form: { name: "PF_NEW" }
});
assert.deepEqual(
  cfgCreateDefault.parse(
    response(
      201,
      '<html><body><li class="cfg-create-default">' +
        '<span class="instancename">PF_NEW</span>' +
        '<span class="instanceid">77</span></li></body></html>',
      { Location: "/rw/cfg/eio/EIO_SIGNAL/instances/77" }
    )
  ),
  {
    Accepted: true,
    StatusCode: 201,
    OfficialStatusCode: true,
    CompatibilityStatusCode: false,
    Location: "/rw/cfg/eio/EIO_SIGNAL/instances/77",
    InstanceName: "PF_NEW",
    InstanceId: "77"
  }
);

const cfgDelete = adapter.cfgDelete({
  domain: "eio",
  type: "EIO_SIGNAL",
  deleteKey: "PF OLD"
});
descriptors.push(cfgDelete);
assert.equal(
  cfgDelete.request.path,
  "/rw/cfg/eio/EIO_SIGNAL/instances/PF%20OLD"
);
assert.deepEqual(
  cfgDelete.parse(response(200)),
  {
    Accepted: true,
    StatusCode: 200,
    OfficialStatusCode: false,
    CompatibilityStatusCode: true,
    Location: ""
  },
  "Existing RW6 HTTP 200 behavior remains accepted but is not mislabeled as official."
);

const cfgValidate = adapter.cfgValidate({
  filepath: "HOME:/codex-stage/eio.cfg",
  actionType: "add"
});
descriptors.push(cfgValidate);
assert.deepEqual(cfgValidate.request, {
  method: "POST",
  path: "/rw/cfg?action=validate",
  form: { filepath: "HOME:/codex-stage/eio.cfg", "action-type": "add" }
});
assert.equal(cfgValidate.timeoutClass, "long");
assert.deepEqual(
  cfgValidate.parse(
    response(
      200,
      '<html><body><span class="domain">EIO</span></body></html>'
    )
  ),
  {
    Accepted: true,
    StatusCode: 200,
    OfficialStatusCode: true,
    CompatibilityStatusCode: false,
    Location: "",
    Domain: "EIO"
  }
);

const cfgLoad = adapter.cfgLoad({
  filepath: "$TEMP/eio.cfg",
  actionType: "add-with-reset"
});
descriptors.push(cfgLoad);
assert.deepEqual(cfgLoad.request, {
  method: "POST",
  path: "/rw/cfg?action=load",
  form: { filepath: "$TEMP/eio.cfg", "action-type": "add-with-reset" }
});
assert.equal(cfgLoad.parse(response(204)).OfficialStatusCode, true);
assert.equal(cfgLoad.parse(response(200)).CompatibilityStatusCode, true);

const rapidSetInit = adapter.rapidSetInit({
  task: "T_ROB1",
  module: "MainModule",
  name: "SharedValue",
  value: "[1,2,3]"
});
descriptors.push(rapidSetInit);
assert.deepEqual(rapidSetInit.request, {
  method: "POST",
  path:
    "/rw/rapid/symbol/data/RAPID/T_ROB1/MainModule/SharedValue" +
    "?action=setInitValue",
  form: { value: "[1,2,3]" }
});
assert.equal(rapidSetInit.parse(response(204)).OfficialStatusCode, true);

const mkdir = adapter.fileMkdir({
  root: "$HOME",
  directory: "codex-stage/modules",
  allowExisting: true
});
descriptors.push(mkdir);
assert.deepEqual(mkdir.request, {
  method: "POST",
  path: "/fileservice/$HOME/codex-stage/",
  form: { "fs-newname": "modules", "fs-action": "create" }
});
assert.equal(mkdir.ControllerDirectory, "HOME:/codex-stage/modules");
assert.equal(mkdir.parent, "codex-stage");
assert.equal(mkdir.name, "modules");
assert.equal(mkdir.parse(response(409)).CompatibilityStatusCode, true);

const moduleBytes = Buffer.from(
  "MODULE MainModule\n  CONST num build_id := 1;\nENDMODULE\n",
  "utf8"
);
const upload = adapter.fileUpload({
  root: "$HOME",
  relativePath: "codex-stage/modules/Main Module.mod",
  bytes: moduleBytes,
  contentType: "text/plain; charset=utf-8"
});
descriptors.push(upload);
assert.equal(
  upload.request.path,
  "/fileservice/$HOME/codex-stage/modules/Main%20Module.mod"
);
assert.equal(upload.request.method, "PUT");
assert.equal(upload.request.contentType, "text/plain; charset=utf-8");
assert.equal(upload.ControllerPath, "HOME:/codex-stage/modules/Main Module.mod");
assert.equal(upload.ByteLength, moduleBytes.length);
moduleBytes.fill(0);
assert.match(upload.request.bytes.toString("utf8"), /^MODULE MainModule/);
assert.equal(upload.parse(response(201)).OfficialStatusCode, true);
assert.equal(upload.parse(response(204)).CompatibilityStatusCode, true);

const loadReplace = adapter.rapidLoadModuleReplace({
  task: "T_ROB1",
  modulepath: upload.ControllerPath
});
descriptors.push(loadReplace);
assert.deepEqual(loadReplace.request, {
  method: "POST",
  path: "/rw/rapid/tasks/T_ROB1?action=loadmod",
  form: {
    modulepath: "HOME:/codex-stage/modules/Main Module.mod",
    replace: "true"
  }
});
assert.equal(loadReplace.parse(response(200)).CompatibilityStatusCode, true);

const tempUpload = adapter.fileUpload({
  root: "$TEMP",
  relativePath: "codex-stage/TempModule.mod",
  bytes: Buffer.from("MODULE TempModule\nENDMODULE\n")
});
descriptors.push(tempUpload);
assert.equal(tempUpload.ControllerPath, "TEMP:/codex-stage/TempModule.mod");
assert.doesNotThrow(() =>
  adapter.rapidLoadModuleReplace({
    task: "T_ROB1",
    modulepath: tempUpload.ControllerPath
  })
);

const deleteModule = adapter.rapidDeleteModule({
  task: "T_ROB1",
  module: "OldModule"
});
descriptors.push(deleteModule);
assert.deepEqual(deleteModule.request, {
  method: "POST",
  path: "/rw/rapid/tasks/T_ROB1?action=unloadmod",
  form: { module: "OldModule" }
});
assert.equal(deleteModule.parse(response(204)).OfficialStatusCode, true);

const build = adapter.rapidBuild({ task: "T_ROB1" });
descriptors.push(build);
assert.deepEqual(build.request, {
  method: "POST",
  path: "/rw/rapid/tasks/T_ROB1?action=build",
  form: {}
});
assert.equal(build.timeoutClass, "long");
assert.equal(build.parse(response(204)).OfficialStatusCode, true);

const buildErrors = adapter.rapidBuildErrors({
  task: "T_ROB1",
  start: 1,
  limit: 2
});
descriptors.push(buildErrors);
assert.deepEqual(buildErrors.request, {
  method: "GET",
  path: "/rw/rapid/tasks/T_ROB1/program/builderror?start=1&limit=2"
});
assert.equal(buildErrors.mutating, false);
assert.equal(buildErrors.reconnectPolicy, "safe-read");
assert.deepEqual(
  buildErrors.parse(
    response(
      200,
      '<html><body><div class="state">' +
        '<a href="tasks/T_ROB1/program/builderror?start=3&amp;limit=2" rel="next"/>' +
        '<ul>' +
        '<li class="rap-builderrs" title="builderrs">' +
        '<span class="ModuleName">MainModule</span>' +
        '<span class="row">15</span><span class="column">8</span>' +
        '<span class="error">S:&quot;;&quot;</span></li>' +
        '<li class="rap-builderrs" title="builderrs">' +
        '<span class="ModuleName">WorldZone</span>' +
        '<span class="row">19</span><span class="column">3</span>' +
        '<span class="error">Unexpected &lt;token&gt;</span></li>' +
        "</ul></div></body></html>"
    )
  ),
  {
    Accepted: true,
    StatusCode: 200,
    OfficialStatusCode: true,
    CompatibilityStatusCode: false,
    Location: "",
    Errors: [
      {
        Module: "MainModule",
        Row: 15,
        Column: 8,
        Error: 'S:";"'
      },
      {
        Module: "WorldZone",
        Row: 19,
        Column: 3,
        Error: "Unexpected <token>"
      }
    ],
    Count: 2,
    Next: "tasks/T_ROB1/program/builderror?start=3&limit=2"
  }
);

const restart = adapter.ordinaryRestart();
descriptors.push(restart);
assert.deepEqual(restart.request, {
  method: "POST",
  path: "/rw/panel?action=restart",
  form: { "restart-mode": "restart" }
});
assert.equal(restart.parse(response(202)).CompatibilityStatusCode, true);

const fileDelete = adapter.fileDelete({
  root: "$HOME",
  relativePath: "codex-stage",
  allowMissing: true
});
descriptors.push(fileDelete);
assert.deepEqual(fileDelete.request, {
  method: "DELETE",
  path: "/fileservice/$HOME/codex-stage"
});
assert.equal(fileDelete.parse(response(404)).CompatibilityStatusCode, true);

for (const descriptor of descriptors) {
  assert.equal(descriptor.protocol, RWS1);
  assert.equal(
    descriptor.officialReference,
    OFFICIAL_RWS1_REFERENCES[descriptor.operation]
  );
  assert.match(
    descriptor.officialReference,
    /^https:\/\/developercenter\.robotstudio\.com\/api\/rwsApi\//
  );
  assert.doesNotMatch(
    descriptor.request.path.toLowerCase(),
    /action=(?:start|jog|force|motor)|\/motion(?:\/|\?|$)/
  );
}

for (const operation of SAFETY_EXCLUDED_OPERATIONS) {
  assert.throws(
    () => adapter.operation(operation),
    (error) => isUnsupported(error, operation)
  );
}

assert.equal(typeof adapter.rapidStart, "undefined");
assert.equal(typeof adapter.motorsOn, "undefined");
assert.equal(typeof adapter.jog, "undefined");
assert.equal(typeof adapter.forceIo, "undefined");
assert.throws(
  () => adapter.ordinaryRestart({ mode: "p-start" }),
  (error) => isUnsupported(error, "ordinaryRestart")
);
assert.throws(
  () =>
    adapter.cfgLoad({
      filepath: "HOME:/controller.cfg",
      actionType: "replace"
    }),
  (error) => isUnsupported(error, "cfgLoad")
);
assert.throws(
  () => adapter.operation("undocumentedWrite"),
  (error) => isUnsupported(error, "undocumentedWrite")
);
assert.throws(
  () =>
    adapter.fileUpload({
      root: "$HOME",
      relativePath: "../escape.mod",
      bytes: Buffer.from("x")
    }),
  /Unsafe FileService upload path/
);
assert.throws(
  () =>
    adapter.cfgSet({
      domain: "moc",
      type: "ARM",
      instance: "ROB_1",
      fields: { Name: "ROB_1" }
    }),
  /Unsupported configuration domain/
);
assert.throws(
  () =>
    adapter.cfgSet({
      domain: "eio",
      type: "EIO_SIGNAL",
      instance: "PF_DI01",
      fields: { "Bad&Field": "1" }
    }),
  /Unsafe CFG attribute name/
);
assert.throws(
  () => buildErrors.parse(response(500, "<p>controller failure</p>")),
  (error) =>
    error instanceof Rws1WriteResponseError &&
    error.code === "RWS1_WRITE_HTTP" &&
    error.operation === "rapidBuildErrors" &&
    error.statusCode === 500 &&
    /controller failure/.test(error.message)
);
assert.throws(
  () => adapter.rapidBuildErrors({ task: "T_ROB1", limit: 31 }),
  /integer from 1 to 30/
);

console.log(
  JSON.stringify(
    {
      result: "PASS",
      protocol: RWS1,
      descriptorCount: descriptors.length,
      requestedSurfaces: [
        "mastership request/release",
        "CFG set/create-default/delete/validate/load",
        "RAPID set init",
        "FileService mkdir/upload/delete",
        "RAPID load replace/unload/build/build errors",
        "ordinary restart"
      ],
      neverReplayMutations: descriptors
        .filter((item) => item.mutating)
        .every((item) => item.reconnectPolicy === "never-replay"),
      explicitUnsupportedSafetyOperations: [...SAFETY_EXCLUDED_OPERATIONS],
      serviceIntegration: false,
      liveControllerCalls: 0
    },
    null,
    2
  )
);
