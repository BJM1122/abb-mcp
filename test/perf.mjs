import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server.mjs")],
  cwd: root,
  stderr: "pipe"
});
const client = new Client({ name: "abb-local-perf", version: "1.0.0" }, { capabilities: {} });

function value(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text || "MCP call failed");
  return result.structuredContent || JSON.parse(result.content?.[0]?.text || "null");
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const connectStart = performance.now();
await client.connect(transport);
const connectMs = performance.now() - connectStart;
const samples = [];
const pids = new Set();
const readyStart = performance.now();
const startupRaceCalls = 8;
const readyHealth = await Promise.all(
  Array.from({ length: startupRaceCalls }, async () =>
    value(await client.callTool({ name: "abb_health", arguments: {} }))
  )
);
const workerReadyMs = performance.now() - readyStart;
for (const health of readyHealth) pids.add(health.pid);

try {
  for (let index = 0; index < 50; index += 1) {
    const start = performance.now();
    const health = value(await client.callTool({ name: "abb_health", arguments: {} }));
    samples.push(performance.now() - start);
    pids.add(health.pid);
  }
} finally {
  await client.close();
}

const workerPid = [...pids][0];
const deadline = Date.now() + 3000;
while (pidExists(workerPid) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const result = {
  ok: true,
  connectMs: Math.round(connectMs * 10) / 10,
  workerReadyMs: Math.round(workerReadyMs * 10) / 10,
  startupRaceCalls,
  calls: samples.length,
  workerPid,
  workerPidCount: pids.size,
  minMs: Math.round(Math.min(...samples) * 10) / 10,
  p50Ms: Math.round(percentile(samples, 50) * 10) / 10,
  p95Ms: Math.round(percentile(samples, 95) * 10) / 10,
  p99Ms: Math.round(percentile(samples, 99) * 10) / 10,
  maxMs: Math.round(Math.max(...samples) * 10) / 10,
  workerExited: !pidExists(workerPid)
};

if (connectMs > 3_000) throw new Error(`MCP connect blocked on worker startup: ${JSON.stringify(result)}`);
if (workerReadyMs > 8_000) throw new Error(`PowerShell worker cold startup exceeded 8s: ${JSON.stringify(result)}`);
if (pids.size !== 1) throw new Error(`health calls did not reuse one worker: ${JSON.stringify(result)}`);
if (result.p95Ms > 25 || result.p99Ms > 100) throw new Error(`hot-call latency budget exceeded: ${JSON.stringify(result)}`);
if (!result.workerExited) throw new Error(`worker did not exit within 3s: ${JSON.stringify(result)}`);

console.log(JSON.stringify(result, null, 2));
