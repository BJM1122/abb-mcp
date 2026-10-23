#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `abbctl - batch-oriented ABB engineering CLI

Usage:
  node abbctl.mjs health
  node abbctl.mjs controllers
  node abbctl.mjs probe <baseUrl> <credentialAlias> <rws1|rws2> [certificateSha256]
  node abbctl.mjs register <alias> <baseUrl> <rws1|rws2> <certificateSha256|-> <name> <systemId> <robotWare> <credentialAlias> <defaultTask> <ioNetwork> <ioDevice>
  node abbctl.mjs bind <alias>
  node abbctl.mjs snapshot <alias>
  node abbctl.mjs config-get <alias> <domain> <type> <instance>
  node abbctl.mjs config-list <alias> <domain> <type> [filterAttribute] [prefix]
  node abbctl.mjs signals <alias> <signal> [signal...]
  node abbctl.mjs modules <alias> [task]
  node abbctl.mjs module-get <alias> <task> <module>
  node abbctl.mjs data-get <alias> <task> <module> <name>
  node abbctl.mjs io-config <alias> [prefix]
  node abbctl.mjs disconnect <alias>
  node abbctl.mjs plan <changeset.json>
  node abbctl.mjs verify <changeset.json>
  node abbctl.mjs apply <changeset.json> --yes
  node abbctl.mjs backup-plan <alias> <localRoot> <backupName> [cell] [robot]
  node abbctl.mjs backup-apply <alias> <localRoot> <backupName> --yes
  node abbctl.mjs backup-verify <manifestPath>
  node abbctl.mjs batch <commands.json>

apply and backup-apply always plan again in the same process and require --yes.
They never start RAPID, enable motors, force I/O, jog, or command robot motion.

batch accepts a JSON array (or {"commands":[...]}) and reuses one MCP transport,
the same backend router, and its RWS sessions for every command:
  [
    {"id":"health-1","command":"health","args":[]},
    {"id":"health-2","command":"health","args":[]}
  ]

Batch execution is sequential and fail-fast. Each entry reports its own duration.
The same apply and backup-apply --yes requirements are enforced inside batch files.`;
}

function requireArg(value, label) {
  if (!value) throw new Error(`Missing ${label}\n\n${usage()}`);
  return value;
}

async function loadChangeset(file) {
  const full = path.resolve(requireArg(file, "changeset file"));
  return JSON.parse(await readFile(full, "utf8"));
}

function value(result) {
  if (result.isError) throw new Error(result.content?.find((x) => x.type === "text")?.text || "ABB MCP call failed");
  return result.structuredContent || JSON.parse(result.content?.find((x) => x.type === "text")?.text || "null");
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function normalizeBatchEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Batch entry ${index + 1} must be an object`);
  }
  const command = requireArg(entry.command, `command in batch entry ${index + 1}`);
  if (typeof command !== "string") {
    throw new Error(`Batch entry ${index + 1} command must be a string`);
  }
  if (command === "batch") {
    throw new Error(`Batch entry ${index + 1} cannot recursively run batch`);
  }
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Batch entry ${index + 1} args must be an array of strings`);
  }
  if (entry.id !== undefined && typeof entry.id !== "string" && typeof entry.id !== "number") {
    throw new Error(`Batch entry ${index + 1} id must be a string or number`);
  }
  return { id: entry.id ?? index + 1, command, args };
}

export async function loadBatch(file) {
  const full = path.resolve(requireArg(file, "batch file"));
  const document = JSON.parse(await readFile(full, "utf8"));
  const entries = Array.isArray(document) ? document : document?.commands;
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error("Batch file must contain a non-empty JSON array or a non-empty commands array");
  }
  if (entries.length > 500) {
    throw new Error("Batch file exceeds the 500-command safety limit");
  }
  return {
    file: full,
    commands: entries.map(normalizeBatchEntry)
  };
}

export async function executeCommand(client, command, args = []) {
  let result;
  switch (command) {
    case "health":
      result = value(await client.callTool({ name: "abb_health", arguments: {} }));
      break;
    case "controllers":
      result = value(await client.callTool({ name: "abb_list_controllers", arguments: {} }));
      break;
    case "probe": {
      const [baseUrl, credentialAlias, rwsProtocol, certificateSha256] = args;
      result = value(
        await client.callTool({
          name: "abb_probe_controller",
          arguments: {
            baseUrl: requireArg(baseUrl, "controller base URL"),
            credentialAlias: requireArg(credentialAlias, "credential alias"),
            rwsProtocol: requireArg(rwsProtocol, "RWS protocol"),
            ...(certificateSha256 ? { certificateSha256 } : {})
          }
        })
      );
      break;
    }
    case "register": {
      const [
        alias,
        baseUrl,
        rwsProtocol,
        certificateSha256,
        expectedName,
        expectedSystemId,
        expectedRobotWare,
        credentialAlias,
        defaultTask,
        ioNetwork,
        ioDevice
      ] = args;
      result = value(
        await client.callTool({
          name: "abb_register_controller",
          arguments: {
            alias: requireArg(alias, "new controller alias"),
            baseUrl: requireArg(baseUrl, "controller base URL"),
            rwsProtocol: requireArg(rwsProtocol, "RWS protocol"),
            ...(certificateSha256 && certificateSha256 !== "-"
              ? { certificateSha256 }
              : {}),
            expectedName: requireArg(expectedName, "expected controller name"),
            expectedSystemId: requireArg(expectedSystemId, "expected SystemId"),
            expectedRobotWare: requireArg(expectedRobotWare, "expected RobotWare"),
            credentialAlias: requireArg(credentialAlias, "credential alias"),
            defaultTask: requireArg(defaultTask, "default RAPID task"),
            ioNetwork: requireArg(ioNetwork, "I/O network"),
            ioDevice: requireArg(ioDevice, "I/O device")
          }
        })
      );
      break;
    }
    case "bind": {
      const [alias] = args;
      result = value(
        await client.callTool({
          name: "abb_bind_controller",
          arguments: { alias: requireArg(alias, "controller alias") }
        })
      );
      break;
    }
    case "snapshot": {
      const [alias] = args;
      result = value(
        await client.callTool({
          name: "abb_controller_snapshot",
          arguments: { alias: requireArg(alias, "controller alias") }
        })
      );
      break;
    }
    case "config-get": {
      const [alias, domain, type, instance] = args;
      result = value(
        await client.callTool({
          name: "abb_read_config_instance",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            domain: requireArg(domain, "configuration domain"),
            type: requireArg(type, "configuration type"),
            instance: requireArg(instance, "configuration instance")
          }
        })
      );
      break;
    }
    case "config-list": {
      const [alias, domain, type, filterAttribute = "", prefix = ""] = args;
      result = value(
        await client.callTool({
          name: "abb_list_config_instances",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            domain: requireArg(domain, "configuration domain"),
            type: requireArg(type, "configuration type"),
            filterAttribute,
            prefix
          }
        })
      );
      break;
    }
    case "signals": {
      const [alias, ...names] = args;
      if (!names.length) throw new Error(`At least one signal is required\n\n${usage()}`);
      result = value(
        await client.callTool({
          name: "abb_read_signals",
          arguments: { alias: requireArg(alias, "controller alias"), names }
        })
      );
      break;
    }
    case "modules": {
      const [alias, task] = args;
      const argumentsValue = {
        alias: requireArg(alias, "controller alias")
      };
      if (task !== undefined) {
        argumentsValue.task = requireArg(task, "RAPID task");
      }
      result = value(
        await client.callTool({
          name: "abb_list_rapid_modules",
          arguments: argumentsValue
        })
      );
      break;
    }
    case "module-get": {
      const [alias, task, module] = args;
      result = value(
        await client.callTool({
          name: "abb_read_rapid_module",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            task: requireArg(task, "RAPID task"),
            module: requireArg(module, "RAPID module")
          }
        })
      );
      break;
    }
    case "data-get": {
      const [alias, task, module, name] = args;
      result = value(
        await client.callTool({
          name: "abb_read_rapid_data",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            task: requireArg(task, "RAPID task"),
            module: requireArg(module, "RAPID module"),
            name: requireArg(name, "RAPID data name")
          }
        })
      );
      break;
    }
    case "io-config": {
      const [alias, prefix = ""] = args;
      result = value(
        await client.callTool({
          name: "abb_list_config_instances",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            domain: "eio",
            type: "EIO_SIGNAL",
            filterAttribute: "Name",
            prefix
          }
        })
      );
      break;
    }
    case "disconnect": {
      const [alias] = args;
      result = value(
        await client.callTool({
          name: "abb_disconnect",
          arguments: { alias: requireArg(alias, "controller alias") }
        })
      );
      break;
    }
    case "plan": {
      const changeset = await loadChangeset(args[0]);
      result = value(await client.callTool({ name: "abb_plan_changeset", arguments: { changeset } }));
      break;
    }
    case "verify": {
      const changeset = await loadChangeset(args[0]);
      result = value(await client.callTool({ name: "abb_verify_changeset", arguments: { changeset } }));
      break;
    }
    case "apply": {
      if (!args.includes("--yes")) throw new Error(`apply requires explicit --yes\n\n${usage()}`);
      const changeset = await loadChangeset(args.find((x) => x !== "--yes"));
      const plan = value(await client.callTool({ name: "abb_plan_changeset", arguments: { changeset } }));
      if (plan.Prepared !== true || !plan.Token) return { result: { plan }, exitCode: 2 };
      const apply = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: plan.Token } }));
      result = { plan, apply };
      return { result, exitCode: apply.Applied ? 0 : 2 };
    }
    case "backup-plan": {
      const [alias, localRoot, backupName, cell, robot] = args;
      const planArguments = {
        alias: requireArg(alias, "controller alias"),
        localRoot: requireArg(localRoot, "backup local root"),
        backupName: requireArg(backupName, "backup name")
      };
      if (cell) planArguments.cell = cell;
      if (robot) planArguments.robot = robot;
      result = value(
        await client.callTool({
          name: "abb_plan_backup",
          arguments: planArguments
        })
      );
      break;
    }
    case "backup-apply": {
      if (!args.includes("--yes")) {
        throw new Error(`backup-apply requires explicit --yes\n\n${usage()}`);
      }
      const [alias, localRoot, backupName] = args.filter((value) => value !== "--yes");
      const plan = value(
        await client.callTool({
          name: "abb_plan_backup",
          arguments: {
            alias: requireArg(alias, "controller alias"),
            localRoot: requireArg(localRoot, "backup local root"),
            backupName: requireArg(backupName, "backup name")
          }
        })
      );
      const apply = value(
        await client.callTool({
          name: "abb_apply_backup",
          arguments: { token: plan.Token }
        })
      );
      result = { plan, apply };
      return { result, exitCode: apply.Applied ? 0 : 2 };
    }
    case "backup-verify": {
      const [manifestPath] = args;
      result = value(
        await client.callTool({
          name: "abb_verify_backup",
          arguments: {
            manifestPath: path.resolve(requireArg(manifestPath, "backup manifest path"))
          }
        })
      );
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  return { result, exitCode: 0 };
}

export async function executeBatch(client, commands) {
  const started = performance.now();
  const results = [];
  let exitCode = 0;

  for (let index = 0; index < commands.length; index += 1) {
    const entry = normalizeBatchEntry(commands[index], index);
    const commandStarted = performance.now();
    try {
      const outcome = await executeCommand(client, entry.command, entry.args);
      const item = {
        id: entry.id,
        command: entry.command,
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        durationMs: roundMs(performance.now() - commandStarted),
        result: outcome.result
      };
      results.push(item);
      if (outcome.exitCode !== 0) {
        exitCode = outcome.exitCode;
        break;
      }
    } catch (error) {
      results.push({
        id: entry.id,
        command: entry.command,
        ok: false,
        exitCode: 1,
        durationMs: roundMs(performance.now() - commandStarted),
        error: error.message
      });
      exitCode = 1;
      break;
    }
  }

  return {
    result: {
      ok: exitCode === 0,
      failFast: true,
      requestedCommands: commands.length,
      executedCommands: results.length,
      durationMs: roundMs(performance.now() - started),
      commands: results
    },
    exitCode
  };
}

function createClient() {
  // Forward only ABB settings, rather than unrelated model/API credentials.
  const env = getDefaultEnvironment();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("ABB_MCP_") && value !== undefined) env[name] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "server.mjs")],
    cwd: here,
    env,
    stderr: "inherit"
  });
  const client = new Client({ name: "abbctl", version: "1.4.3" }, { capabilities: {} });
  return { client, transport };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }

  const { client, transport } = createClient();
  const connectStarted = performance.now();
  try {
    await client.connect(transport);
    const connectMs = roundMs(performance.now() - connectStarted);
    let outcome;
    if (command === "batch") {
      const batch = await loadBatch(args[0]);
      outcome = await executeBatch(client, batch.commands);
      outcome.result.file = batch.file;
      outcome.result.connectMs = connectMs;
    } else {
      outcome = await executeCommand(client, command, args);
    }
    console.log(JSON.stringify(outcome.result, null, 2));
    return outcome.exitCode;
  } finally {
    await client.close();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedPath === modulePath) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`abbctl: ${error.message}`);
      process.exitCode = 1;
    });
}
