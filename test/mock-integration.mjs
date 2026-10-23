import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspace = root;
const temp = await mkdtemp(path.join(os.tmpdir(), "abb-mcp-mock-"));
const credentialFile = path.join(temp, "mock.clixml");

execFileSync(process.env.ABB_MCP_PWSH || "pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$c = [pscredential]::new('mock-user', (ConvertTo-SecureString 'mock-password-only' -AsPlainText -Force)); $c | Export-Clixml -LiteralPath $env:ABB_TEST_CREDENTIAL"], { env: { ...process.env, ABB_TEST_CREDENTIAL: credentialFile }, windowsHide: true });
const counters = {
  get: 0,
  post: 0,
  put: 0,
  delete: 0,
  mastershipRequest: 0,
  mastershipRelease: 0,
  cfgSet: 0,
  cfgCreate: 0,
  cfgDelete: 0,
  cfgValidate: 0,
  cfgLoad: 0,
  stagingCreate: 0,
  fileUpload: 0,
  stagingDelete: 0,
  rapidLoadModule: 0,
  rapidUnloadModule: 0,
  rapidBuild: 0,
  restart: 0,
  logout: 0,
  signalRead: 0,
  sioInstanceRead: 0,
  paths: []
};

const uploads = new Map();
let restartOfflineChecks = 0;
let restartOfflineChecksPerRequest = 1;
let restartStatus = 204;
let cfgLoadStatus = 204;
let buildErrors = [];
let mutateNetworkOnMastership = false;
let signalReadStatus = 200;
let signalReadUnauthorizedRemaining = 0;
let signalReadDelayMs = 0;
let sioInstanceDelayMs = 0;
const rapidModules = new Map([
  ["MainModule", "MODULE MainModule\n    PROC main()\n        Stop;\n    ENDPROC\nENDMODULE"],
  ["WorldZone", "MODULE WorldZone(SYSMODULE)\n    PROC Power_On()\n    ENDPROC\nENDMODULE"],
  ["MockModule", "MODULE MockModule\n    PERS num Revision:=1;\nENDMODULE"],
  ["OldModule", "MODULE OldModule\n    PROC old()\n    ENDPROC\nENDMODULE"]
]);
const rapidData = new Map([
  ["T_ROB1/MockModule/Revision", "1"],
  ["T_DEFAULT/MockModule/Revision", "2"]
]);

const network = {
  Name: "PROFINET",
  Connection: "PROFINET Network",
  Address: "192.0.2.100",
  SubnetMask: "255.255.255.0",
  Gateway: "0.0.0.0",
  StationName: "robot2"
};

const sioNetwork = {
  Name: "PROFINET Network",
  Address: "192.0.2.100",
  SubnetMask: "255.255.255.0",
  Interface: "LAN3"
};

const signalConfigs = [
  { Name: "PF_DO30_TEST", SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "0" },
  { Name: "PF_DO31_TEST", SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "1" },
  { Name: "PF_DO33_TEST", SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "9" },
  { Name: "PF_OLD", SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "99" }
];

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/hal+json" });
  res.end(JSON.stringify(value));
}

function systemPayload() {
  return {
    _embedded: {
      _state: [
        {
          _type: "sys-system-li",
          name: "MOCK-ABB",
          sysid: "{11111111-2222-3333-4444-555555555555}",
          rwversion: "6.13.0164"
        }
      ]
    }
  };
}

function statePayload(property, value) {
  return { _embedded: { _state: [{ [property]: value }] } };
}

function networkPayload() {
  return {
    _embedded: {
      _state: [
        {
          _title: "PROFINET",
          rdonly: "false",
          attrib: Object.entries(network).map(([key, value]) => ({ _title: key, value }))
        }
      ]
    }
  };
}

function configInstancePayload(key, attributes, instanceid = "") {
  return {
    _embedded: {
      _state: [
        {
          _title: key,
          instanceid,
          rdonly: "false",
          attrib: Object.entries(attributes).map(([name, value]) => ({ _title: name, value }))
        }
      ]
    }
  };
}

function signalPayload(name) {
  return {
    _embedded: {
      _state: [
        {
          name,
          lvalue: "0",
          lstate: "not simulated",
          phstate: "0",
          quality: "1",
          simstate: "not simulated"
        }
      ]
    }
  };
}

async function handleSignalReadFault(res) {
  counters.signalRead += 1;
  if (signalReadDelayMs > 0) {
    const delay = signalReadDelayMs;
    signalReadDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (res.destroyed) return true;
  }
  if (signalReadUnauthorizedRemaining > 0) {
    signalReadUnauthorizedRemaining -= 1;
    res.writeHead(401);
    res.end("mock expired RWS session");
    return true;
  }
  if (signalReadStatus !== 200) {
    const status = signalReadStatus;
    signalReadStatus = 200;
    res.writeHead(status);
    res.end(`mock signal-read HTTP ${status}`);
    return true;
  }
  return false;
}

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const mock = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const method = req.method.toLowerCase();
  counters[method] += 1;
  counters.paths.push(`${req.method} ${url.pathname}${url.search}`);

  if (req.method === "GET" && url.pathname === "/rw/system") {
    if (restartOfflineChecks > 0) {
      restartOfflineChecks -= 1;
      res.writeHead(503);
      return res.end("mock controller restarting");
    }
    return json(res, 200, systemPayload());
  }
  if (req.method === "GET" && url.pathname === "/rw/panel/opmode") return json(res, 200, statePayload("opmode", "AUTO"));
  if (req.method === "GET" && url.pathname === "/rw/panel/ctrlstate") return json(res, 200, statePayload("ctrlstate", "guardstop"));
  if (req.method === "GET" && url.pathname === "/rw/rapid/execution") return json(res, 200, statePayload("ctrlexecstate", "stopped"));
  if (req.method === "GET" && url.pathname === "/rw/rapid/modules") {
    return json(res, 200, {
      _embedded: {
        _state: [...rapidModules.keys()].map((name) => ({ name, type: name === "WorldZone" ? "SysMod" : "ProgMod" }))
      }
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/rw/rapid/modules/")) {
    const moduleName = decodeURIComponent(url.pathname.split("/").at(-1));
    if (!rapidModules.has(moduleName)) {
      res.writeHead(400);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/xhtml+xml" });
    return res.end(`<html><body><span class="text">${escapeXml(rapidModules.get(moduleName))}</span></body></html>`);
  }
  if (req.method === "GET" && url.pathname.startsWith("/rw/rapid/symbol/data/RAPID/")) {
    const key = decodeURIComponent(url.pathname).split("/").slice(6).join("/");
    if (!rapidData.has(key)) {
      res.writeHead(400);
      return res.end();
    }
    return json(res, 200, {
      _embedded: {
        _state: [{ _type: "rap-data", value: rapidData.get(key) }]
      }
    });
  }
  if (
    req.method === "GET" &&
    [
      "/rw/rapid/tasks/T_DEFAULT/motion",
      "/rw/rapid/tasks/T_ROB1/motion"
    ].includes(url.pathname) &&
    url.searchParams.get("resource") === "robtarget" &&
    url.searchParams.get("tool") === "tool0" &&
    url.searchParams.get("wobj") === "wobj0"
  ) {
    res.writeHead(200, { "content-type": "application/xhtml+xml" });
    return res.end(
      '<html><body><div class="state"><ul>' +
        '<li class="rapid-robtarget" title="robtarget">' +
        '<span class="x">101.25</span><span class="y">-202.5</span><span class="z">303.75</span>' +
        '<span class="q1">0.5</span><span class="q2">0.5</span><span class="q3">0.5</span><span class="q4">0.5</span>' +
        '<span class="cf1">0</span><span class="cf4">-1</span><span class="cf6">2</span><span class="cfx">0</span>' +
        '<span class="ej1">9E9</span><span class="ej2">9E9</span><span class="ej3">9E9</span>' +
        '<span class="ej4">9E9</span><span class="ej5">9E9</span><span class="ej6">9E9</span>' +
        "</li></ul></div></body></html>"
    );
  }
  if (req.method === "GET" && url.pathname === "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/PROFINET") {
    return json(res, 200, networkPayload());
  }
  if (req.method === "GET" && decodeURIComponent(url.pathname) === "/rw/cfg/sio/IP_SETTING/instances/PROFINET Network") {
    counters.sioInstanceRead += 1;
    if (sioInstanceDelayMs > 0) {
      const delay = sioInstanceDelayMs;
      sioInstanceDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return json(res, 200, configInstancePayload("PROFINET Network", sioNetwork, "1"));
  }
  if (req.method === "GET" && url.pathname === "/rw/cfg/sio/IP_SETTING/instances") {
    return json(res, 200, { _links: {}, ...configInstancePayload("PROFINET Network", sioNetwork, "1") });
  }
  if (req.method === "GET" && url.pathname === "/rw/cfg/eio/EIO_SIGNAL/instances") {
    return json(res, 200, {
      _links: {},
      _embedded: {
        _state: signalConfigs.map((signal) => ({
          _title: signal.Name,
          rdonly: "false",
          attrib: Object.entries(signal).map(([key, value]) => ({ _title: key, value }))
        }))
      }
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/rw/cfg/eio/EIO_SIGNAL/instances/")) {
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    const signal = signalConfigs.find((item) => item.Name === key);
    if (!signal) {
      res.writeHead(400);
      return res.end();
    }
    return json(res, 200, configInstancePayload(key, signal, String(signalConfigs.indexOf(signal) + 1)));
  }
  if (req.method === "GET" && url.pathname === "/rw/iosystem/signals") {
    if (await handleSignalReadFault(res)) return;
    return json(res, 200, {
      _links: {},
      _embedded: {
        _state: signalConfigs.map((signal) => ({
          _title: `PROFINET/PN_Internal_Device/${signal.Name}`,
          name: signal.Name,
          type: signal.SignalType,
          lvalue: "0",
          lstate: "not simulated"
        }))
      }
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/rw/iosystem/signals/PROFINET/PN_Internal_Device/")) {
    if (await handleSignalReadFault(res)) return;
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    if (!signalConfigs.some((signal) => signal.Name === name)) {
      res.writeHead(404);
      return res.end("mock signal not found");
    }
    return json(res, 200, signalPayload(name));
  }
  if (req.method === "GET" && url.pathname === "/logout") {
    counters.logout += 1;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/fileservice/$HOME/") {
    counters.stagingCreate += 1;
    res.writeHead(201);
    return res.end();
  }
  if (req.method === "PUT" && url.pathname.startsWith("/fileservice/$HOME/")) {
    counters.fileUpload += 1;
    const segments = url.pathname.split("/").filter(Boolean);
    const directory = segments.at(-2);
    const fileName = segments.at(-1);
    uploads.set(`HOME:/${directory}/${fileName}`, await readBody(req));
    res.writeHead(201);
    return res.end();
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/fileservice/$HOME/codex_mcp_")) {
    counters.stagingDelete += 1;
    const directory = url.pathname.split("/").at(-1);
    for (const key of [...uploads.keys()]) {
      if (key.startsWith(`HOME:/${directory}/`)) uploads.delete(key);
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/mastership" && url.searchParams.get("action") === "request") {
    counters.mastershipRequest += 1;
    if (mutateNetworkOnMastership) {
      network.Gateway = "external-change";
      mutateNetworkOnMastership = false;
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/mastership" && url.searchParams.get("action") === "release") {
    counters.mastershipRelease += 1;
    res.writeHead(204);
    return res.end();
  }
  if (
    req.method === "POST" &&
    url.pathname === "/rw/cfg/eio/INDUSTRIAL_NETWORK/instances/PROFINET" &&
    url.searchParams.get("action") === "set"
  ) {
    counters.cfgSet += 1;
    const fields = new URLSearchParams(await readBody(req));
    for (const [key, value] of fields) network[key] = value;
    res.writeHead(204);
    return res.end();
  }
  if (
    req.method === "POST" &&
    url.pathname === "/rw/cfg/eio/EIO_SIGNAL/instances" &&
    url.searchParams.get("action") === "create-default"
  ) {
    const fields = new URLSearchParams(await readBody(req));
    const name = fields.get("name");
    if (!name || signalConfigs.some((item) => item.Name === name)) {
      res.writeHead(400);
      return res.end("duplicate or missing signal name");
    }
    signalConfigs.push({ Name: name, SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "0" });
    counters.cfgCreate += 1;
    res.writeHead(201, { location: `/rw/cfg/eio/EIO_SIGNAL/instances/${encodeURIComponent(name)}` });
    return res.end();
  }
  if (
    req.method === "POST" &&
    url.pathname.startsWith("/rw/cfg/eio/EIO_SIGNAL/instances/") &&
    url.searchParams.get("action") === "set"
  ) {
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    const signal = signalConfigs.find((item) => item.Name === key);
    if (!signal) {
      res.writeHead(400);
      return res.end("missing signal");
    }
    const fields = new URLSearchParams(await readBody(req));
    for (const [name, value] of fields) signal[name] = value;
    counters.cfgSet += 1;
    res.writeHead(204);
    return res.end();
  }
  if (
    req.method === "POST" &&
    decodeURIComponent(url.pathname) === "/rw/cfg/sio/IP_SETTING/instances/PROFINET Network" &&
    url.searchParams.get("action") === "set"
  ) {
    counters.cfgSet += 1;
    const fields = new URLSearchParams(await readBody(req));
    for (const [key, value] of fields) sioNetwork[key] = value;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/rw/cfg/eio/EIO_SIGNAL/instances/")) {
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    const index = signalConfigs.findIndex((item) => item.Name === key);
    if (index < 0) {
      res.writeHead(404);
      return res.end();
    }
    signalConfigs.splice(index, 1);
    counters.cfgDelete += 1;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/cfg" && url.searchParams.get("action") === "validate") {
    counters.cfgValidate += 1;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/cfg" && url.searchParams.get("action") === "load") {
    counters.cfgLoad += 1;
    const form = new URLSearchParams(await readBody(req));
    const source = uploads.get(form.get("filepath"));
    if (!source) {
      res.writeHead(400);
      return res.end("missing staged cfg");
    }
    if (cfgLoadStatus !== 204) {
      res.writeHead(cfgLoadStatus);
      return res.end("mock cfg load rejected");
    }
    const joined = source.replace(/\\\r?\n\s*/g, " ");
    for (const line of joined.split(/\r?\n/)) {
      if (!line.includes("-Name")) continue;
      const fields = Object.fromEntries(
        [...line.matchAll(/-([A-Za-z0-9_]+)\s+"([^"]*)"/g)].map((match) => [match[1], match[2]])
      );
      if (!fields.Name) continue;
      const existing = signalConfigs.find((item) => item.Name === fields.Name);
      if (existing) Object.assign(existing, fields);
      else signalConfigs.push(fields);
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/rapid/tasks/T_ROB1" && url.searchParams.get("action") === "loadmod") {
    counters.rapidLoadModule += 1;
    const form = new URLSearchParams(await readBody(req));
    const modulePath = form.get("modulepath");
    const source = uploads.get(modulePath);
    if (!source) {
      res.writeHead(400);
      return res.end("missing staged module");
    }
    const match = source.match(/^\s*MODULE\s+([A-Za-z0-9_]+)/im);
    if (!match) {
      res.writeHead(400);
      return res.end("invalid module source");
    }
    rapidModules.set(match[1], source);
    buildErrors = source.includes("BROKEN_BUILD")
      ? Array.from({ length: 31 }, (_, index) => ({ module: match[1], row: index + 1, error: "mock syntax error" }))
      : [];
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/rapid/tasks/T_ROB1" && url.searchParams.get("action") === "unloadmod") {
    counters.rapidUnloadModule += 1;
    const form = new URLSearchParams(await readBody(req));
    rapidModules.delete(form.get("module"));
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/rw/rapid/tasks/T_ROB1" && url.searchParams.get("action") === "build") {
    counters.rapidBuild += 1;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/rw/rapid/tasks/T_ROB1/program/builderror") {
    res.writeHead(200, { "content-type": "application/xhtml+xml" });
    const start = Number(url.searchParams.get("start") || "1");
    const limit = Number(url.searchParams.get("limit") || "30");
    const page = buildErrors.slice(start - 1, start - 1 + limit);
    const next = start - 1 + page.length < buildErrors.length ? `<a href="?start=${start + page.length}&limit=${limit}" rel="next"></a>` : "";
    const items = page
      .map(
        (item) =>
          `<li class="rap-builderrs" title="builderrs"><span class="ModuleName">${item.module}</span><span class="row">${item.row}</span><span class="column">1</span><span class="error">${item.error}</span></li>`
      )
      .join("");
    return res.end(`<html><body>${next}<ul>${items}</ul></body></html>`);
  }
  if (req.method === "POST" && url.pathname === "/rw/panel" && url.searchParams.get("action") === "restart") {
    counters.restart += 1;
    if (restartStatus !== 204) {
      res.writeHead(restartStatus);
      return res.end("mock restart rejected");
    }
    restartOfflineChecks = restartOfflineChecksPerRequest;
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end(`mock route not found: ${req.method} ${url.pathname}${url.search}`);
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;
const registryPath = path.join(temp, "controller-registry.json");
await writeFile(
  registryPath,
  JSON.stringify(
    {
      version: 1,
      rwsHelperPath: path.join(root, "legacy", "abb_rws_session.ps1"),
      allowedLocalRoots: [workspace, temp],
      allowedConfigDomains: ["eio", "sio", "sys", "proc"],
      controllers: {
        mock: {
          baseUrl: `http://127.0.0.1:${port}`,
          rwsProtocol: "rws1",
          expectedName: "MOCK-ABB",
          expectedSystemId: "11111111-2222-3333-4444-555555555555",
          expectedRobotWare: "6.13.0164",
          username: "mock-user",
          credentialFile,
          defaultTask: "T_DEFAULT",
          ioNetwork: "PROFINET",
          ioDevice: "PN_Internal_Device",
          requestTimeoutSeconds: 1,
          longRequestTimeoutSeconds: 5
        }
      }
    },
    null,
    2
  ),
  "utf8"
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server.mjs")],
  cwd: root,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    ABB_MCP_REGISTRY: registryPath,
    ABB_MCP_OFFLINE_COOLDOWN_MS: "500",
    ABB_MCP_DIAGNOSTICS: "1"
  },
  stderr: "pipe"
});
const client = new Client({ name: "abb-local-mock-integration", version: "1.0.0" }, { capabilities: {} });

function value(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text || "MCP tool failed");
  return result.structuredContent || JSON.parse(result.content?.[0]?.text || "null");
}

async function fixture(name) {
  const data = JSON.parse(await readFile(path.join(root, "test", "fixtures", name), "utf8"));
  for (const operation of data.operations || []) {
    if (operation.localPath) {
      operation.localPath = path.join(root, "test", "fixtures", path.win32.basename(operation.localPath));
    }
  }
  return data;
}

async function planFixture(name) {
  return value(
    await client.callTool({
      name: "abb_plan_changeset",
      arguments: { changeset: await fixture(name) }
    })
  );
}

async function verifyFixture(name) {
  return value(
    await client.callTool({
      name: "abb_verify_changeset",
      arguments: { changeset: await fixture(name) }
    })
  );
}

try {
  await client.connect(transport);
  const registryBeforeProbe = await readFile(registryPath, "utf8");
  const mcpProbe = value(
    await client.callTool({
      name: "abb_probe_controller",
      arguments: {
        baseUrl: `http://127.0.0.1:${port}`,
        credentialAlias: "mock",
        rwsProtocol: "rws1",
        requestTimeoutSeconds: 1
      }
    })
  );
  const registryAfterProbe = await readFile(registryPath, "utf8");
  if (
    mcpProbe.ControllerModified !== false ||
    mcpProbe.Identity?.Name !== "MOCK-ABB" ||
    mcpProbe.Identity?.SystemId !== "11111111-2222-3333-4444-555555555555" ||
    mcpProbe.Identity?.RobotWare !== "6.13.0164"
  ) {
    throw new Error(`MCP new-controller probe mismatch: ${JSON.stringify(mcpProbe)}`);
  }
  const bind = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const logoutBeforeRebind = counters.logout;
  const repeatBind = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const snapshot = value(await client.callTool({ name: "abb_controller_snapshot", arguments: { alias: "mock" } }));
  const signals = value(
    await client.callTool({
      name: "abb_read_signals",
      arguments: { alias: "mock", names: ["PF_DO30_TEST", "PF_DO31_TEST", "PF_DO33_TEST"] }
    })
  );
  const signalConfig = value(
    await client.callTool({
      name: "abb_list_config_instances",
      arguments: { alias: "mock", domain: "eio", type: "EIO_SIGNAL", filterAttribute: "Name", prefix: "PF_DO" }
    })
  );
  const sioConfig = value(
    await client.callTool({
      name: "abb_list_config_instances",
      arguments: { alias: "mock", domain: "sio", type: "IP_SETTING", filterAttribute: "Name", prefix: "PROFINET" }
    })
  );
  const sioInstance = value(
    await client.callTool({
      name: "abb_read_config_instance",
      arguments: { alias: "mock", domain: "sio", type: "IP_SETTING", instance: "PROFINET Network" }
    })
  );
  const defaultModules = value(
    await client.callTool({
      name: "abb_list_rapid_modules",
      arguments: { alias: "mock" }
    })
  );
  const defaultModuleText = value(
    await client.callTool({
      name: "abb_read_rapid_module",
      arguments: { alias: "mock", module: "MockModule" }
    })
  );
  const defaultRapidDataValue = value(
    await client.callTool({
      name: "abb_read_rapid_data",
      arguments: { alias: "mock", module: "MockModule", name: "Revision" }
    })
  );
  const rapidDataValue = value(
    await client.callTool({
      name: "abb_read_rapid_data",
      arguments: { alias: "mock", task: "T_ROB1", module: "MockModule", name: "Revision" }
    })
  );
  const currentRobtargetMutationCount =
    counters.post + counters.put + counters.delete;
  const currentRobtarget = value(
    await client.callTool({
      name: "abb_read_current_robtarget",
      arguments: {
        alias: "mock",
        tool: "tool0",
        wobj: "wobj0"
      }
    })
  );
  const explicitModules = value(
    await client.callTool({
      name: "abb_list_rapid_modules",
      arguments: { alias: "mock", task: "T_ROB1" }
    })
  );

  if (!bind.Bound || bind.Identity.Name !== "MOCK-ABB") throw new Error("mock bind failed");
  if (
    !repeatBind.ReusedSession ||
    !repeatBind.IdentityCacheHit ||
    repeatBind.RequestDelta !== 0 ||
    repeatBind.SessionCreateDelta !== 0 ||
    repeatBind.ReconnectDelta !== 0 ||
    repeatBind.BoundAt !== bind.BoundAt ||
    counters.logout !== logoutBeforeRebind
  ) {
    throw new Error(`repeat bind did not reuse the hot session: ${JSON.stringify(repeatBind)}`);
  }
  if (
    snapshot.Session.RequestDelta !== 5 ||
    snapshot.Session.ReconnectDelta !== 0 ||
    snapshot.IdentityCacheHit !== true ||
    snapshot.RapidModules.some((module) => module.Task !== "T_DEFAULT")
  ) {
    throw new Error(`snapshot budget mismatch: ${JSON.stringify(snapshot.Session)}`);
  }
  if (signals.RequestDelta !== 3 || signals.Signals.length !== 3) throw new Error("exact signal request budget mismatch");
  const missingSignals = await client.callTool({
    name: "abb_read_signals",
    arguments: { alias: "mock", names: ["PF_DO30_TEST", "MISSING_SIGNAL"] }
  });
  if (
    !missingSignals.isError ||
    !missingSignals.content?.[0]?.text?.includes(
      "I/O signals not found on PROFINET/PN_Internal_Device: MISSING_SIGNAL"
    )
  ) {
    throw new Error(`missing signal error changed: ${JSON.stringify(missingSignals)}`);
  }
  if (signalConfig.RequestDelta !== 1 || signalConfig.Count !== 3) throw new Error("bulk signal-config request budget mismatch");
  if (sioConfig.RequestDelta !== 1 || sioConfig.Count !== 1) throw new Error("generic SIO config read mismatch");
  if (sioInstance.RequestDelta !== 1 || sioInstance.Instance.Attributes.Address !== "192.0.2.100") {
    throw new Error("exact SIO config read mismatch");
  }
  if (
    defaultModules.RequestDelta !== 1 ||
    defaultModules.Task !== "T_DEFAULT" ||
    defaultModules.Modules.some((module) => module.Task !== "T_DEFAULT")
  ) {
    throw new Error(`registry-default module list mismatch: ${JSON.stringify(defaultModules)}`);
  }
  if (
    defaultModuleText.RequestDelta !== 1 ||
    defaultModuleText.Task !== "T_DEFAULT" ||
    !defaultModuleText.Text.includes("MODULE MockModule")
  ) {
    throw new Error(`registry-default module read mismatch: ${JSON.stringify(defaultModuleText)}`);
  }
  if (
    defaultRapidDataValue.RequestDelta !== 1 ||
    defaultRapidDataValue.Task !== "T_DEFAULT" ||
    defaultRapidDataValue.Value !== "2"
  ) {
    throw new Error(`registry-default RAPID data mismatch: ${JSON.stringify(defaultRapidDataValue)}`);
  }
  if (rapidDataValue.RequestDelta !== 1 || rapidDataValue.Value !== "1") {
    throw new Error("exact RAPID data read mismatch");
  }
  if (explicitModules.RequestDelta !== 1 || explicitModules.Task !== "T_ROB1") {
    throw new Error(`explicit RAPID task override mismatch: ${JSON.stringify(explicitModules)}`);
  }
  if (
    currentRobtarget.RequestDelta !== 1 ||
    currentRobtarget.Task !== "T_DEFAULT" ||
    currentRobtarget.ControllerModified !== false ||
    currentRobtarget.Value !==
      "[[101.25,-202.5,303.75],[0.5,0.5,0.5,0.5],[0,-1,2,0],[9E9,9E9,9E9,9E9,9E9,9E9]]" ||
    currentRobtarget.Trans.X !== 101.25 ||
    currentRobtarget.Extax.EaxF !== 9e9 ||
    counters.post + counters.put + counters.delete !==
      currentRobtargetMutationCount
  ) {
    throw new Error(`current robtarget read mismatch: ${JSON.stringify(currentRobtarget)}`);
  }

  const hotSamples = [];
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now();
    const hot = value(
      await client.callTool({
        name: "abb_read_config_instance",
        arguments: { alias: "mock", domain: "sio", type: "IP_SETTING", instance: "PROFINET Network" }
      })
    );
    hotSamples.push(performance.now() - start);
    if (hot.RequestDelta !== 1 || hot.ReconnectDelta !== 0) throw new Error("hot config read lost session reuse");
  }
  hotSamples.sort((a, b) => a - b);
  const hotConfigP95Ms = hotSamples[Math.ceil(hotSamples.length * 0.95) - 1];
  if (hotConfigP95Ms > 250) throw new Error(`hot config read p95 exceeded 250ms: ${hotConfigP95Ms}`);

  const singleFlightBefore = counters.sioInstanceRead;
  sioInstanceDelayMs = 150;
  const concurrentReads = await Promise.all(
    Array.from({ length: 20 }, () =>
      client.callTool({
        name: "abb_read_config_instance",
        arguments: { alias: "mock", domain: "sio", type: "IP_SETTING", instance: "PROFINET Network" }
      })
    )
  );
  for (const result of concurrentReads) {
    const read = value(result);
    if (read.Instance.Attributes.Address !== "192.0.2.100") {
      throw new Error("single-flight config read returned the wrong value");
    }
  }
  const singleFlightRwsGets = counters.sioInstanceRead - singleFlightBefore;
  if (singleFlightRwsGets !== 1) {
    throw new Error(
      `identical concurrent reads were not coalesced: ${singleFlightRwsGets}`
    );
  }

  const noopPrepare = await planFixture("mock-noop.json");
  if (noopPrepare.ChangesRequired !== 0 || noopPrepare.ControllerModified) throw new Error("no-op prepare mismatch");
  const noopCommit = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: noopPrepare.Token } }));
  if (!noopCommit.Applied || noopCommit.ChangedOperationCount !== 0) throw new Error("no-op commit mismatch");
  if (noopCommit.Metrics?.SessionCreateDelta !== 0 || !noopCommit.NoOp) {
    throw new Error(`no-op commit created a needless session: ${JSON.stringify(noopCommit.Metrics)}`);
  }
  if (counters.mastershipRequest !== 0 || counters.cfgSet !== 0 || counters.restart !== 0) {
    throw new Error("no-op commit made an external write");
  }

  const changePrepare = await planFixture("mock-change.json");
  if (changePrepare.ChangesRequired !== 1 || changePrepare.Operations[0].Before.Address !== "192.0.2.100") {
    throw new Error("change prepare did not capture exact old value");
  }
  const changeCommit = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: changePrepare.Token } }));
  if (!changeCommit.Applied || network.Address !== "192.0.2.101") throw new Error("mock cfg commit failed");
  if (counters.mastershipRequest !== 1 || counters.mastershipRelease !== 1 || counters.cfgSet !== 1 || counters.restart !== 1) {
    throw new Error(`write budget mismatch: ${JSON.stringify(counters)}`);
  }

  const verify = await verifyFixture("mock-change.json");
  if (!verify.Verified) throw new Error("mock independent verify failed");

  const cfgPrepare = await planFixture("mock-cfg-load.json");
  const cfgCommit = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: cfgPrepare.Token } }));
  if (!cfgCommit.Applied || counters.cfgValidate !== 1 || counters.cfgLoad !== 1) {
    throw new Error(`mock CFG batch load failed: ${JSON.stringify(counters)}`);
  }

  const rapidPrepare = await planFixture("mock-rapid-change.json");
  if (rapidPrepare.ChangesRequired !== 1) throw new Error("mock RAPID prepare did not detect change");
  const rapidCommit = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: rapidPrepare.Token } }));
  if (!rapidCommit.Applied || counters.rapidLoadModule !== 1 || counters.rapidBuild !== 1 || counters.rapidUnloadModule !== 0) {
    throw new Error(`mock RAPID replace failed: ${JSON.stringify(counters)}`);
  }

  const restartPrepare = await planFixture("mock-restart.json");
  restartOfflineChecksPerRequest = 0;
  const fastRestartStarted = performance.now();
  const applyProgress = [];
  const restartCommit = value(
    await client.callTool(
      { name: "abb_apply_changeset", arguments: { token: restartPrepare.Token } },
      undefined,
      { onprogress: (event) => applyProgress.push(event) }
    )
  );
  const fastRestartElapsedMs = performance.now() - fastRestartStarted;
  restartOfflineChecksPerRequest = 1;
  const fastRestartResult = restartCommit.Results.find((item) => item.Kind === "restart")?.Result;
  if (
    !restartCommit.Applied ||
    counters.restart !== 3 ||
    network.Address !== "192.0.2.102" ||
    fastRestartResult?.OfflineObserved !== false ||
    fastRestartResult?.ConsecutiveOnlineChecks < 2 ||
    fastRestartElapsedMs > 15_000 ||
    !applyProgress.some((event) => /preflight/i.test(event.message || "")) ||
    !applyProgress.some((event) => /restart_and_reconnect/i.test(event.message || "")) ||
    !applyProgress.some((event) => /independent_readback/i.test(event.message || ""))
  ) {
    throw new Error(`mock single-restart path failed: ${JSON.stringify(counters)}`);
  }

  const batchBefore = { ...counters };
  const inlineChangeset = {
    version: 1,
    controller: "mock",
    expectedController: {
      name: "MOCK-ABB",
      systemId: "11111111-2222-3333-4444-555555555555",
      robotWare: "6.13.0164"
    },
    safety: { requireRapidStopped: true, allowedControllerStates: ["guardstop", "motoroff"] },
    operations: [
      {
        kind: "cfg_set",
        domain: "sio",
        type: "IP_SETTING",
        instance: "PROFINET Network",
        fields: { Address: "192.0.2.110", Interface: "LAN3" }
      },
      { kind: "cfg_delete", domain: "eio", type: "EIO_SIGNAL", instanceKey: "PF_OLD", ifPresent: true },
      { kind: "rapid_module_delete", task: "T_ROB1", module: "OldModule", ifPresent: true }
    ],
    restart: { required: true, mode: "restart", timeoutSeconds: 120 }
  };
  const inlinePlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: inlineChangeset } })
  );
  if (inlinePlan.ChangesRequired !== 3 || inlinePlan.ControllerModified) throw new Error("inline changeset plan mismatch");
  const inlineApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: inlinePlan.Token } })
  );
  if (
    !inlineApply.Applied ||
    sioNetwork.Address !== "192.0.2.110" ||
    signalConfigs.some((item) => item.Name === "PF_OLD") ||
    rapidModules.has("OldModule")
  ) {
    throw new Error(`inline generic changeset failed: ${JSON.stringify(counters)}`);
  }
  if (
    counters.mastershipRequest - batchBefore.mastershipRequest !== 1 ||
    counters.mastershipRelease - batchBefore.mastershipRelease !== 1 ||
    counters.cfgSet - batchBefore.cfgSet !== 1 ||
    counters.cfgDelete - batchBefore.cfgDelete !== 1 ||
    counters.rapidUnloadModule - batchBefore.rapidUnloadModule !== 1 ||
    counters.rapidBuild - batchBefore.rapidBuild !== 1 ||
    counters.restart - batchBefore.restart !== 1
  ) {
    throw new Error(`inline changeset batching budget mismatch: ${JSON.stringify(counters)}`);
  }
  const upsertChangeset = {
    ...inlineChangeset,
    operations: [
      {
        kind: "cfg_upsert",
        domain: "eio",
        type: "EIO_SIGNAL",
        instance: "PF_NEW",
        fields: { Name: "PF_NEW", SignalType: "DO", Device: "PN_Internal_Device", DeviceMap: "88" }
      }
    ],
    restart: { required: true, mode: "restart", timeoutSeconds: 120 }
  };
  const upsertPlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: upsertChangeset } })
  );
  const upsertApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: upsertPlan.Token } })
  );
  const createdSignal = signalConfigs.find((item) => item.Name === "PF_NEW");
  if (!upsertApply.Applied || counters.cfgCreate !== 1 || createdSignal?.DeviceMap !== "88") {
    throw new Error(`cfg_upsert create/set failed: ${JSON.stringify(upsertApply)}`);
  }
  const upsertNoopPlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: upsertChangeset } })
  );
  if (upsertNoopPlan.ChangesRequired !== 0) throw new Error("cfg_upsert did not become a no-op after exact apply");
  const inlineVerify = value(
    await client.callTool({ name: "abb_verify_changeset", arguments: { changeset: inlineChangeset } })
  );
  if (!inlineVerify.Verified) throw new Error("inline changeset independent verification failed");
  const repeatedPlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: inlineChangeset } })
  );
  const repeatedRestartBefore = counters.restart;
  const repeatedUnloadBefore = counters.rapidUnloadModule;
  const repeatedApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: repeatedPlan.Token } })
  );
  if (
    repeatedPlan.ChangesRequired !== 0 ||
    !repeatedApply.NoOp ||
    repeatedApply.Metrics.SessionCreateDelta !== 0 ||
    counters.restart !== repeatedRestartBefore ||
    counters.rapidUnloadModule !== repeatedUnloadBefore
  ) {
    throw new Error(`repeated mixed changeset was not a true no-op: ${JSON.stringify(repeatedApply)}`);
  }

  const systemModuleDelete = {
    ...inlineChangeset,
    operations: [{ kind: "rapid_module_delete", task: "T_ROB1", module: "WorldZone", ifPresent: true }],
    restart: { required: false, mode: "restart", timeoutSeconds: 120 }
  };
  const systemDeleteResult = await client.callTool({
    name: "abb_plan_changeset",
    arguments: { changeset: systemModuleDelete }
  });
  if (!systemDeleteResult.isError || !systemDeleteResult.content?.[0]?.text?.includes("allowSystemModule=true")) {
    throw new Error("system module delete was not explicitly gated");
  }

  const immutablePath = path.join(temp, "ImmutableModule.mod");
  const immutableV1 = "MODULE ImmutableModule\n    PERS num Revision:=1;\nENDMODULE";
  await writeFile(immutablePath, immutableV1, "utf8");
  const immutableChangeset = {
    version: 1,
    controller: "mock",
    expectedController: {
      name: "MOCK-ABB",
      systemId: "11111111-2222-3333-4444-555555555555",
      robotWare: "6.13.0164"
    },
    safety: { requireRapidStopped: true, allowedControllerStates: ["guardstop", "motoroff"] },
    operations: [
      { kind: "rapid_module_put", task: "T_ROB1", module: "ImmutableModule", localPath: immutablePath }
    ],
    restart: { required: false, mode: "restart", timeoutSeconds: 120 }
  };
  const immutablePlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: immutableChangeset } })
  );
  await writeFile(immutablePath, "MODULE ImmutableModule\n    PERS num Revision:=2;\nENDMODULE", "utf8");
  const immutableApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: immutablePlan.Token } })
  );
  if (!immutableApply.Applied || rapidModules.get("ImmutableModule") !== immutableV1) {
    throw new Error("approved artifact bytes were not immutable across plan/apply");
  }

  const conflictingChangeset = {
    ...immutableChangeset,
    operations: [
      { kind: "cfg_set", domain: "eio", type: "INDUSTRIAL_NETWORK", instance: "PROFINET", fields: { Gateway: "1.1.1.1" } },
      { kind: "cfg_set", domain: "eio", type: "INDUSTRIAL_NETWORK", instance: "PROFINET", fields: { Gateway: "2.2.2.2" } }
    ],
    restart: { required: true, mode: "restart", timeoutSeconds: 120 }
  };
  const conflictResult = await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: conflictingChangeset } });
  if (!conflictResult.isError || !conflictResult.content?.[0]?.text?.includes("Duplicate cfg_set target")) {
    throw new Error("conflicting changeset was not rejected during plan");
  }

  const brokenPlan = await planFixture("mock-build-failure.json");
  const brokenApply = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: brokenPlan.Token } }));
  if (
    brokenApply.Applied ||
    !brokenApply.PartialApply ||
    !brokenApply.Failure?.includes("31 error(s)") ||
    !brokenApply.PostFailureReadback?.Build?.some((item) => item.ErrorCount === 31)
  ) {
    throw new Error(`build failure was not returned as structured partial apply: ${JSON.stringify(brokenApply)}`);
  }
  buildErrors = [];

  const cfgRacePlan = await planFixture("mock-cfg-http-failure.json");
  const racedSignal = signalConfigs.find((item) => item.Name === "PF_DO31_TEST");
  const racedSignalOriginalMap = racedSignal.DeviceMap;
  racedSignal.DeviceMap = "external-change";
  const cfgRaceLoadBefore = counters.cfgLoad;
  const cfgRaceApply = value(await client.callTool({ name: "abb_apply_changeset", arguments: { token: cfgRacePlan.Token } }));
  racedSignal.DeviceMap = racedSignalOriginalMap;
  if (
    cfgRaceApply.Applied ||
    cfgRaceApply.PartialApply ||
    !cfgRaceApply.Failure?.includes("CFG file precondition changed") ||
    counters.cfgLoad !== cfgRaceLoadBefore
  ) {
    throw new Error(`CFG inventory race was not stopped before load: ${JSON.stringify(cfgRaceApply)}`);
  }

  cfgLoadStatus = 500;
  const cfgFailurePlan = await planFixture("mock-cfg-http-failure.json");
  const cfgFailureApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: cfgFailurePlan.Token } })
  );
  cfgLoadStatus = 204;
  if (
    cfgFailureApply.Applied ||
    cfgFailureApply.PartialApply ||
    cfgFailureApply.ControllerWriteUnknown ||
    !cfgFailureApply.Failure?.includes("HTTP 500")
  ) {
    throw new Error(`explicit CFG HTTP failure was misclassified: ${JSON.stringify(cfgFailureApply)}`);
  }

  restartStatus = 400;
  const restartFailureChangeset = {
    ...immutableChangeset,
    operations: [
      {
        kind: "cfg_set",
        domain: "eio",
        type: "INDUSTRIAL_NETWORK",
        instance: "PROFINET",
        fields: { Gateway: "10.0.0.1" }
      }
    ],
    restart: { required: true, mode: "restart", timeoutSeconds: 120 }
  };
  const restartFailurePlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: restartFailureChangeset } })
  );
  const restartFailureApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: restartFailurePlan.Token } })
  );
  restartStatus = 204;
  if (
    restartFailureApply.Applied ||
    !restartFailureApply.PartialApply ||
    !restartFailureApply.Failure?.includes("HTTP 400")
  ) {
    throw new Error(`restart HTTP error was misclassified as success: ${JSON.stringify(restartFailureApply)}`);
  }

  const mastershipRaceChangeset = {
    ...restartFailureChangeset,
    operations: [
      {
        kind: "cfg_set",
        domain: "eio",
        type: "INDUSTRIAL_NETWORK",
        instance: "PROFINET",
        fields: { Gateway: "20.0.0.1" }
      }
    ]
  };
  const mastershipRacePlan = value(
    await client.callTool({ name: "abb_plan_changeset", arguments: { changeset: mastershipRaceChangeset } })
  );
  const cfgSetBeforeRace = counters.cfgSet;
  mutateNetworkOnMastership = true;
  const mastershipRaceApply = value(
    await client.callTool({ name: "abb_apply_changeset", arguments: { token: mastershipRacePlan.Token } })
  );
  if (
    mastershipRaceApply.Applied ||
    mastershipRaceApply.PartialApply ||
    !mastershipRaceApply.Failure?.includes("precondition changed") ||
    counters.cfgSet !== cfgSetBeforeRace
  ) {
    throw new Error(`mastership race was not stopped before first write: ${JSON.stringify(mastershipRaceApply)}`);
  }

  const transientBefore = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const transientHitsBefore = counters.signalRead;
  signalReadUnauthorizedRemaining = 1;
  const transient401 = value(
    await client.callTool({
      name: "abb_read_signals",
      arguments: { alias: "mock", names: ["PF_DO30_TEST", "PF_DO31_TEST"] }
    })
  );
  if (
    transient401.ReconnectDelta !== 1 ||
    counters.signalRead - transientHitsBefore !== 3 ||
    transient401.Metrics.SessionCreateCount !== transientBefore.Metrics.SessionCreateCount + 1
  ) {
    throw new Error(`expired-session reconnect budget mismatch: ${JSON.stringify(transient401)}`);
  }

  const sustainedBefore = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const sustainedHitsBefore = counters.signalRead;
  const sustainedLogoutBefore = counters.logout;
  signalReadUnauthorizedRemaining = 4;
  const sustained401 = await client.callTool({
    name: "abb_read_signals",
    arguments: { alias: "mock", names: ["PF_DO30_TEST", "PF_DO31_TEST"] }
  });
  if (!sustained401.isError || !sustained401.content?.[0]?.text?.includes("HTTP 401")) {
    throw new Error(`sustained 401 was not reported exactly: ${JSON.stringify(sustained401)}`);
  }
  const sustainedAfter = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  if (
    counters.signalRead - sustainedHitsBefore !== 4 ||
    sustainedAfter.Metrics.SessionCreateCount !== sustainedBefore.Metrics.SessionCreateCount + 1 ||
    sustainedAfter.Metrics.ReconnectCount !== sustainedBefore.Metrics.ReconnectCount + 1 ||
    counters.logout !== sustainedLogoutBefore
  ) {
    throw new Error("sustained 401 retried more than once or logged out an already stale session");
  }

  const httpBefore = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const httpHitsBefore = counters.signalRead;
  for (const status of [403, 500, 503]) {
    signalReadStatus = status;
    const explicitError = await client.callTool({
      name: "abb_read_signals",
      arguments: { alias: "mock", names: ["PF_DO30_TEST", "PF_DO31_TEST"] }
    });
    if (!explicitError.isError || !explicitError.content?.[0]?.text?.includes(`HTTP ${status}`)) {
      throw new Error(`explicit signal HTTP ${status} was not surfaced: ${JSON.stringify(explicitError)}`);
    }
  }
  const httpAfter = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  if (
    counters.signalRead - httpHitsBefore !== 6 ||
    httpAfter.Metrics.SessionCreateCount !== httpBefore.Metrics.SessionCreateCount ||
    httpAfter.Metrics.ReconnectCount !== httpBefore.Metrics.ReconnectCount
  ) {
    throw new Error("explicit HTTP 403/500/503 caused a meaningless reconnect");
  }

  const timeoutBefore = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  const timeoutHitsBefore = counters.signalRead;
  signalReadDelayMs = 1500;
  const timeoutStarted = performance.now();
  const timeoutResult = await client.callTool({
    name: "abb_read_signals",
    arguments: { alias: "mock", names: ["PF_DO30_TEST", "PF_DO31_TEST"] }
  });
  const timeoutElapsedMs = performance.now() - timeoutStarted;
  if (!timeoutResult.isError || !/timed out|timeout/i.test(timeoutResult.content?.[0]?.text || "")) {
    throw new Error(`signal timeout was not surfaced: ${JSON.stringify(timeoutResult)}`);
  }
  const timeoutCircuitStarted = performance.now();
  const timeoutCircuitResult = await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } });
  const timeoutCircuitElapsedMs = performance.now() - timeoutCircuitStarted;
  if (
    !timeoutCircuitResult.isError ||
    !timeoutCircuitResult.content?.[0]?.text?.includes("ControllerUnavailableCached") ||
    timeoutCircuitElapsedMs > 250
  ) {
    throw new Error(
      `offline circuit did not fail fast: ${JSON.stringify({ timeoutCircuitElapsedMs, timeoutCircuitResult })}`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 550));
  const timeoutAfter = value(await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock" } }));
  if (
    timeoutElapsedMs > 2000 ||
    counters.signalRead - timeoutHitsBefore !== 2 ||
    timeoutAfter.Metrics.SessionCreateCount !== timeoutBefore.Metrics.SessionCreateCount ||
    timeoutAfter.Metrics.ReconnectCount !== timeoutBefore.Metrics.ReconnectCount ||
    timeoutAfter.Metrics.TimeoutCount !== timeoutBefore.Metrics.TimeoutCount + 1 ||
    timeoutAfter.Metrics.TransportFailureCount !== timeoutBefore.Metrics.TransportFailureCount + 1 ||
    timeoutAfter.Metrics.CircuitFastFailCount !== timeoutBefore.Metrics.CircuitFastFailCount + 1
  ) {
    throw new Error(`timeout path was slow or reconnected: ${JSON.stringify({ timeoutElapsedMs, timeoutBefore, timeoutAfter })}`);
  }

  const registration = value(
    await client.callTool({
      name: "abb_register_controller",
      arguments: {
        alias: "mock_new",
        baseUrl: `http://127.0.0.1:${port}`,
        rwsProtocol: "rws1",
        expectedName: "MOCK-ABB",
        expectedSystemId: "11111111-2222-3333-4444-555555555555",
        expectedRobotWare: "6.13.0164",
        credentialAlias: "mock",
        defaultTask: "T_ROB1",
        ioNetwork: "PROFINET",
        ioDevice: "PN_Internal_Device",
        requestTimeoutSeconds: 1,
        longRequestTimeoutSeconds: 5
      }
    })
  );
  if (registration.ControllerModified !== false) {
    throw new Error(`local controller registration claimed a controller write: ${JSON.stringify(registration)}`);
  }
  const reloadedControllers = value(await client.callTool({ name: "abb_list_controllers", arguments: {} }));
  if (!reloadedControllers.Controllers.some((item) => item.Alias === "mock_new")) {
    throw new Error("MCP registration did not expose a newly registered controller without restart");
  }
  const newControllerBind = value(
    await client.callTool({ name: "abb_bind_controller", arguments: { alias: "mock_new" } })
  );
  if (!newControllerBind.Bound || newControllerBind.Identity.Name !== "MOCK-ABB") {
    throw new Error("new controller alias could not bind without restarting MCP");
  }

  if (counters.logout < 1) throw new Error("worker did not explicitly call /logout while rotating sessions");

  console.log(
    JSON.stringify(
      {
        ok: true,
        snapshotRequestDelta: snapshot.Session.RequestDelta,
        signalRequestDelta: signals.RequestDelta,
        repeatBindRequestDelta: repeatBind.RequestDelta,
        repeatBindSessionCreateDelta: repeatBind.SessionCreateDelta,
        hotConfigP95Ms: Math.round(hotConfigP95Ms * 10) / 10,
        identicalConcurrentReads: concurrentReads.length,
        identicalConcurrentRwsGets: singleFlightRwsGets,
        fastRestartWithoutOfflineMs: Math.round(fastRestartElapsedMs * 10) / 10,
        applyProgressEvents: applyProgress.length,
        timeoutFailFastMs: Math.round(timeoutElapsedMs * 10) / 10,
        offlineCircuitFastFailMs: Math.round(timeoutCircuitElapsedMs * 10) / 10,
        transient401ReconnectDelta: transient401.ReconnectDelta,
        registeredWithoutMcpRestart: true,
        mcpProbeControllerModified: mcpProbe.ControllerModified,
        probeOnlyRegistryUnchanged: registryAfterProbe === registryBeforeProbe,
        signalConfigRequestDelta: signalConfig.RequestDelta,
        genericSioConfigRequestDelta: sioConfig.RequestDelta,
        exactSioConfigRequestDelta: sioInstance.RequestDelta,
        registryDefaultTask: defaultModules.Task,
        registryDefaultRapidData: defaultRapidDataValue.Value,
        explicitTaskOverride: explicitModules.Task,
        exactRapidDataRequestDelta: rapidDataValue.RequestDelta,
        currentRobtargetRequestDelta: currentRobtarget.RequestDelta,
        noOpChangedOperations: noopCommit.ChangedOperationCount,
        changedOperations: changeCommit.ChangedOperationCount,
        mastershipRequests: counters.mastershipRequest,
        mastershipReleases: counters.mastershipRelease,
        cfgSetRequests: counters.cfgSet,
        cfgCreateRequests: counters.cfgCreate,
        cfgDeleteRequests: counters.cfgDelete,
        cfgValidateRequests: counters.cfgValidate,
        cfgLoadRequests: counters.cfgLoad,
        stagedFileUploads: counters.fileUpload,
        stagingDirectoryDeletes: counters.stagingDelete,
        rapidLoadModuleRequests: counters.rapidLoadModule,
        rapidUnloadModuleRequests: counters.rapidUnloadModule,
        rapidBuildRequests: counters.rapidBuild,
        restartRequests: counters.restart,
        logoutRequests: counters.logout,
        finalAddress: network.Address,
        finalSioAddress: sioNetwork.Address,
        inlineChangedOperations: inlineApply.ChangedOperationCount,
        cfgUpsertApplied: upsertApply.Applied,
        noOpSessionCreateDelta: noopCommit.Metrics.SessionCreateDelta,
        immutableArtifactApplied: immutableApply.Applied,
        buildFailureCount: brokenApply.PostFailureReadback.Build.find((item) => item.ErrorCount === 31)?.ErrorCount,
        cfgHttpFailureUnknown: cfgFailureApply.ControllerWriteUnknown,
        restartHttpFailureApplied: restartFailureApply.Applied,
        repeatedChangesetNoOp: repeatedApply.NoOp,
        cfgInventoryRaceApplied: cfgRaceApply.Applied,
        mastershipRaceApplied: mastershipRaceApply.Applied,
        verification: verify.Verified,
        phaseTimingsMs: changeCommit.PhaseTimingsMs
      },
      null,
      2
    )
  );
} finally {
  await client.close();
  await new Promise((resolve) => mock.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
