import assert from "node:assert/strict";
import { deriveModule, parseSymbols, swapTag } from "../rapid-derive.mjs";

// Product numbers can appear in routine prefixes, station suffixes and point names.
assert.equal(swapTag("STEP02_02", "02", "14"), "STEP14_02", "routine prefix beats the step number");
assert.equal(swapTag("Step02_20", "02", "14"), "Step14_20");
assert.equal(swapTag("B2_Drop_02", "02", "14"), "B2_Drop_14", "B2 is a station, not the product");
assert.equal(swapTag("program_017", "17", "14"), "program_014", "zero padding is kept");
assert.equal(swapTag("STEP6_10", "06", "14"), "STEP14_10");
assert.equal(swapTag("A_Pick_6", "06", "14"), "A_Pick_14");
assert.equal(swapTag("Safe_Pos06", "06", "14"), "Safe_Pos14");
assert.equal(swapTag("trigg06", "06", "14"), "trigg14");
assert.equal(swapTag("C17_penmo", "17", "14"), "C14_penmo");
assert.equal(swapTag("P_start130", "06", "14"), null);
assert.equal(swapTag("C1_penmo180", "06", "14"), null);

const template = {
  Module: "Product_02",
  Text: [
    "MODULE Product_02",
    "    CONST robtarget A_Pick_02:=[[1,1,1],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "    CONST robtarget B2_Drop_02:=[[2,2,2],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "    CONST robtarget Safe_pos:=[[3,3,3],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "    CONST robtarget P_start80:=[[4,4,4],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "    CONST robtarget P_mid:=[[5,5,5],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "    PROC program_002()",
    "        TPWrite \" Program_002 \";",
    "        STEP02_02;",
    "    ENDPROC",
    "    PROC STEP02_02()",
    "        VAR num nLocal;",
    "        MoveL P_mid, v100, fine, tool2;",
    "        MoveL A_Pick_02, v100, fine, tool2;",
    "        MoveL B2_Drop_02, v100, fine, tool2;",
    "        MoveL Safe_pos, v100, fine, tool2;",
    "    ENDPROC",
    "ENDMODULE"
  ].join("\r\n")
};
const target = {
  Module: "Product_14",
  Text: [
    "MODULE Product_14",
    "  CONST robtarget A_Pick_14:=[[9,9,9],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "  CONST robtarget Old_14:=[[8,8,8],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];",
    "  PROC program_014()",
    "    MoveL Safe_pos, v100, fine, tool2;",
    "  ENDPROC",
    "ENDMODULE"
  ].join("\r\n")
};
const others = [
  template,
  target,
  { Module: "MainModule", Text: "MODULE MainModule\n  PROC main()\n    VAR num nLocal;\n    program_014;\n    MoveL Old_14, v100, fine, tool2;\n  ENDPROC\nENDMODULE" },
  { Module: "Product_15", Text: "MODULE Product_15\n  CONST robtarget P_mid_14:=[[0,0,0],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];\nENDMODULE" }
];

assert.deepEqual(
  parseSymbols(template.Text).data.map((decl) => decl.name),
  ["A_Pick_02", "B2_Drop_02", "Safe_pos", "P_start80", "P_mid"],
  "routine-local VARs are not module data"
);

const derived = deriveModule({ template, target, others });
const source = derived.Source;
assert.match(source, /^MODULE Product_14/);
assert.match(source, /PROC STEP14_02\(\)/);
assert.match(source, /TPWrite " Program_014 ";/, "string keeps its spelling");
assert.match(source, /CONST robtarget A_Pick_14:=\[\[1,1,1\]/, "values come from the template");
assert.match(source, /CONST robtarget B2_Drop_14:=\[\[2,2,2\]/, "new point copies the template value");
assert.doesNotMatch(source, /P_start80/, "unused template data is dropped");
assert.doesNotMatch(source, /CONST robtarget Safe_pos/, "shared point is not redeclared");
assert.match(source, /MoveL Safe_pos,/);
assert.match(source, /MoveL P_mid_14,/, "untagged template data gets the target suffix");
assert.match(source, /VAR num nLocal;/);
assert.deepEqual(derived.Report.ReplacedTargetValues, ["A_Pick_14"]);
assert.deepEqual(derived.Report.KeptTargetValues, []);
const keep = deriveModule({ template, target, others, options: { keepTargetValues: true } });
assert.match(keep.Source, /CONST robtarget A_Pick_14:=\[\[9,9,9\]/, "keepTargetValues keeps the taught value");
assert.deepEqual(keep.Report.KeptTargetValues, ["A_Pick_14"]);
assert.deepEqual(derived.Report.NewData.map((item) => item.name), ["B2_Drop_14", "P_mid_14"]);
assert.deepEqual(derived.Report.DroppedUnused, ["P_start80"]);
assert.deepEqual(derived.Report.SharedWithTemplate, ["Safe_pos"]);
assert.deepEqual(derived.Report.RemovedFromTarget, ["Old_14"]);
assert.deepEqual(derived.Report.Conflicts, [{ Name: "P_mid_14", Module: "Product_15" }]);
assert.deepEqual(derived.Report.BrokenReferences, [{ Name: "Old_14", UsedIn: "MainModule" }]);
assert.equal(derived.Report.Identical, false);

const sequence = deriveModule({ template, target, others, options: { pointNames: "sequence" } });
assert.match(sequence.Source, /MoveL P14_1, v100[\s\S]*MoveL P14_2, v100[\s\S]*MoveL P14_3, v100/, "points follow the path order");
assert.match(sequence.Source, /MoveL Safe_pos,/, "shared point is not renumbered");
assert.deepEqual(sequence.Report.KeptTargetValues, []);

const again = deriveModule({ template, target: { Module: "Product_14", Text: source }, others });
assert.equal(again.Report.Identical, true, "deriving onto its own result is a no-op");

console.log("rapid-derive ok");
