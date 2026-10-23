import assert from "node:assert/strict";
import { DirectChangesetPlanner } from "../direct-rws/changeset-planner.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = { Endpoint: "http://controller.invalid", Name: "MOCK",
  SystemId: "11111111-2222-3333-4444-555555555555", RobotWare: "6.13.0164" };
let active = 0;
let peak = 0;
let reads = 0;
let fail = false;
const readApi = {
  getIdentity: async () => identity,
  getControllerState: async () => ({ ControllerState: "motoroff", RapidState: "stopped", Opmode: "AUTO" }),
  async getRapidDataValue({ name }) {
    reads += 1;
    active += 1;
    peak = Math.max(peak, active);
    try {
      await sleep(name === "value0" ? 10 : 40);
      if (fail && name === "value0") throw new Error("Mock read failure");
      return name;
    } finally {
      active -= 1;
    }
  }
};
const planner = new DirectChangesetPlanner({ readApi, allowedConfigDomains: ["eio"], readConcurrency: 4 });
function manifest(names) {
  return {
    version: 1, controller: "mock",
    expectedController: { name: identity.Name, systemId: identity.SystemId, robotWare: identity.RobotWare },
    safety: { requireRapidStopped: true, allowedControllerStates: ["guardstop", "motoroff"] },
    operations: names.map((name) => ({ kind: "rapid_set_init", task: "T_ROB1", module: "Main", name, value: "2" }))
  };
}
const names = Array.from({ length: 20 }, (_, i) => `value${i}`);
const start = performance.now();
const result = await planner.prepare(manifest(names));
const elapsedMs = Math.round(performance.now() - start);
assert.equal(peak, 4);
assert.equal(reads, 20);
assert.deepEqual(result.Operations.map((operation) => operation.Name), names);
assert.deepEqual(result.Operations.map((operation) => operation.Before), names);

reads = 0;
await assert.rejects(planner.prepare(manifest(["shared", "shared"])), /conflict|duplicate/i);
assert.equal(reads, 1, "concurrent reads of one symbol must share the captured value");

reads = 0;
fail = true;
const plansBeforeFailure = planner.prepared.size;
await assert.rejects(planner.prepare(manifest(names)), /Mock read failure/);
assert.equal(active, 0);
assert.equal(reads, 4);
assert.equal(planner.prepared.size, plansBeforeFailure);
console.log(JSON.stringify({ ok: true, operations: 20, peak, elapsedMs,
  sharedReadsDeduplicated: true, stableOrder: true, failureDrained: true, controllerWrites: 0 }));
