import assert from "node:assert/strict";

import { canonicalJsonStringify, singleFlightKey } from "../canonical-json.mjs";

const first = {
  alias: "robot2",
  domain: "eio",
  filter: { prefix: "PF_", attributes: { Device: "PN", Name: "Signal" } }
};
const reordered = {
  filter: { attributes: { Name: "Signal", Device: "PN" }, prefix: "PF_" },
  domain: "eio",
  alias: "robot2"
};

assert.notEqual(JSON.stringify(first), JSON.stringify(reordered));
assert.equal(canonicalJsonStringify(first), canonicalJsonStringify(reordered));
assert.equal(
  singleFlightKey("list_config_instances", first),
  singleFlightKey("list_config_instances", reordered)
);
assert.notEqual(
  singleFlightKey("list_config_instances", first),
  singleFlightKey("read_config_instance", reordered)
);
assert.notEqual(
  canonicalJsonStringify({ names: ["A", "B"] }),
  canonicalJsonStringify({ names: ["B", "A"] }),
  "array order is request semantics and must not be normalized"
);
assert.equal(
  canonicalJsonStringify({ nested: [{ z: 1, a: 2 }], omitted: undefined }),
  '{"nested":[{"a":2,"z":1}]}'
);
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => canonicalJsonStringify(cyclic), /cyclic JSON value/);

console.log("single-flight canonical key tests passed");
