import assert from "node:assert/strict";
import { parseRapidRobtarget } from "../direct-rws/service.mjs";

const parsed = parseRapidRobtarget(`
  <html><body><ul>
    <li title="robtarget" class="state rapid-robtarget">
      <span class="x">1.25</span>
      <span class="y">-2.5</span>
      <span class="z">3E2</span>
      <span class="q1">1</span>
      <span class="q2">0</span>
      <span class="q3">0</span>
      <span class="q4">0</span>
      <span class="cf1">0</span>
      <span class="cf4">-1</span>
      <span class="cf6">2</span>
      <span class="cfx">0</span>
      <span class="ej1">9E9</span>
      <span class="ej2">9E9</span>
      <span class="ej3">9E9</span>
      <span class="ej4">9E9</span>
      <span class="ej5">9E9</span>
      <span class="ej6">9E9</span>
    </li>
  </ul></body></html>
`);

assert.equal(
  parsed.Value,
  "[[1.25,-2.5,3E2],[1,0,0,0],[0,-1,2,0],[9E9,9E9,9E9,9E9,9E9,9E9]]"
);
assert.deepEqual(parsed.Trans, { X: 1.25, Y: -2.5, Z: 300 });
assert.deepEqual(parsed.Robconf, { Cf1: 0, Cf4: -1, Cf6: 2, Cfx: 0 });
assert.equal(parsed.Extax.EaxF, 9e9);

assert.throws(
  () =>
    parseRapidRobtarget(
      '<li class="rapid-robtarget"><span class="x">1</span></li>'
    ),
  /component is missing or invalid: y/
);
assert.throws(
  () => parseRapidRobtarget('<li class="not-a-robtarget"></li>'),
  /payload missing rapid-robtarget/
);

console.log(
  JSON.stringify({
    ok: true,
    value: parsed.Value,
    structured: true,
    invalidPayloadFailsClosed: true
  })
);
