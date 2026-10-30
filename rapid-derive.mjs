// Derive one product module from another ("make product N like product M").
// Pure text transform: the template's own symbols get the target's number,
// values stay the template's, unused template data is dropped, and
// collisions with the rest of the task are reported.

const DECL = /^[ \t]*(?:(LOCAL|TASK)[ \t]+)?(CONST|VAR|PERS)[ \t]+(\w+)[ \t]+(\w+)\b[^;]*;[ \t]*(?:\r?\n)?/gim;
const ROUTINE = /^[ \t]*(?:(LOCAL)[ \t]+)?(?:PROC|TRAP|FUNC[ \t]+\w+)[ \t]+(\w+)[ \t]*[(\s]/gim;
const MODULE = /^[ \t]*MODULE[ \t]+(\w+)/im;
const IDENT = /\b[A-Za-z_]\w*\b/g;

const ROUTINE_END = /^[ \t]*END(?:PROC|TRAP|FUNC)\b/gim;

// Module-level declarations only; routine-local VARs are not symbols of the module.
export function parseSymbols(text) {
  const starts = [...text.matchAll(ROUTINE)].map((match) => match.index);
  const ends = [...text.matchAll(ROUTINE_END)].map((match) => match.index);
  const insideRoutine = (index) =>
    starts.some((start) => start < index && !ends.some((end) => end > start && end < index));
  const data = [];
  for (const match of text.matchAll(DECL)) {
    if (insideRoutine(match.index)) continue;
    data.push({
      local: match[1]?.toUpperCase() === "LOCAL",
      storage: match[2].toUpperCase(),
      type: match[3],
      name: match[4],
      statement: match[0].trim(),
      index: match.index,
      length: match[0].length
    });
  }
  const routines = [...text.matchAll(ROUTINE)].map((match) => ({
    local: Boolean(match[1]),
    name: match[2]
  }));
  return { module: MODULE.exec(text)?.[1], data, routines };
}

export function productNumber(moduleName) {
  const digits = /(\d+)(?!.*\d)/.exec(String(moduleName))?.[1];
  if (!digits) throw new Error(`No product number in module name ${moduleName}; pass templateTag/targetTag.`);
  return digits;
}

// Swap the product number inside one identifier. The routine prefix wins
// (STEP02_02 -> STEP14_02), then an end suffix (B2_Drop_02 -> B2_Drop_14),
// then a short letter prefix (C17_penmo -> C14_penmo). Null = no product number.
export function swapTag(identifier, from, to) {
  const n = String(Number(from));
  const pad = (zeros) => String(Number(to)).padStart(zeros.length + n.length, "0");
  const rules = [
    new RegExp(`^((?:STEP|Step|step|program|Program|PROGRAM|Product|product)_?)(0*)${n}(?=_|$)`),
    new RegExp(`^(.*?[A-Za-z_])(0*)${n}$`),
    new RegExp(`^([A-Za-z]{1,2})(0*)${n}(?=_)`)
  ];
  for (const rule of rules) {
    const match = rule.exec(identifier);
    if (match) return identifier.replace(rule, (_, head, zeros) => head + pad(zeros));
  }
  return null;
}

function referenced(text, name, except) {
  const word = new RegExp(`\\b${name}\\b`, "i");
  return word.test(except ? text.slice(0, except.index) + text.slice(except.index + except.length) : text);
}

// options: { templateTag?, targetTag?, pointNames: "template" | "sequence", keepUnused?, keepTargetValues? }
// others: [{ Module, Text }] = every other loaded module of the task.
export function deriveModule({ template, target, others = [], options = {} }) {
  const from = options.templateTag ?? productNumber(template.Module);
  const to = options.targetTag ?? productNumber(target.Module);
  const targetText = target.Text ?? "";
  const targetSymbols = parseSymbols(targetText);
  let text = String(template.Text);
  const templateSymbols = parseSymbols(text);

  const dropped = [];
  const shared = [];
  // Unused template data is not copied; untagged data the target already
  // uses stays shared with the template (it is the same physical position).
  for (const decl of [...templateSymbols.data].reverse()) {
    const used = referenced(text, decl.name, decl);
    const tagged = swapTag(decl.name, from, to) !== null;
    const targetUses = !tagged && referenced(targetText, decl.name);
    if (targetUses && !decl.local) shared.push(decl.name);
    else if (!used && !options.keepUnused) dropped.push(decl.name);
    else continue;
    text = text.slice(0, decl.index) + text.slice(decl.index + decl.length);
  }

  const kept = parseSymbols(text);
  const rename = new Map();
  const original = new Map();
  const sequenced = new Set();
  const add = (name) => {
    const swapped = swapTag(name, from, to);
    rename.set(name.toLowerCase(), swapped ?? `${name}_${Number(to)}`);
    original.set(name.toLowerCase(), name);
  };
  if (templateSymbols.module) add(templateSymbols.module);
  for (const routine of kept.routines) add(routine.name);
  for (const decl of kept.data) add(decl.name);

  if (options.pointNames === "sequence") {
    const points = new Set(
      kept.data.filter((decl) => /^robtarget$/i.test(decl.type)).map((decl) => decl.name.toLowerCase())
    );
    const firstBody = kept.routines.length ? text.search(ROUTINE) : text.length;
    const order = [];
    for (const match of text.slice(firstBody).matchAll(IDENT)) {
      const key = match[0].toLowerCase();
      if (points.has(key) && !order.includes(key)) order.push(key);
    }
    for (const key of points) if (!order.includes(key)) order.push(key);
    order.forEach((key, index) => {
      rename.set(key, `P${Number(to)}_${index + 1}`);
      sequenced.add(key);
    });
  }

  // Swap only the template's own symbols; the matched spelling keeps its case
  // where swapTag applies (TPWrite " Program_017 " -> " Program_014 ").
  text = text.replace(IDENT, (id) => {
    const key = id.toLowerCase();
    const mapped = rename.get(key);
    if (!mapped) return id;
    if (sequenced.has(key)) return mapped;
    return swapTag(id, from, to) ?? mapped;
  });

  // Values come from the template (the products share the positions, only the
  // names differ). keepTargetValues keeps the target's own value instead.
  const keptValues = [];
  const replacedValues = [];
  const newData = [];
  const targetByName = new Map(targetSymbols.data.map((decl) => [decl.name.toLowerCase(), decl]));
  for (const decl of parseSymbols(text).data.reverse()) {
    const old = targetByName.get(decl.name.toLowerCase());
    if (!old || old.type.toLowerCase() !== decl.type.toLowerCase()) {
      newData.push({ name: decl.name, type: decl.type });
    } else if (options.keepTargetValues) {
      const at = text.indexOf(decl.statement, decl.index);
      text = text.slice(0, at) + old.statement + text.slice(at + decl.statement.length);
      keptValues.push(decl.name);
    } else if (old.statement.replace(/\s+/g, "") !== decl.statement.replace(/\s+/g, "")) {
      replacedValues.push(decl.name);
    }
  }

  const derived = parseSymbols(text);
  const derivedNames = new Set(
    [...derived.data, ...derived.routines].map((symbol) => symbol.name.toLowerCase())
  );
  const conflicts = [];
  const brokenReferences = [];
  for (const other of others) {
    if (other.Module === target.Module) continue;
    const symbols = parseSymbols(other.Text ?? "");
    for (const symbol of [...symbols.data, ...symbols.routines]) {
      if (!symbol.local && derivedNames.has(symbol.name.toLowerCase())) {
        conflicts.push({ Name: symbol.name, Module: other.Module });
      }
    }
  }
  const removedFromTarget = targetSymbols.data
    .filter((decl) => !derivedNames.has(decl.name.toLowerCase()))
    .map((decl) => decl.name);
  for (const name of [...removedFromTarget, ...targetSymbols.routines.map((r) => r.name)]) {
    if (derivedNames.has(name.toLowerCase())) continue;
    for (const other of others) {
      if (other.Module !== target.Module && referenced(other.Text ?? "", name)) {
        brokenReferences.push({ Name: name, UsedIn: other.Module });
      }
    }
  }

  const squash = (value) => value.replace(/\s+/g, "");
  return {
    Source: text,
    Report: {
      Template: template.Module,
      Target: target.Module,
      TargetExists: Boolean(target.Text),
      Tags: { From: from, To: to },
      Identical: target.Text !== undefined && text.replace(/\r\n/g, "\n") === targetText.replace(/\r\n/g, "\n"),
      SameIgnoringWhitespace: target.Text !== undefined && squash(text) === squash(targetText),
      Renamed: Object.fromEntries(
        [...rename].filter(([key, value]) => key !== value.toLowerCase()).map(([key, value]) => [original.get(key), value])
      ),
      KeptTargetValues: keptValues.reverse(),
      ReplacedTargetValues: replacedValues.reverse(),
      NewData: newData.reverse(),
      DroppedUnused: dropped.reverse(),
      SharedWithTemplate: shared.reverse(),
      RemovedFromTarget: removedFromTarget,
      Conflicts: conflicts,
      BrokenReferences: brokenReferences
    }
  };
}
