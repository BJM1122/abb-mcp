import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DirectBackupManager } from "../direct-rws/backup-manager.mjs";
import { sha256File } from "../direct-rws/backup-artifact.mjs";
import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "abb-streaming-"));
const chunk = Buffer.alloc(64 * 1024, 0xa5);
const fileBytes = 64 * 1024 * 1024;
let mode = "complete";
let challenges = 0;
const server = http.createServer(async (request, response) => {
  response.on("error", () => {});
  if (!request.headers.authorization) {
    challenges += 1;
    response.writeHead(401, { "www-authenticate": 'Digest realm="mock", nonce="fixed", qop="auth"' });
    response.end("authentication required");
    return;
  }
  response.writeHead(200, { "content-type": "application/octet-stream" });
  if (mode !== "complete") {
    response.write(chunk);
    if (mode === "reset") setTimeout(() => response.destroy(), 20);
    else if (mode === "short" || mode === "oversize") response.end();
    return;
  }
  for (let sent = 0; sent < fileBytes; sent += chunk.length) {
    if (!response.write(chunk)) await once(response, "drain");
  }
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const client = new DigestHttpClient({ baseUrl,
  credentialProvider: async () => ({ username: "unused", password: "unused" }) });
const manager = new DirectBackupManager({
  async bindingRequest(_binding, options) {
    return await client.requestOk(options, "Mock download");
  }
});
const binding = { alias: "mock", config: { baseUrl, longRequestTimeoutSeconds: 5 } };
let peakExternal = process.memoryUsage().external;
const baseExternal = peakExternal;
const timer = setInterval(() => { peakExternal = Math.max(peakExternal, process.memoryUsage().external); }, 10);
try {
  const localPath = path.join(root, "complete");
  const records = await manager.downloadFiles(binding,
    { LocalPath: localPath, BackupName: "mock" },
    { Files: [{ RelativePath: "large.bin", Size: null }] }, Date.now() + 30_000);
  const expected = crypto.createHash("sha256");
  for (let sent = 0; sent < fileBytes; sent += chunk.length) expected.update(chunk);
  assert.equal(records[0].Size, fileBytes);
  assert.equal(records[0].Sha256, expected.digest("hex"));
  assert.equal(await sha256File(path.join(localPath, "large.bin")), records[0].Sha256);
  assert.equal((await stat(path.join(localPath, "large.bin"))).size, fileBytes);
  assert.deepEqual(await readdir(localPath), ["large.bin"]);
  assert.equal(challenges, 1);

  for (mode of ["reset", "short", "oversize", "timeout"]) {
    const failedPath = path.join(root, mode);
    const size = mode === "oversize" ? 1024 : chunk.length * 2;
    await assert.rejects(manager.downloadFiles(binding,
      { LocalPath: failedPath, BackupName: "mock" },
      { Files: [{ RelativePath: "bad.bin", Size: size }] },
      Date.now() + (mode === "timeout" ? 150 : 5_000)));
    assert.deepEqual(await readdir(failedPath), [], `${mode} left a partial or completed file`);
  }
  console.log(JSON.stringify({ ok: true, fileBytes, incrementalHashVerified: true,
    failedPartialFilesRemoved: true, externalMemoryGrowthBytes: peakExternal - baseExternal,
    liveControllerCalls: 0 }));
} finally {
  clearInterval(timer);
  manager.close();
  await client.close({ logout: false });
  await new Promise((resolve) => server.close(resolve));
  const resolvedRoot = path.resolve(root);
  assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith("abb-streaming-"));
  await rm(resolvedRoot, { recursive: true, force: true });
}
