#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  AbbBackendRouter,
  normalizeChangesetBackend
} from "./backend-router.mjs";
import { singleFlightKey } from "./canonical-json.mjs";
import {
  expandChangeset,
  shapeConfigList,
  shapeModuleRead,
  stripDiagnostics
} from "./tool-shaping.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "abb-worker.ps1");
const registryPath = process.env.ABB_MCP_REGISTRY || path.join(here, "controller-registry.json");
// Inline RAPID sources and saved module reads land here; it must sit inside a
// registry allowedLocalRoots entry so the planners accept the files.
const stagingDir = process.env.ABB_MCP_STAGING_DIR || path.join(here, "artifacts", "staging");
// Session metrics/timings stay out of read results unless explicitly requested.
const includeDiagnostics = process.env.ABB_MCP_DIAGNOSTICS === "1";
const changesetBackend = normalizeChangesetBackend(
  process.env.ABB_MCP_CHANGESET_BACKEND
);
const pwsh =
  process.env.ABB_MCP_PWSH ||
  "pwsh";
const configuredOfflineCooldownMs = Number.parseInt(
  process.env.ABB_MCP_OFFLINE_COOLDOWN_MS ?? "5000",
  10
);
const offlineCooldownMs =
  Number.isFinite(configuredOfflineCooldownMs) &&
  configuredOfflineCooldownMs >= 500 &&
  configuredOfflineCooldownMs <= 60_000
    ? configuredOfflineCooldownMs
    : 5_000;

function environmentInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const pagination = Object.freeze({
  configPageSize: environmentInteger("ABB_MCP_CONFIG_PAGE_SIZE", 70, 1, 5_000),
  configMaxItems: environmentInteger(
    "ABB_MCP_CONFIG_MAX_ITEMS",
    20_000,
    1,
    1_000_000
  ),
  signalPageSize: environmentInteger("ABB_MCP_SIGNAL_PAGE_SIZE", 500, 1, 5_000),
  signalMaxItems: environmentInteger(
    "ABB_MCP_SIGNAL_MAX_ITEMS",
    50_000,
    1,
    1_000_000
  )
});
const maxSockets = environmentInteger("ABB_MCP_MAX_SOCKETS", 4, 1, 16);

let worker = null;
let workerReady = null;
let closing = false;
let closePromise = null;
let idleSweepTimer = null;
const readInflight = new Map();
const SINGLE_FLIGHT_READ_METHODS = new Set([
  "health",
  "list_controllers",
  "probe_controller",
  "bind",
  "snapshot",
  "read_signals",
  "list_modules",
  "list_config_instances",
  "read_config_instance",
  "read_module",
  "read_rapid_data",
  "read_current_robtarget"
]);

const configuredQueueWaitMs = Number.parseInt(process.env.ABB_MCP_QUEUE_WAIT_MS ?? "2000", 10);
const queueWaitMs =
  Number.isFinite(configuredQueueWaitMs) &&
  configuredQueueWaitMs >= 100 &&
  configuredQueueWaitMs <= 30_000
    ? configuredQueueWaitMs
    : 2_000;

const configuredIdleSeconds = Number.parseInt(process.env.ABB_MCP_SESSION_IDLE_SECONDS ?? "180", 10);
const sessionIdleSeconds = Number.isFinite(configuredIdleSeconds) && configuredIdleSeconds >= 30
  ? configuredIdleSeconds
  : 180;
const idleSweepIntervalMs = Math.min(60_000, Math.max(10_000, sessionIdleSeconds * 500));

function startIdleSweep() {
  if (idleSweepTimer || closing) return;
  idleSweepTimer = setInterval(async () => {
    if (closing || !worker || !workerReady || worker.busy) return;
    try {
      const readyWorker = await workerReady;
      if (readyWorker.busy) return;
      await readyWorker.call("disconnect_idle", { idleSeconds: sessionIdleSeconds }, 15_000);
    } catch (error) {
      if (!closing) console.error("abb-local idle session cleanup failed:", error);
    }
  }, idleSweepIntervalMs);
  idleSweepTimer.unref();
}

function ensureWorkerReady() {
  if (closing) return Promise.reject(new Error("ABB MCP server is closing"));
  if (workerReady && worker && !worker.closed) return workerReady;

  worker = null;
  workerReady = null;
  const candidate = new AbbBackendRouter({
    registryPath,
    offlineCooldownMs,
    pagination,
    maxSockets,
    allowLegacy: process.env.ABB_MCP_ALLOW_LEGACY !== "0",
    changesetBackend,
    legacyWorker: {
      command: pwsh,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        workerPath,
        "-RegistryPath",
        registryPath
      ],
      cwd: here,
      defaultQueueTimeoutMs: queueWaitMs
    }
  });
  worker = candidate;
  workerReady = candidate
    .call("health", {}, 15_000)
    .then(() => {
      startIdleSweep();
      return candidate;
    })
    .catch(async (error) => {
      if (worker === candidate) {
        worker = null;
        workerReady = null;
      }
      await candidate.close();
      throw error;
    });
  return workerReady;
}


const server = new McpServer(
  { name: "abb-local", version: "1.6.1" },
  {
    instructions:
      "Local ABB engineering gateway. Read tools take a registered alias directly: they open, identity-check and reuse the session automatically, so do not call list/bind first. Use abb_list_controllers only when the alias is unknown, abb_bind_controller only to confirm identity explicitly. New cabinet: probe(includeResources=true), confirm identity, register discovered names. Read only what the task needs: read_rapid_module with routine or startLine/endLine for excerpts, saveToFile=true to get a LocalPath for editing large modules; list_config_instances with fields/limit. Changesets: expectedController is required and must state the cabinet the user intends to change (name/SystemId/RobotWare), confirmed against a live read; it is an independent lock beside the registry; safety defaults to stopped RAPID + guardstop/motoroff; rapid_module_put/replace take exactly one of inline source or localPath. Plans include SourceDiff; SafetyBlocked previews have no token and need a replan after local stop. Approve the exact token-bearing plan once, then apply without repeating discovery. Writes recheck endpoint/name/SystemId/RobotWare, stopped RAPID and GuardStop/MotorsOff. Apply with Verified=true and VerificationMode=independent-session is complete; use abb_verify_changeset only for missing evidence, unknown outcomes or later checks. Never replay an uncertain write or approve a different plan. Never start RAPID, enable motors, jog, force I/O or command motion. After a transport failure, do not scan aliases/protocols, launch PC SDK discovery or change networking without a user request. After tooling updates, compare abb_health version/diskVersion before claiming activation."
  }
);

const domainSchema = z.enum(["eio", "sio", "sys", "proc"]);
const controllerAliasSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);
const controllerBaseUrlSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return ["http:", "https:"].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    (parsed.pathname === "/" || parsed.pathname === "");
}, "Use an absolute http(s) controller root URL without credentials, path, query, or fragment");
const cfgScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const cfgFieldsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
  cfgScalarSchema
);
const cfgInstanceCheckSchema = z
  .object({
    domain: domainSchema,
    type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
    instance: z.string().min(1).max(160),
    fields: cfgFieldsSchema
  })
  .strict();
const cfgSignalCheckSchema = z
  .object({
    name: z.string().min(1).max(160),
    fields: cfgFieldsSchema.optional()
  })
  .strict();
const cfgVerifySchema = z
  .object({
    cfgInstances: z.array(cfgInstanceCheckSchema).optional(),
    configSignals: z.array(cfgSignalCheckSchema).optional(),
    signals: z.array(z.string().min(1).max(160)).optional()
  })
  .strict()
  .refine(
    (value) =>
      (value.cfgInstances?.length || 0) + (value.configSignals?.length || 0) + (value.signals?.length || 0) > 0,
    "At least one verification check is required"
  );
// rapid_module_put/replace: inline source or a local file, never both or neither.
const exactlyOneModuleSource = (value) =>
  (value.source === undefined) !== (value.localPath === undefined);
const moduleSourceError = {
  message: "Provide exactly one of source (inline RAPID text) or localPath.",
  path: ["source"]
};
const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cfg_set"),
      domain: domainSchema,
      type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      instance: z.string().min(1).max(160),
      fields: cfgFieldsSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("cfg_upsert"),
      domain: domainSchema,
      type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      instance: z.string().min(1).max(160),
      fields: cfgFieldsSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("cfg_delete"),
      domain: domainSchema,
      type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      instanceKey: z.string().min(1).max(160),
      ifPresent: z.literal(true)
    })
    .strict(),
  z
    .object({
      kind: z.literal("cfg_file_load"),
      domain: domainSchema,
      actionType: z.enum(["add", "add-with-reset"]),
      localPath: z.string().min(1),
      verify: cfgVerifySchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("rapid_set_init"),
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      module: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      value: cfgScalarSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("rapid_module_put"),
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      module: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      localPath: z.string().min(1).optional(),
      source: z.string().min(1).max(4_000_000).optional()
    })
    .strict()
    .refine(exactlyOneModuleSource, moduleSourceError),
  z
    .object({
      kind: z.literal("rapid_module_replace"),
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      module: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      localPath: z.string().min(1).optional(),
      source: z.string().min(1).max(4_000_000).optional()
    })
    .strict()
    .refine(exactlyOneModuleSource, moduleSourceError),
  z
    .object({
      kind: z.literal("rapid_module_delete"),
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      module: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      ifPresent: z.literal(true),
      allowSystemModule: z.boolean().optional()
    })
    .strict()
]);

const changesetSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    controller: z.string().min(1),
    expectedController: z
      .object({
        name: z.string().min(1),
        systemId: z.string().min(1),
        robotWare: z.string().min(1)
      })
      .strict(),
    safety: z
      .object({
        requireRapidStopped: z.literal(true),
        allowedControllerStates: z.array(z.enum(["guardstop", "motoroff"])).min(1)
      })
      .strict()
      .optional(),
    operations: z.array(operationSchema).min(1).max(250),
    restart: z
      .object({
        required: z.boolean(),
        mode: z.literal("restart"),
        timeoutSeconds: z.number().int().min(30).max(600)
      })
      .optional()
  })
  .strict();

// Text only: no outputSchema/structuredContent, so clients do not receive
// (and models do not read) the same JSON twice.
function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function expandChangesetArgs({ changeset }) {
  return { args: { changeset: await expandChangeset(changeset, stagingDir) } };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const text =
    error?.code && !message.startsWith(`${error.code}:`)
      ? `${error.code}: ${message}`
      : message;
  return {
    isError: true,
    content: [{ type: "text", text }]
  };
}

function formatWorkerProgress(method, event) {
  const phase = event?.Phase || event?.phase || event?.Kind || event?.kind || "working";
  const data = event?.Data ?? event?.data;
  const detail = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  return `${method}: ${phase}${detail}`.slice(0, 500);
}

// shape.prepare(args) -> { args: backendArgs, view }; shape.present(result, view).
// Read results drop session diagnostics unless ABB_MCP_DIAGNOSTICS=1.
function registerWorkerTool(name, definition, method, timeoutMs = 60_000, shape = {}) {
  const present = async (result, view) => {
    const shaped = shape.present ? await shape.present(result, view) : result;
    return toolResult(
      SINGLE_FLIGHT_READ_METHODS.has(method) && !includeDiagnostics
        ? stripDiagnostics(shaped)
        : shaped
    );
  };
  server.registerTool(name, definition, async (toolArgs, extra) => {
    try {
      const { args, view } = shape.prepare
        ? await shape.prepare(toolArgs)
        : { args: toolArgs, view: undefined };
      let progress = 0;
      const progressToken = extra?._meta?.progressToken;
      const reportProgress = (event) => {
        progress += 1;
        const message = formatWorkerProgress(method, event);
        if (method === "commit_job" || method === "apply_backup") {
          console.error(`[abb-progress] ${message}`);
        }
        if (progressToken === undefined) return;
        return extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, message }
        });
      };
      const invoke = async () => {
        const readyWorker = await ensureWorkerReady();
        return readyWorker.call(method, args, timeoutMs, queueWaitMs, reportProgress);
      };
      if (!SINGLE_FLIGHT_READ_METHODS.has(method)) return await present(await invoke(), view);

      const key = singleFlightKey(method, args);
      let request = readInflight.get(key);
      if (!request) {
        request = invoke().finally(() => readInflight.delete(key));
        readInflight.set(key, request);
      }
      return await present(await request, view);
    } catch (error) {
      return toolError(error);
    }
  });
}

registerWorkerTool(
  "abb_health",
  {
    title: "ABB MCP health",
    description:
      "Check the local MCP and direct RWS backend only; does not contact a controller or start the legacy PowerShell backend.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  "health",
  10_000
);

registerWorkerTool(
  "abb_list_controllers",
  {
    title: "List registered ABB controllers",
    description: "List identity-locked local controller aliases without connecting to any cabinet.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  "list_controllers",
  10_000
);

registerWorkerTool(
  "abb_probe_controller",
  {
    title: "Probe a new ABB controller",
    description:
      "Read only: probe one exact controller URL with an explicit protocol and credential alias. Returns name, SystemId, and RobotWare. For new-cabinet registration, set includeResources=true to read actual RAPID tasks, I/O networks and devices instead of asking the user for those names. Resource reads share one session with bounded concurrency and identity is rechecked afterward. RWS2 requires the exact certificate SHA-256 pin. Does not scan, write the controller, or edit the registry.",
    inputSchema: {
      baseUrl: controllerBaseUrlSchema,
      credentialAlias: controllerAliasSchema,
      rwsProtocol: z.enum(["rws1", "rws2"]),
      includeResources: z.boolean().optional(),
      certificateSha256: z.string().regex(/^[0-9A-Fa-f:]{64,95}$/).optional(),
      requestTimeoutSeconds: z.number().int().min(1).max(30).default(5)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "probe_controller",
  180_000
);

registerWorkerTool(
  "abb_register_controller",
  {
    title: "Register an identity-locked ABB controller",
    description:
      "Probe one exact URL with an explicit RWS protocol, require an exact name/SystemId/RobotWare match, then atomically add or update its local registry alias. RWS2 also locks the exact server-certificate SHA-256. Copies only a DPAPI credential reference from credentialAlias; never writes the controller.",
    inputSchema: {
      alias: controllerAliasSchema,
      baseUrl: controllerBaseUrlSchema,
      rwsProtocol: z.enum(["rws1", "rws2"]),
      certificateSha256: z.string().regex(/^[0-9A-Fa-f:]{64,95}$/).optional(),
      expectedName: z.string().min(1),
      expectedSystemId: z.string().min(1),
      expectedRobotWare: z.string().min(1),
      credentialAlias: controllerAliasSchema,
      defaultTask: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      ioNetwork: z.string().min(1),
      ioDevice: z.string().min(1),
      requestTimeoutSeconds: z.number().int().min(1).max(30).default(5),
      longRequestTimeoutSeconds: z.number().int().min(5).max(1800).default(60)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "register_controller",
  15_000
);

registerWorkerTool(
  "abb_bind_controller",
  {
    title: "Bind ABB controller",
    description: "Open one reusable RWS session and verify endpoint, controller name, SystemId, and RobotWare against the registry.",
    inputSchema: { alias: controllerAliasSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "bind",
  12_000
);

registerWorkerTool(
  "abb_controller_snapshot",
  {
    title: "ABB controller snapshot",
    description: "Read identity, safety state, loaded RAPID modules, and industrial-network settings through the persistent RWS session.",
    inputSchema: { alias: controllerAliasSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "snapshot",
  30_000
);

registerWorkerTool(
  "abb_read_signals",
  {
    title: "Read ABB I/O signals",
    description: "Bulk-read named signals from the registered controller network/device in one tool call.",
    inputSchema: {
      alias: controllerAliasSchema,
      names: z.array(z.string().min(1)).min(1).max(200)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "read_signals",
  30_000
);

registerWorkerTool(
  "abb_list_rapid_modules",
  {
    title: "List ABB RAPID modules",
    description: "List loaded modules without opening a new RWS session. If task is omitted, use this controller alias's registered defaultTask.",
    inputSchema: {
      alias: controllerAliasSchema,
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "list_modules",
  60_000
);

registerWorkerTool(
  "abb_list_config_instances",
  {
    title: "List ABB configuration instances",
    description:
      "Paged read of EIO/SIO/SYS/PROC configuration instances, e.g. I/O signal config = domain eio, type EIO_SIGNAL, filterAttribute Name. Filter one attribute by prefix; fields keeps only the named attributes; limit caps returned instances (Count stays the full match count). Returns exact instance keys for later batch changes.",
    inputSchema: {
      alias: controllerAliasSchema,
      domain: z.enum(["eio", "sio", "sys", "proc"]),
      type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      filterAttribute: z.string().max(128).default(""),
      prefix: z.string().max(160).default(""),
      fields: z.array(z.string().min(1).max(128)).max(64).optional(),
      limit: z.number().int().min(1).max(20_000).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "list_config_instances",
  90_000,
  {
    prepare: ({ fields, limit, ...args }) => ({ args, view: { fields, limit } }),
    present: (result, view) => shapeConfigList(result, view)
  }
);

registerWorkerTool(
  "abb_read_config_instance",
  {
    title: "Read ABB configuration instance",
    description: "Read one exact EIO, SIO, SYS, or PROC configuration instance in one RWS request.",
    inputSchema: {
      alias: controllerAliasSchema,
      domain: z.enum(["eio", "sio", "sys", "proc"]),
      type: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      instance: z.string().min(1).max(160)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "read_config_instance",
  60_000
);

registerWorkerTool(
  "abb_read_rapid_module",
  {
    title: "Read ABB RAPID module",
    description: "Read one online RAPID module (task defaults to the alias's defaultTask). SourceSha256 and LineCount always cover the whole module. Narrow Text with routine (PROC/FUNC/TRAP name) or startLine/endLine. saveToFile=true writes the full module to a local file and returns LocalPath (Text omitted unless a range is also given); an existing file is never overwritten, LocalEdited=true means it already differs from the online module; edit that file and pass it as localPath in a changeset.",
    inputSchema: {
      alias: controllerAliasSchema,
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).optional(),
      module: z.string().min(1),
      routine: z.string().regex(/^[A-Za-z0-9_]{1,128}$/).optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      saveToFile: z.boolean().optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "read_module",
  90_000,
  {
    prepare: ({ routine, startLine, endLine, saveToFile, ...args }) => ({
      args,
      view: { routine, startLine, endLine, saveToFile }
    }),
    present: (result, view) => shapeModuleRead(result, view, stagingDir)
  }
);

registerWorkerTool(
  "abb_read_rapid_data",
  {
    title: "Read ABB RAPID data",
    description: "Read one exact online RAPID data symbol value through the identity-locked persistent RWS session. If task is omitted, use this controller alias's registered defaultTask.",
    inputSchema: {
      alias: controllerAliasSchema,
      task: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).optional(),
      module: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "read_rapid_data",
  60_000
);

registerWorkerTool(
  "abb_read_current_robtarget",
  {
    title: "Read current ABB robtarget",
    description:
      "Read the current task robtarget through the identity-locked persistent Direct RWS session. If task is omitted, use this controller alias's registered defaultTask. tool and wobj are required so the returned coordinates cannot silently use the wrong RAPID frame.",
    inputSchema: {
      alias: controllerAliasSchema,
      task: z
        .string()
        .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/)
        .optional(),
      tool: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      wobj: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  "read_current_robtarget",
  60_000
);

registerWorkerTool(
  "abb_plan_changeset",
  {
    title: "Plan ABB batch changeset",
    description:
      "Read-only exact changeset preview with bounded RAPID SourceDiff excerpts. Direct backend can preview while running: SafetyBlocked/WriteBlockers explain why no token is issued. Only a write-ready plan returns a ten-minute hash-locked token. If SourceDiff.Truncated, review the full local diff before approval. Never modifies the controller.",
    inputSchema: { changeset: changesetSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  "prepare_changeset",
  120_000,
  { prepare: expandChangesetArgs }
);

registerWorkerTool(
  "abb_apply_changeset",
  {
    title: "Apply planned ABB batch changeset",
    description:
      "WRITE: apply the exact hash-locked token returned by abb_plan_changeset. Reuses one session/mastership batch, builds each RAPID task once, restarts at most once, and verifies through a fresh session.",
    inputSchema: { token: z.string().regex(/^[a-f0-9]{32}$/) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  "commit_job",
  1_800_000
);

registerWorkerTool(
  "abb_verify_changeset",
  {
    title: "Verify ABB batch changeset",
    description: "Read-only independent-session verification. Direct backend permits running-state reads and allocates no write token. Use after unknown outcomes or for later checks; a successful apply with Verified=true and VerificationMode=independent-session already satisfies fresh verification.",
    inputSchema: { changeset: changesetSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "verify_changeset",
  180_000,
  { prepare: expandChangesetArgs }
);

registerWorkerTool(
  "abb_plan_backup",
  {
    title: "Plan ABB controller backup",
    description: "Read-only backup planner. Revalidates the identity-locked controller, safety state, remote target, and local target, then returns one short-lived hash-locked approval token without creating or downloading a backup.",
    inputSchema: {
      alias: controllerAliasSchema,
      localRoot: z.string().min(1),
      backupName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
      cell: z.string().min(1).max(80).optional(),
      robot: z.string().min(1).max(80).optional(),
      timeoutSeconds: z.number().int().min(30).max(1_800).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "plan_backup",
  120_000
);

registerWorkerTool(
  "abb_apply_backup",
  {
    title: "Apply ABB controller backup",
    description: "WRITE: apply only the exact single-use token returned by abb_plan_backup. Rechecks controller identity and safe state, creates one controller backup, recursively downloads it, and writes a local manifest; never starts RAPID, enables motors, jogs, forces I/O, or commands motion.",
    inputSchema: { token: z.string().regex(/^[a-f0-9]{32}$/) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  "apply_backup",
  1_830_000
);

registerWorkerTool(
  "abb_verify_backup",
  {
    title: "Verify ABB controller backup",
    description: "Read-only fresh-session verification of one backup manifest. Independently rechecks controller identity and compares the local files and remote backup tree without modifying the controller.",
    inputSchema: { manifestPath: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  "verify_backup",
  300_000
);

registerWorkerTool(
  "abb_disconnect",
  {
    title: "Disconnect ABB controller",
    description: "Log out and close the reusable RWS session for one registered controller alias.",
    inputSchema: { alias: controllerAliasSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  "disconnect",
  30_000
);

async function close() {
  if (closePromise) return await closePromise;
  closing = true;
  closePromise = (async () => {
    if (idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }
    // AbbBackendRouter.close() first rejects new calls, then drains calls that
    // already entered a controller queue (including commit_job) before it
    // closes tokens, bindings, or authenticated sessions.
    if (worker) await worker.close();
    await server.close();
  })();
  return await closePromise;
}

async function shutdown(exitCode = 0) {
  // A pending Promise alone does not keep Node alive after stdin EOF. Keep one
  // referenced handle until controller queues and authenticated sessions have
  // actually drained and closed.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await close();
    process.exitCode = exitCode;
  } catch (error) {
    console.error("abb-local MCP shutdown failed:", error);
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(0);
  });
}

// StdioServerTransport does not synthesize an MCP close event from stdin EOF.
// Codex/Inspector close their child stdin, so explicitly drain direct RWS
// sessions and any lazily-created legacy worker here.
process.stdin.once("end", () => {
  void shutdown(0);
});

process.once("beforeExit", async () => {
  await close();
});

// Warm only the in-process direct RWS service after the MCP handshake. The
// legacy PowerShell worker is never started by health or read-only tools.
server.server.oninitialized = () => {
  setImmediate(() => {
    ensureWorkerReady().catch((error) => {
      console.error("abb-local worker warmup failed:", error);
    });
  });
};

try {
  await server.connect(new StdioServerTransport());
  console.error("abb-local MCP server running on stdio");
} catch (error) {
  console.error("abb-local MCP server failed:", error);
  if (worker) await worker.close();
  process.exitCode = 1;
}
