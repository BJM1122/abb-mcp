// MCP-facing result shaping and changeset input expansion. The backends keep
// returning full evidence; this layer trims what an LLM client does not need
// and fills changeset fields that the registry already knows.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveModule } from "./rapid-derive.mjs";

const DIAGNOSTIC_KEYS = [
  "Metrics",
  "RequestDelta",
  "ReconnectDelta",
  "SessionCreateDelta",
  "ElapsedMs",
  "Session",
  "IdentityCacheHit",
  "IdentityAgeMs",
  "RegistryReloaded"
];

export const DEFAULT_SAFETY = Object.freeze({
  requireRapidStopped: true,
  allowedControllerStates: ["guardstop", "motoroff"]
});

export function stripDiagnostics(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const output = { ...result };
  for (const key of DIAGNOSTIC_KEYS) delete output[key];
  return output;
}

const ROUTINE_START = /^\s*(?:LOCAL\s+)?(?:PROC|TRAP|FUNC\s+\w+)\s+(\w+)\s*[(\s]/i;
const ROUTINE_END = /^\s*END(?:PROC|TRAP|FUNC)\b/i;

// Returns 1-based inclusive line bounds of one PROC/FUNC/TRAP.
export function findRoutine(lines, routine) {
  const wanted = routine.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROUTINE_START.exec(`${lines[index]} `);
    if (!match || match[1].toLowerCase() !== wanted) continue;
    for (let end = index + 1; end < lines.length; end += 1) {
      if (ROUTINE_END.test(lines[end])) return { start: index + 1, end: end + 1 };
      if (ROUTINE_START.test(`${lines[end]} `)) break;
    }
    throw new Error(`Routine ${routine} has no END line.`);
  }
  throw new Error(`Routine ${routine} not found in module.`);
}

export function moduleExtension(source) {
  const isSystem = /^\s*MODULE\s+\w+\s*\([^)]*\bSYSMODULE\b/im.test(source);
  const unicode = /[^\x00-\x7f]/.test(source);
  return `.${isSystem ? "sys" : "mod"}${unicode ? "x" : ""}`;
}

async function writeIfChanged(file, text) {
  try {
    if ((await readFile(file, "utf8")) === text) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

// Name derived from the online/inline source, so re-reading or re-expanding
// the same source yields the same path.
function contentFile(dir, module, text) {
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return path.join(dir, `${safeSegment(module)}-${digest}${moduleExtension(text)}`);
}

// Create-only: an existing file at this path holds the user's edits of the
// same online source, so it is never overwritten. Returns true if it differs.
async function writeUnlessPresent(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { encoding: "utf8", flag: "wx" });
    return false;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return (await readFile(file, "utf8")) !== text;
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

// view: { routine?, startLine?, endLine?, saveToFile? }
export async function shapeModuleRead(result, view, stagingDir) {
  const text = String(result.Text ?? "");
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const output = { ...result, LineCount: lines.length };
  if (view.saveToFile) {
    const file = contentFile(
      path.join(stagingDir, "modules", safeSegment(result.Alias), safeSegment(result.Task)),
      result.Module,
      text
    );
    output.LocalPath = file;
    if (await writeUnlessPresent(file, text)) output.LocalEdited = true;
  }
  let start = 1;
  let end = lines.length;
  if (view.routine) {
    ({ start, end } = findRoutine(lines, view.routine));
  } else if (view.startLine || view.endLine) {
    start = Math.max(1, view.startLine ?? 1);
    end = Math.min(lines.length, view.endLine ?? lines.length);
    if (start > end) throw new Error(`Empty line range ${start}-${end} (module has ${lines.length} lines).`);
  } else if (view.saveToFile) {
    delete output.Text;
    return output;
  }
  if (start !== 1 || end !== lines.length) {
    output.Text = lines.slice(start - 1, end).join("\n");
    output.Range = { Start: start, End: end };
  }
  return output;
}

// modules: [{ Alias, Task, Module, Text, SourceSha256 }] read in one batch.
// view: { pattern?, context?, maxMatches?, outline?, saveToFile? }
// Outline lists each module's routines; Matches holds pattern hits (case-insensitive).
export async function shapeModuleSearch(modules, view, stagingDir) {
  const regex = view.pattern ? new RegExp(view.pattern, "i") : null;
  const context = view.context ?? 0;
  const maxMatches = view.maxMatches ?? 200;
  const outline = [];
  const matches = [];
  let matchCount = 0;
  for (const module of modules) {
    const text = String(module.Text ?? "");
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const entry = { Module: module.Module, SourceSha256: module.SourceSha256, LineCount: lines.length };
    if (view.outline !== false) {
      entry.Routines = lines
        .map((line, index) => [ROUTINE_START.exec(`${line} `), index + 1])
        .filter(([match]) => match)
        .map(([match, line]) => `${match[1]}:${line}`);
    }
    if (view.saveToFile !== false) {
      const file = contentFile(
        path.join(stagingDir, "modules", safeSegment(module.Alias), safeSegment(module.Task)),
        module.Module,
        text
      );
      entry.LocalPath = file;
      if (await writeUnlessPresent(file, text)) entry.LocalEdited = true;
    }
    outline.push(entry);
    if (!regex) continue;
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      matchCount += 1;
      if (matches.length >= maxMatches) continue;
      const hit = { Module: module.Module, Line: index + 1, Text: lines[index].trim() };
      if (context > 0) {
        const start = Math.max(0, index - context);
        hit.Context = lines.slice(start, Math.min(lines.length, index + context + 1)).join("\n");
        hit.ContextStart = start + 1;
      }
      matches.push(hit);
    }
  }
  const output = { ModuleCount: modules.length, Modules: outline };
  if (regex) {
    output.MatchCount = matchCount;
    output.Matches = matches;
    if (matchCount > matches.length) output.Truncated = true;
  }
  return output;
}

// Derived source lands under staging/derived so the planner accepts its localPath.
export async function shapeModuleDerive(template, target, modules, options, stagingDir) {
  const { Source, Report } = deriveModule({ template, target, others: modules, options });
  const file = contentFile(
    path.join(stagingDir, "derived", safeSegment(template.Alias), safeSegment(template.Task)),
    target.Module,
    Source
  );
  await writeIfChanged(file, Source);
  return {
    ...Report,
    TargetSourceSha256: target.SourceSha256,
    LocalPath: file,
    PlanOperation: Report.Identical
      ? null
      : { kind: "rapid_module_replace", task: template.Task, module: target.Module, localPath: file }
  };
}

// view: { fields?, limit? }
export function shapeConfigList(result, view) {
  let instances = result.Instances ?? [];
  const output = { ...result };
  if (view.limit && instances.length > view.limit) {
    instances = instances.slice(0, view.limit);
    output.Truncated = true;
  }
  if (view.fields) {
    const wanted = view.fields;
    instances = instances.map((item) => ({
      Instance: item.Instance,
      Attributes: Object.fromEntries(
        wanted.filter((name) => name in (item.Attributes ?? {})).map((name) => [name, item.Attributes[name]])
      )
    }));
  }
  output.Instances = instances;
  return output;
}

// Fill the default safety gate and materialize inline RAPID `source` into a
// content-named file under stagingDir, so both backends keep receiving the
// localPath-only changeset they already validate. expectedController stays
// caller-supplied (required by the schema) as an independent identity lock.
export async function expandChangeset(changeset, stagingDir) {
  const output = { ...changeset };
  if (!output.safety) output.safety = { ...DEFAULT_SAFETY, allowedControllerStates: [...DEFAULT_SAFETY.allowedControllerStates] };
  output.operations = await Promise.all(
    changeset.operations.map(async (operation) => {
      if (!("source" in operation)) return operation;
      if ("localPath" in operation) {
        throw new Error(`${operation.kind} ${operation.module}: use either source or localPath, not both.`);
      }
      const { source, ...rest } = operation;
      const file = contentFile(
        path.join(stagingDir, "inline", safeSegment(changeset.controller), safeSegment(operation.task)),
        operation.module,
        source
      );
      await writeIfChanged(file, source);
      return { ...rest, localPath: file };
    })
  );
  return output;
}
