import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { DigestHttpClient } from "../direct-rws/digest-http-client.mjs";

const USERNAME = "Default User";
const PASSWORD = "mock-password-only";
const REALM = "ABB-RWS";

function md5(value) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function parseDigestHeader(header) {
  const text = String(header || "");
  assert.match(text, /^Digest\s+/i, "request did not contain Digest authorization");
  const values = {};
  const matcher = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  for (const match of text.replace(/^Digest\s+/i, "").matchAll(matcher)) {
    values[match[1].toLowerCase()] = match[2] !== undefined
      ? match[2].replace(/\\(.)/g, "$1")
      : match[3];
  }
  return values;
}

function assertDigestAuthorization(request, nonce, expectedNonceCount) {
  const values = parseDigestHeader(request.headers.authorization);
  assert.equal(values.username, USERNAME);
  assert.equal(values.realm, REALM);
  assert.equal(values.nonce, nonce);
  assert.equal(values.uri, request.url);
  assert.equal(values.qop, "auth");
  assert.equal(values.nc, expectedNonceCount);
  assert.ok(values.cnonce, "Digest authorization omitted cnonce");

  const ha1 = md5(`${USERNAME}:${REALM}:${PASSWORD}`);
  const ha2 = md5(`${request.method}:${request.url}`);
  const expected = md5(
    `${ha1}:${nonce}:${values.nc}:${values.cnonce}:${values.qop}:${ha2}`
  );
  assert.equal(values.response, expected, "Digest response hash mismatch");
}

function challenge(nonce, extras = "") {
  return `Digest realm="${REALM}", nonce="${nonce}", algorithm=MD5, qop="auth"${extras}`;
}

async function listen(handler) {
  const errors = [];
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("test server assertion failed");
    });
  });
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    errors,
    baseUrl: `http://127.0.0.1:${address.port}/`
  };
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error?.message || error), pattern);
    return error;
  }
  assert.fail(`Expected rejection matching ${pattern}`);
}

async function testDigestCookieAndConnectionReuse() {
  const sockets = new Set();
  const requests = [];
  const nonce = "nonce-cookie";
  const fixture = await listen((request, response) => {
    sockets.add(request.socket);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization || "",
      cookie: request.headers.cookie || ""
    });

    if (!request.headers.authorization) {
      response.writeHead(401, {
        "www-authenticate": challenge(nonce),
        "set-cookie": "ABBCX=session-one; Path=/; HttpOnly"
      });
      response.end();
      return;
    }

    assert.match(request.headers.cookie || "", /(?:^|;\s*)ABBCX=session-one(?:;|$)/);
    const expectedNonceCount = request.url === "/identity" ? "00000001" : "00000002";
    assertDigestAuthorization(request, nonce, expectedNonceCount);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });

  let credentialCalls = 0;
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    maxSockets: 1,
    credentialProvider: async () => {
      credentialCalls += 1;
      return { username: USERNAME, password: PASSWORD };
    }
  });
  try {
    const identity = await client.requestOk(
      { method: "GET", path: "/identity" },
      "digest identity",
      [200]
    );
    const state = await client.requestOk(
      { method: "GET", path: "/state" },
      "digest state",
      [200]
    );
    assert.equal(
      typeof Object.getOwnPropertyDescriptor(identity, "body")?.get,
      "function",
      "successful Digest responses must expose a lazy body getter"
    );
    assert.deepEqual(JSON.parse(identity.body), { ok: true, url: "/identity" });
    assert.deepEqual(JSON.parse(state.body), { ok: true, url: "/state" });
    assert.equal(credentialCalls, 1, "credential provider was called more than once");
    assert.equal(requests.length, 3, "unexpected number of challenge/authenticated requests");
    assert.equal(requests[0].authorization, "");
    assert.equal(requests[0].cookie, "");
    assert.match(requests[1].cookie, /ABBCX=session-one/);
    assert.match(requests[2].cookie, /ABBCX=session-one/);
    assert.equal(
      sockets.size,
      1,
      `keep-alive connection was not reused; observed ${sockets.size} sockets`
    );
    assert.deepEqual(fixture.errors, []);
    return { requests: requests.length, sockets: sockets.size };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testAuthIntOnlyRejected() {
  let requestCount = 0;
  const fixture = await listen((_request, response) => {
    requestCount += 1;
    response.writeHead(401, {
      "www-authenticate":
        `Digest realm="${REALM}", nonce="nonce-auth-int", algorithm=MD5, qop="auth-int"`
    });
    response.end();
  });
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    credentialProvider: async () => ({ username: USERNAME, password: PASSWORD })
  });
  try {
    await expectReject(
      client.request({ method: "GET", path: "/auth-int-only" }),
      /does not offer supported qop=auth: auth-int/i
    );
    assert.equal(
      requestCount,
      1,
      "auth-int-only challenge should be rejected before a second network request"
    );
    assert.deepEqual(fixture.errors, []);
    return { requests: requestCount, explicitlyRejected: true };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testAbsoluteDeadline() {
  let chunksSent = 0;
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("0");
    chunksSent += 1;
    const interval = setInterval(() => {
      if (response.destroyed) return;
      response.write(".");
      chunksSent += 1;
    }, 10);
    response.on("close", () => clearInterval(interval));
  });
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    requestTimeoutMs: 80,
    credentialProvider: async () => ({ username: USERNAME, password: PASSWORD })
  });
  const started = performance.now();
  try {
    const error = await expectReject(
      client.request({ method: "GET", path: "/never-ending", timeoutMs: 80 }),
      /timed out after 80 ms/i
    );
    const elapsedMs = performance.now() - started;
    assert.equal(error.code, "ETIMEDOUT");
    assert.ok(chunksSent >= 3, `fixture did not keep the socket active: ${chunksSent} chunks`);
    assert.ok(elapsedMs >= 50, `absolute deadline fired implausibly early: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 350, `absolute deadline was not bounded: ${elapsedMs}ms`);
    assert.deepEqual(fixture.errors, []);
    return { timeoutMs: 80, elapsedMs: Math.round(elapsedMs), chunksSent };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testStaleNonceRefresh() {
  const oldNonce = "nonce-old";
  const freshNonce = "nonce-fresh";
  const seenNonces = [];
  let requestCount = 0;
  const fixture = await listen((request, response) => {
    requestCount += 1;
    if (!request.headers.authorization) {
      response.writeHead(401, {
        "www-authenticate": challenge(oldNonce),
        "set-cookie": "ABBCX=session-stale; Path=/; HttpOnly"
      });
      response.end();
      return;
    }

    assert.match(request.headers.cookie || "", /ABBCX=session-stale/);
    const values = parseDigestHeader(request.headers.authorization);
    seenNonces.push(values.nonce);
    if (values.nonce === oldNonce) {
      assertDigestAuthorization(request, oldNonce, "00000001");
      response.writeHead(401, {
        "www-authenticate": challenge(freshNonce, ", stale=true")
      });
      response.end();
      return;
    }

    assertDigestAuthorization(request, freshNonce, "00000001");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });

  let credentialCalls = 0;
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    maxSockets: 1,
    credentialProvider: async () => {
      credentialCalls += 1;
      return { username: USERNAME, password: PASSWORD };
    }
  });
  try {
    const result = await client.requestOk(
      { method: "GET", path: "/stale" },
      "stale nonce refresh",
      [200]
    );
    assert.deepEqual(JSON.parse(result.body), { ok: true });
    assert.deepEqual(seenNonces, [oldNonce, freshNonce]);
    assert.equal(requestCount, 3);
    assert.equal(credentialCalls, 1);
    assert.deepEqual(fixture.errors, []);
    return { requests: requestCount, nonces: seenNonces };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testConcurrentStaleNonceRefresh() {
  const oldNonce = "nonce-concurrent-old";
  const freshNonce = "nonce-concurrent-fresh";
  const oldNonceCounts = [];
  const freshNonceCounts = [];
  let activeOldNonceRequests = 0;
  let peakOldNonceRequests = 0;
  let releaseOldNonceRequests;
  const allOldNonceRequestsStarted = new Promise((resolve) => {
    releaseOldNonceRequests = resolve;
  });
  let requestCount = 0;
  const fixture = await listen(async (request, response) => {
    requestCount += 1;
    if (!request.headers.authorization) {
      response.writeHead(401, {
        "www-authenticate": challenge(oldNonce),
        "set-cookie": "ABBCX=session-concurrent; Path=/; HttpOnly"
      });
      response.end();
      return;
    }

    assert.match(request.headers.cookie || "", /ABBCX=session-concurrent/);
    const values = parseDigestHeader(request.headers.authorization);
    assertDigestAuthorization(request, values.nonce, values.nc);
    if (request.url === "/warm") {
      assert.equal(values.nonce, oldNonce);
      assert.equal(values.nc, "00000001");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }

    if (values.nonce === oldNonce) {
      oldNonceCounts.push(values.nc);
      activeOldNonceRequests += 1;
      peakOldNonceRequests = Math.max(
        peakOldNonceRequests,
        activeOldNonceRequests
      );
      if (activeOldNonceRequests === 4) releaseOldNonceRequests();
      await Promise.race([
        allOldNonceRequestsStarted,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("concurrent Digest requests did not overlap")),
            1_000
          )
        )
      ]);
      const index = Number(request.url.split("/").at(-1));
      const delays = [35, 5, 25, 15];
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      activeOldNonceRequests -= 1;
      response.writeHead(401, {
        "www-authenticate": challenge(freshNonce, ", stale=true")
      });
      response.end();
      return;
    }

    assert.equal(values.nonce, freshNonce);
    freshNonceCounts.push(values.nc);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });

  let credentialCalls = 0;
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    maxSockets: 4,
    credentialProvider: async () => {
      credentialCalls += 1;
      return { username: USERNAME, password: PASSWORD };
    }
  });
  try {
    await client.requestOk(
      { method: "GET", path: "/warm" },
      "warm concurrent stale nonce fixture",
      [200]
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        client.requestOk(
          { method: "GET", path: `/concurrent/${index}` },
          `concurrent stale nonce ${index}`,
          [200]
        )
      )
    );
    assert.deepEqual(
      results.map((result) => result.statusCode),
      [200, 200, 200, 200]
    );
    assert.deepEqual(
      [...oldNonceCounts].sort(),
      ["00000002", "00000003", "00000004", "00000005"]
    );
    assert.deepEqual(
      [...freshNonceCounts].sort(),
      ["00000001", "00000002", "00000003", "00000004"],
      "concurrent stale-nonce refresh reused a Digest nonce-count"
    );
    assert.equal(new Set(freshNonceCounts).size, 4);
    assert.equal(peakOldNonceRequests, 4, "Digest requests were not actually concurrent");
    assert.equal(credentialCalls, 1);
    assert.equal(requestCount, 10);
    assert.deepEqual(fixture.errors, []);
    return {
      requests: requestCount,
      peakOldNonceRequests,
      oldNonceCounts: [...oldNonceCounts].sort(),
      freshNonceCounts: [...freshNonceCounts].sort()
    };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testCrossOriginRejected() {
  const fixture = await listen((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    credentialProvider: async () => ({ username: USERNAME, password: PASSWORD })
  });
  try {
    const error = await expectReject(
      client.request({
        method: "GET",
        path: "http://127.0.0.1:1/must-not-send"
      }),
      /cross-origin request rejected/i
    );
    assert.equal(error.code, "RwsCrossOriginRejected");
    return { rejectedBeforeNetwork: true };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

async function testResponseLimit() {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(32, 1));
  });
  const client = new DigestHttpClient({
    baseUrl: fixture.baseUrl,
    credentialProvider: async () => ({ username: USERNAME, password: PASSWORD })
  });
  try {
    const error = await expectReject(
      client.request({
        method: "GET",
        path: "/bounded",
        maxResponseBytes: 16
      }),
      /response exceeded 16 bytes/i
    );
    assert.equal(error.code, "RwsResponseTooLarge");
    return { limitBytes: 16, rejected: true };
  } finally {
    await client.close({ logout: false });
    await closeServer(fixture.server);
  }
}

const digest = await testDigestCookieAndConnectionReuse();
const authInt = await testAuthIntOnlyRejected();
const deadline = await testAbsoluteDeadline();
const staleNonce = await testStaleNonceRefresh();
const concurrentStaleNonce = await testConcurrentStaleNonceRefresh();
const crossOrigin = await testCrossOriginRejected();
const responseLimit = await testResponseLimit();

console.log(
  JSON.stringify(
    {
      ok: true,
      digestCookieAndConnectionReuse: digest,
      authIntOnly: authInt,
      absoluteDeadline: deadline,
      staleNonce,
      concurrentStaleNonce,
      crossOrigin,
      responseLimit
    },
    null,
    2
  )
);
