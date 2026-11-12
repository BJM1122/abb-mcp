import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  expandChangeset,
  findRoutine,
  moduleExtension,
  pinMismatchHint,
  shapeConfigList,
  shapeModuleRead,
  createTaskModuleReader,
  shapeModuleSearch,
  stripDiagnostics
} from "../tool-shaping.mjs";

const staging = await mkdtemp(path.join(os.tmpdir(), "abb-shaping-"));
try {
  const source = [
    "MODULE MainModule",
    "  PERS num n:=1;",
    "  PROC main()",
    "    Pick;",
    "  ENDPROC",
    "  LOCAL PROC Pick()",
    "    WaitTime 1;",
    "  ENDPROC",
    "  FUNC num Twice(num x)",
    "    RETURN 2*x;",
    "  ENDFUNC",
    "  TRAP OnErr",
    "  ENDTRAP",
    "ENDMODULE"
  ].join("\r\n");
  const lines = source.split(/\r?\n/);
  assert.deepEqual(findRoutine(lines, "pick"), { start: 6, end: 8 });
  assert.deepEqual(findRoutine(lines, "Twice"), { start: 9, end: 11 });
  assert.deepEqual(findRoutine(lines, "OnErr"), { start: 12, end: 13 });
  assert.throws(() => findRoutine(lines, "Missing"), /not found/);
  assert.throws(
    () => findRoutine(["PROC a()", "  x;", "PROC b()", "ENDPROC"], "a"),
    /no END line/,
    "a routine must not run into the next one"
  );

  assert.equal(moduleExtension(source), ".mod");
  assert.equal(moduleExtension("MODULE Base (SYSMODULE, NOSTEPIN)\nENDMODULE"), ".sys");
  assert.equal(moduleExtension("MODULE M\n  ! 注释\nENDMODULE"), ".modx");

  const read = {
    Alias: "robot2",
    Task: "T_ROB1",
    Module: "MainModule",
    SourceSha256: "abc",
    Text: source,
    Metrics: { RequestCount: 1 },
    RequestDelta: 1,
    ElapsedMs: 5
  };
  const stripped = stripDiagnostics(read);
  assert.equal(stripped.Metrics, undefined);
  assert.equal(stripped.RequestDelta, undefined);
  assert.equal(stripped.SourceSha256, "abc");

  const routine = await shapeModuleRead(read, { routine: "Pick" }, staging);
  assert.equal(routine.Text, lines.slice(5, 8).join("\n"));
  assert.deepEqual(routine.Range, { Start: 6, End: 8 });
  assert.equal(routine.LineCount, 14);
  assert.equal(routine.SourceSha256, "abc");

  const whole = await shapeModuleRead(read, {}, staging);
  assert.equal(whole.Text, source);
  assert.equal(whole.Range, undefined);

  const range = await shapeModuleRead(read, { startLine: 13, endLine: 99 }, staging);
  assert.deepEqual(range.Range, { Start: 13, End: 14 });
  await assert.rejects(shapeModuleRead(read, { startLine: 20 }, staging), /Empty line range/);

  const saved = await shapeModuleRead(read, { saveToFile: true }, staging);
  assert.equal(saved.Text, undefined);
  assert.match(path.basename(saved.LocalPath), /^MainModule-[0-9a-f]{16}\.mod$/);
  assert.equal(await readFile(saved.LocalPath, "utf8"), source);
  const edited = await shapeModuleRead({ ...read, Text: `${source}\r\n` }, { saveToFile: true }, staging);
  assert.notEqual(edited.LocalPath, saved.LocalPath, "a new read must not overwrite an earlier saved copy");
  assert.equal(edited.LineCount, 14, "trailing newline is not an extra line");

  // Save A, user edits the saved file, controller still has A, save A again.
  const userEdit = source.replace("WaitTime 1;", "WaitTime 2;");
  await writeFile(saved.LocalPath, userEdit, "utf8");
  const resaved = await shapeModuleRead(read, { saveToFile: true, routine: "Pick" }, staging);
  assert.equal(resaved.LocalPath, saved.LocalPath);
  assert.equal(resaved.LocalEdited, true);
  assert.equal(await readFile(saved.LocalPath, "utf8"), userEdit, "saveToFile must not overwrite user edits");
  assert.match(resaved.Text, /WaitTime 1;/, "Text still reflects the online module");
  assert.equal(saved.LocalEdited, undefined);

  const instances = Array.from({ length: 5 }, (_, index) => ({
    Domain: "eio",
    Type: "EIO_SIGNAL",
    Instance: `DO${index}`,
    Attributes: { Name: `DO${index}`, SignalType: "DO", Device: "PN" }
  }));
  const list = shapeConfigList({ Count: 5, Instances: instances }, { fields: ["Name", "Nope"], limit: 2 });
  assert.equal(list.Count, 5);
  assert.equal(list.Truncated, true);
  assert.deepEqual(list.Instances, [
    { Instance: "DO0", Attributes: { Name: "DO0" } },
    { Instance: "DO1", Attributes: { Name: "DO1" } }
  ]);
  assert.equal(shapeConfigList({ Count: 5, Instances: instances }, {}).Instances, instances);

  const identity = { name: "R2", systemId: "{1-2}", robotWare: "6.15.00" };
  const expanded = await expandChangeset(
    {
      version: 1,
      controller: "robot2",
      expectedController: identity,
      operations: [
        { kind: "rapid_module_replace", task: "T_ROB1", module: "MainModule", source },
        { kind: "rapid_set_init", task: "T_ROB1", module: "MainModule", name: "n", value: 2 }
      ]
    },
    staging
  );
  assert.equal(expanded.expectedController, identity, "caller identity passes through untouched");
  assert.deepEqual(expanded.safety, {
    requireRapidStopped: true,
    allowedControllerStates: ["guardstop", "motoroff"]
  });
  const [replace, setInit] = expanded.operations;
  assert.equal(replace.source, undefined);
  assert.match(path.basename(replace.localPath), /^MainModule-[0-9a-f]{16}.mod$/);
  assert.equal(await readFile(replace.localPath, "utf8"), source);
  assert.equal(setInit.value, 2);

  const again = await expandChangeset(
    {
      version: 1,
      controller: "robot2",
      expectedController: identity,
      operations: [{ kind: "rapid_module_replace", task: "T_ROB1", module: "MainModule", source }]
    },
    staging
  );
  assert.equal(again.operations[0].localPath, replace.localPath, "inline sources are content-addressed");

  const strict = { requireRapidStopped: true, allowedControllerStates: ["guardstop"] };
  const kept = await expandChangeset(
    { version: 1, controller: "robot2", expectedController: identity, safety: strict, operations: [setInit] },
    staging
  );
  assert.equal(kept.safety, strict, "explicit safety is not widened");

  await assert.rejects(
    expandChangeset(
      {
        version: 1,
        controller: "robot2",
        expectedController: identity,
        operations: [{ kind: "rapid_module_put", task: "T", module: "M", source, localPath: "x.mod" }]
      },
      staging
    ),
    /either source or localPath/
  );
  const searched = await shapeModuleSearch(
    [
      { Alias: "r", Task: "T", Module: "MainModule", SourceSha256: "a", Text: source },
      { Alias: "r", Task: "T", Module: "Other", SourceSha256: "b", Text: "MODULE Other\nPROC x()\n  WAITTIME 2;\nENDPROC\nENDMODULE\n" }
    ],
    { pattern: "waittime", context: 1, maxMatches: 1 },
    staging
  );
  assert.equal(searched.ModuleCount, 2);
  assert.equal(searched.Modules.length, 2, "both modules hit");
  assert.equal(searched.Modules[0].Routines, undefined, "a pattern search skips the outline by default");
  assert.equal(searched.MatchCount, 2, "pattern is case-insensitive");
  assert.equal(searched.Matches.length, 1);
  assert.equal(searched.Truncated, true);
  assert.deepEqual(
    {
      Module: searched.Matches[0].Module,
      Line: searched.Matches[0].Line,
      ContextStart: searched.Matches[0].ContextStart,
      Routine: searched.Matches[0].Routine
    },
    { Module: "MainModule", Line: 7, ContextStart: 6, Routine: "Pick:6-8" }
  );
  assert.equal(await readFile(searched.Modules[1].LocalPath, "utf8"), "MODULE Other\nPROC x()\n  WAITTIME 2;\nENDPROC\nENDMODULE\n");
  const searchModules = [
    { Alias: "r", Task: "T", Module: "MainModule", SourceSha256: "a", Text: source },
    { Alias: "r", Task: "T", Module: "Other", SourceSha256: "b", Text: "MODULE Other\nPROC x()\n  Stop;\nENDMODULE\n" }
  ];
  const oneHit = await shapeModuleSearch(searchModules, { pattern: "RETURN" }, staging);
  assert.deepEqual(oneHit.Modules.map((item) => item.Module), ["MainModule"], "modules without a hit are not listed");
  assert.equal(oneHit.ModuleCount, 2, "ModuleCount still counts every searched module");
  assert.equal(oneHit.Matches[0].Routine, "Twice:9-11");
  const outlined = await shapeModuleSearch(searchModules, { pattern: "RETURN", outline: true }, staging);
  assert.deepEqual(outlined.Modules[0].Routines, ["main:3-5", "Pick:6-8", "Twice:9-11", "OnErr:12-13"]);
  assert.deepEqual(outlined.Modules[1].Routines, ["x:2"], "a routine without an END line has no end");
  const outlineOnly = await shapeModuleSearch(
    [{ Alias: "r", Task: "T", Module: "Other", Text: "MODULE Other\nENDMODULE" }],
    { saveToFile: false },
    staging
  );
  assert.equal(outlineOnly.Matches, undefined);
  assert.deepEqual(outlineOnly.Modules[0].Routines, [], "no pattern keeps the outline");
  assert.equal(outlineOnly.Modules[0].LocalPath, undefined);

  let clock = 0;
  const calls = [];
  const reader = createTaskModuleReader(
    async (method, args) => {
      calls.push(`${method}:${args.module ?? ""}`);
      return method === "list_modules"
        ? { Task: "T", Modules: [{ Name: "B" }, { Name: "A" }] }
        : { Module: args.module, Text: `MODULE ${args.module}\nENDMODULE`, SourceSha256: args.module };
    },
    { ttlMs: 30_000, now: () => clock }
  );
  const first = await reader.read("r", undefined, null);
  assert.deepEqual(first.modules.map((item) => item.Module), ["A", "B"]);
  assert.deepEqual([first.task, first.cached, first.modules[0].Alias, first.modules[0].Task], ["T", 0, "r", "T"]);
  calls.length = 0;
  assert.equal((await reader.read("r", undefined, null)).cached, 2);
  assert.deepEqual(calls, ["list_modules:"], "a repeat only lists modules");
  calls.length = 0;
  assert.equal((await reader.read("r", undefined, null, ["a"])).cached, 1);
  assert.deepEqual(calls, ["list_modules:", "read_module:A"], "named modules are always read live");
  assert.equal((await reader.read("r", undefined, null, true)).cached, 0, "refresh bypasses the cache");
  assert.equal((await reader.read("other", undefined, null)).cached, 0, "another alias shares nothing");
  clock = 30_001;
  assert.equal((await reader.read("r", undefined, null)).cached, 0, "entries expire");
  reader.clear();
  assert.equal((await reader.read("r", undefined, null)).cached, 0, "clear drops everything");
  assert.deepEqual(
    stripDiagnostics({ Applied: true, Verified: true, PhaseTimingsMs: {}, TotalElapsedMs: 1, TimeoutDelta: 0, QueueWaitMs: 0, HttpElapsedMs: 0 }),
    { Applied: true, Verified: true }
  );
  const pinA = "A".repeat(64);
  const pinB = "B".repeat(64);
  const pinRegistry = { controllers: { r1: { certificateSha256: pinA }, r2: { certificateSha256: pinB }, old: {} } };
  assert.match(
    pinMismatchHint(`ABB RWS2 certificate pin mismatch: actual=${pinA}, expected=${pinB}`, pinRegistry),
    /registered as r1;/
  );
  assert.match(
    pinMismatchHint(`pin mismatch: actual=${"C".repeat(64)}, expected=${pinB}`, pinRegistry),
    /matches no registered alias/
  );
  assert.equal(pinMismatchHint("connect ETIMEDOUT", pinRegistry), null);
  console.log("tool-shaping ok");
} finally {
  await rm(staging, { recursive: true, force: true });
}
