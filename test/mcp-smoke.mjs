import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import assert from "node:assert/strict";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const expectedChangesetBackend =
  process.env.ABB_MCP_CHANGESET_BACKEND === "direct-rws-preview"
    ? "direct-rws-preview"
    : "legacy-powershell";
const childEnvironment = getDefaultEnvironment();
for (const name of [
  "ABB_MCP_ALLOW_LEGACY",
  "ABB_MCP_CHANGESET_BACKEND",
  "ABB_MCP_CONFIG_MAX_ITEMS",
  "ABB_MCP_CONFIG_PAGE_SIZE",
  "ABB_MCP_MAX_SOCKETS",
  "ABB_MCP_OFFLINE_COOLDOWN_MS",
  "ABB_MCP_PWSH",
  "ABB_MCP_QUEUE_WAIT_MS",
  "ABB_MCP_REGISTRY",
  "ABB_MCP_SESSION_IDLE_SECONDS",
  "ABB_MCP_SIGNAL_MAX_ITEMS",
  "ABB_MCP_SIGNAL_PAGE_SIZE"
]) {
  if (process.env[name] !== undefined) {
    childEnvironment[name] = process.env[name];
  }
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server.mjs")],
  cwd: root,
  env: childEnvironment,
  stderr: "pipe"
});
const client = new Client({ name: "abb-local-smoke", version: "1.0.0" }, { capabilities: {} });

function structured(result) {
  if (result.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text || "MCP tool failed";
    throw new Error(message);
  }
  assert.equal(result.structuredContent, undefined, "results are text-only");
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expected = [
    "abb_health",
    "abb_list_controllers",
    "abb_probe_controller",
    "abb_register_controller",
    "abb_bind_controller",
    "abb_controller_snapshot",
    "abb_read_signals",
    "abb_list_config_instances",
    "abb_read_config_instance",
    "abb_list_rapid_modules",
    "abb_read_rapid_module",
    "abb_read_rapid_data",
    "abb_read_current_robtarget",
    "abb_plan_changeset",
    "abb_apply_changeset",
    "abb_verify_changeset",
    "abb_plan_backup",
    "abb_apply_backup",
    "abb_verify_backup",
    "abb_disconnect"
  ];
  const names = tools.tools.map((tool) => tool.name);
  const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`MCP tool mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
  }
  for (const name of [
    "abb_bind_controller",
    "abb_controller_snapshot",
    "abb_read_signals",
    "abb_list_rapid_modules",
    "abb_list_config_instances",
    "abb_read_config_instance",
    "abb_read_rapid_module",
    "abb_read_rapid_data",
    "abb_read_current_robtarget",
    "abb_plan_backup",
    "abb_disconnect"
  ]) {
    const schema = toolsByName.get(name)?.inputSchema;
    assert.ok(schema?.required?.includes("alias"), `${name} must require alias`);
    assert.equal(
      schema?.properties?.alias?.default,
      undefined,
      `${name} must not silently default alias`
    );
  }
  for (const name of ["abb_probe_controller", "abb_register_controller"]) {
    const schema = toolsByName.get(name)?.inputSchema;
    assert.ok(
      schema?.required?.includes("credentialAlias"),
      `${name} must require credentialAlias`
    );
    assert.equal(schema?.properties?.credentialAlias?.default, undefined);
  }
  const registerSchema = toolsByName.get("abb_register_controller")?.inputSchema;
  assert.equal(toolsByName.get("abb_probe_controller")?.inputSchema?.properties?.includeResources?.type, "boolean");
  for (const field of ["defaultTask", "ioNetwork", "ioDevice"]) {
    assert.ok(registerSchema?.required?.includes(field), `register must require ${field}`);
    assert.equal(registerSchema?.properties?.[field]?.default, undefined);
  }
  for (const name of [
    "abb_list_rapid_modules",
    "abb_read_rapid_module",
    "abb_read_rapid_data",
    "abb_read_current_robtarget"
  ]) {
    const schema = toolsByName.get(name)?.inputSchema;
    assert.equal(schema?.required?.includes("task"), false, `${name} task must be optional`);
    assert.equal(schema?.properties?.task?.default, undefined);
  }
  const missingAlias = await client.callTool({
    name: "abb_bind_controller",
    arguments: {}
  });
  assert.equal(missingAlias.isError, true, "missing alias must fail schema validation");
  assert.match(
    missingAlias.content?.find((item) => item.type === "text")?.text || "",
    /alias|required|invalid/i
  );
  for (const tool of tools.tools) {
    assert.equal(tool.outputSchema, undefined, `${tool.name} must stay text-only`);
  }
  const changesetSchema = toolsByName.get("abb_plan_changeset").inputSchema.properties.changeset;
  assert.equal(changesetSchema.required.includes("expectedController"), true, "identity lock stays caller-supplied");
  assert.equal(changesetSchema.required.includes("safety"), false);
  for (const extra of [{}, { source: "MODULE M\nENDMODULE", localPath: "C:\\x\\M.mod" }]) {
    const rejected = await client.callTool({
      name: "abb_plan_changeset",
      arguments: {
        changeset: {
          version: 1,
          controller: "schema_only_no_such_alias",
          expectedController: { name: "N", systemId: "S", robotWare: "6.15.00" },
          operations: [{ kind: "rapid_module_replace", task: "T_ROB1", module: "M", ...extra }]
        }
      }
    });
    assert.equal(rejected.isError, true, "module ops need exactly one of source/localPath");
    assert.match(rejected.content?.[0]?.text || "", /exactly one of source/);
  }
  const noIdentity = await client.callTool({
    name: "abb_plan_changeset",
    arguments: {
      changeset: {
        version: 1,
        controller: "schema_only_no_such_alias",
        operations: [{ kind: "rapid_module_replace", task: "T_ROB1", module: "M", source: "MODULE M\nENDMODULE" }]
      }
    }
  });
  assert.equal(noIdentity.isError, true, "missing expectedController must fail at the schema");
  assert.match(noIdentity.content?.[0]?.text || "", /expectedController/);
  const readModuleSchema = toolsByName.get("abb_read_rapid_module").inputSchema;
  for (const field of ["routine", "startLine", "endLine", "saveToFile"]) {
    assert.ok(readModuleSchema.properties[field], `read_rapid_module must expose ${field}`);
  }

  const health = structured(await client.callTool({ name: "abb_health", arguments: {} }));
  assert.equal(health.version, health.diskVersion);
  assert.equal(health.restartRequired, false);
  assert.equal(health.versionCheckError, undefined);
  const controllers = structured(await client.callTool({ name: "abb_list_controllers", arguments: {} }));
  if (
    !health?.ok ||
    health.backend !== "hybrid" ||
    health.backends?.read !== "direct-rws" ||
    health.backends?.changeset !== expectedChangesetBackend ||
    health.backends?.backup !== "direct-rws" ||
    health.legacy?.enabled !== (process.env.ABB_MCP_ALLOW_LEGACY !== "0") ||
    health.legacy?.started !== false ||
    health.legacy?.running !== false ||
    health.powershell !== (process.env.ABB_MCP_ALLOW_LEGACY === "0" ? "disabled" : "not started") ||
    !Array.isArray(controllers?.Controllers)
  ) {
    throw new Error(`MCP local smoke assertions failed: ${JSON.stringify(health)}`);
  }

  const result = {
    ok: true,
    toolCount: names.length,
    tools: names,
    health,
    controllerAliases: controllers.Controllers.map((item) => item.Alias)
  };

  if (process.env.ABB_MCP_LIVE_TEST === "1") {
    const started = performance.now();
    result.bind = structured(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "robot2" } }));
    result.snapshot = structured(await client.callTool({ name: "abb_controller_snapshot", arguments: { alias: "robot2" } }));
    result.signals = structured(
      await client.callTool({
        name: "abb_read_signals",
        arguments: {
          alias: "robot2",
          names: ["PF_DO30_TEST", "PF_DO31_TEST", "PF_DO33_TEST"]
        }
      })
    );
    if (
      process.env.ABB_MCP_LIVE_CHANGESET_PLAN === "1" &&
      expectedChangesetBackend === "direct-rws-preview"
    ) {
      const currentConfig = structured(
        await client.callTool({
          name: "abb_read_config_instance",
          arguments: {
            alias: "robot2",
            domain: "eio",
            type: "EIO_SIGNAL",
            instance: "MOCK_INPUT"
          }
        })
      );
      const plan = structured(
        await client.callTool({
          name: "abb_plan_changeset",
          arguments: {
            changeset: {
              version: 1,
              controller: "robot2",
              expectedController: {
                name: result.bind.Identity.Name,
                systemId: result.bind.Identity.SystemId,
                robotWare: result.bind.Identity.RobotWare
              },
              safety: {
                requireRapidStopped: true,
                allowedControllerStates: ["guardstop", "motoroff"]
              },
              operations: [
                {
                  kind: "cfg_set",
                  domain: "eio",
                  type: "EIO_SIGNAL",
                  instance: "MOCK_INPUT",
                  fields: {
                    DeviceMap:
                      currentConfig.Instance.Attributes.DeviceMap
                  }
                }
              ]
            }
          }
        })
      );
      if (
        plan.Prepared !== true ||
        plan.ChangesRequired !== 0 ||
        plan.ControllerModified !== false
      ) {
        throw new Error(
          "Direct live changeset plan was not an exact read-only no-op."
        );
      }
      // Do not expose or apply the short-lived approval token. Closing this
      // child MCP invalidates it immediately.
      result.directChangesetPlan = {
        Prepared: plan.Prepared,
        Controller: plan.Controller,
        Identity: plan.Identity,
        State: plan.State,
        OperationCount: plan.OperationCount,
        ChangesRequired: plan.ChangesRequired,
        RestartRequired: plan.RestartRequired,
        ControllerModified: plan.ControllerModified,
        TotalElapsedMs: plan.TotalElapsedMs,
        Metrics: plan.Metrics
      };
    }
    result.liveElapsedMs = Math.round(performance.now() - started);
    result.disconnect = structured(await client.callTool({ name: "abb_disconnect", arguments: { alias: "robot2" } }));
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
