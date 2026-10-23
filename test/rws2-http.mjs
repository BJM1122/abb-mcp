import assert from "node:assert/strict";
import crypto from "node:crypto";
import https from "node:https";
import net from "node:net";

import {
  BYTES_CONTENT_TYPE,
  DEFAULT_ACCEPT,
  FORM_CONTENT_TYPE,
  Rws2HttpClient
} from "../direct-rws/rws2-http-client.mjs";

function pem(label, base64) {
  const body = base64.replace(/\s+/g, "");
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
}

// Test-only localhost certificate. Production code never changes the trust store
// and validates controller certificates by default.
const CERTIFICATE = pem(
  "CERTIFICATE",
  `
MIIC5zCCAc+gAwIBAgIJAJ6m37VE+j/QMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMTCWxvY2FsaG9zdDAeFw0yNjA3MjgwMTU4NTlaFw0zNjA3MjkwMTU4NTlaMBQx
EjAQBgNVBAMTCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAN2O3jHn4Eo70V48YpIlHlvWXEaLFkCPaecTuwEhPn80iSzxs24lqsCrXpCx
RH9oP8iFVT7PtUG1AQERA/A+BAGHOwC1t0cVOVCqRbwb1OeCowCTRHBmQQTTa07i
oIZpv+iBhNpj8V7mBBKFpzErfoeKxLOOrNd1lxQRlty2WmiiJ3tNTv0lMk0T6FmC
Ic5VNpQIlE8+rLl/KEq2VSgwQZraDpNNPNkFlEgZojY0PtclcFGaI1N/udjDrqLf
VJ6mAlT8d+J4MSHg8ApAg+nUYlVfwBZOufFJtNO+o+2JLDNzvvWqC8UxovFHRg1N
HwNtP8JcALvQKQ+BHy04xAhNWqECAwEAAaM8MDowGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMA0GCSqGSIb3
DQEBCwUAA4IBAQAEEpjtUzr0kfw9R84Za/nhheoxxM+HnocdYPNBfAK/c9peodSx
I28iYB5/uqaYHN6Qjgk/3I1h8jI3JE63Ql14o1HQe3tctExMWDC2j9rJTFh3M50x
6icxQWGiTJmsTVwoZ30Z7MQ8jZvbostzf9yjS1+7ELogY2ORyUNihNa+cgVj+vxM
e+1OYiWJGF00z19E6fBtmPiZn3mYad9HFBvlP6mE16WiEsr4NkM5J52BSvLBQ3iB
mbIPG2XGXJO1feSwMYXMv1zjug1OTbBWsnTS7n9ppdGRajHfmIIPP0dV0ScGoxuT
9WixiPY34NNwaAwx/dEEIJtz2RzhoHaWWkvR
`
);

const PRIVATE_KEY = pem(
  "PRIVATE KEY",
  `
MIIEwAIBADANBgkqhkiG9w0BAQEFAASCBKowggSmAgEAAoIBAQDdjt4x5+BKO9Fe
PGKSJR5b1lxGixZAj2nnE7sBIT5/NIks8bNuJarAq16QsUR/aD/IhVU+z7VBtQEB
EQPwPgQBhzsAtbdHFTlQqkW8G9TngqMAk0RwZkEE02tO4qCGab/ogYTaY/Fe5gQS
hacxK36HisSzjqzXdZcUEZbctlpooid7TU79JTJNE+hZgiHOVTaUCJRPPqy5fyhK
tlUoMEGa2g6TTTzZBZRIGaI2ND7XJXBRmiNTf7nYw66i31SepgJU/HfieDEh4PAK
QIPp1GJVX8AWTrnxSbTTvqPtiSwzc771qgvFMaLxR0YNTR8DbT/CXAC70CkPgR8t
OMQITVqhAgMBAAECggEBAKpFJ+H2r9qdChSAF8j1GdW+cgAM2DcZgGwEL814fQ1J
lLqjrh/Sdt3HVc+hTGEV/x7dyVuSSVyL/I+TQhGZt35tLR0oigfo+blSgnFEemTJ
cvf4Nbqj+wf4axme9XsXPlMzZqRn9pHV9/88E/en03/bV7wexBp51nen5OcOhYCu
38PwOUwSdp0MK/k8KdLPVhax1HJI2//xUSsLl/fPzvtbAxsj9WURMVzdavSm4man
RY1tbNvI/NW3TtJtBlkGrmlRSvZW4d9tT6wppQcWoD8JqOM5VG/d5YrtQWFY7GAe
mIMy4+g2AU8FD3ywsIWhEyvi+m+xjDMBmQwW3P/Hg9kCgYEA8tZFtm2i0Ak3y06Q
0+m2aoH53dek+IUr0+2aN9KQMHAPmOgbd6curjBgujTHOPUT9dC8S1L/XR/asYcS
1BD+NCVwVQLSiCmQAKLERQEKDs7m0seaVH4S4aWoX5ibWMkWBFBxutFnE9ZiGYuD
pa7xvzPsCdW084TQ7w2gDz6CGJMCgYEA6ZFRkyanCZfYCsIDk50me5wYre1xhJWv
T/Mza0whuaAXc5LnRi4841ExznghWFF0TBLW5jJ3T8nA9swPjOoYmwrsG62iGdt1
z3JBENhnuTQFD1uQIyoSMO7c9kHJISV9RQpufkE2erUqkl4QcaSpFKI1a0/O4u7x
OiX160r5xHsCgYEAg3+21nf+P4uOVCDiWm7n4jsqNJCO/CkZN7Ul2u7COAim2ZVv
Mlcs9xSpfIwSCezk9ysmm9+A+0vBoHrVnlLpZRGVB+P0X9mp6j457GgIq0YtRpzi
HLj8voZ3a/T2wph5vLJXM+QrXlmsW8rp6jGXJYQXYKgCShB1F86YC0k9J9MCgYEA
o3G6mPOybicg2p5b7F9LP7LDHmsLRhGNJbB1af9TllcuMgU57EWM/DGkXex4wRn2
/Qkt8tab4Wy4qLuxohVq9IwXH2NJDTki3vEAES6uns6FP/L+EW1uX2m3nGf6vERE
vhyHp7gwzHucd+J1NWFZpIPCR/8IMousqNlJlsbXs6MCgYEAqK6x9UhFZkJNM3aj
TE372GLc0pTxt1JRrsWsssVq7cZvr+VUOuwxUd+lkuZtF3Ft2LSftrCuvfPq/yWF
VVt0hOO0TE1j1M8Dxv+dhwNBhaLfF5/Oa43ZwVUnhU7n6dkO9d93v4fgF55xjfob
uuAPDDS58xGtB6XHxYmR9VXh7ho=
`
);

const fixture = {
  paths: [],
  sockets: new Set(),
  errors: [],
  tlsClientErrors: 0,
  streamChunks: 0
};

const expectedAuthorization = `Basic ${Buffer.from("Default User:mock-password-only").toString(
  "base64"
)}`;

const server = https.createServer(
  { key: PRIVATE_KEY, cert: CERTIFICATE },
  (request, response) => {
    void handleRequest(request, response).catch((error) => {
      fixture.errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error.stack || error));
    });
  }
);
server.on("tlsClientError", () => {
  fixture.tlsClientErrors += 1;
});

async function handleRequest(request, response) {
  fixture.paths.push(request.url);
  fixture.sockets.add(request.socket);

  assert.equal(request.headers.authorization, expectedAuthorization);
  assert.equal(request.headers.accept, DEFAULT_ACCEPT);
  if (request.url !== "/session") {
    assert.match(request.headers.cookie || "", /(?:^|;\s*)http-session=abc123(?:;|$)/);
    assert.match(request.headers.cookie || "", /(?:^|;\s*)ABBCX=csrf456(?:;|$)/);
  }

  if (request.url === "/session") {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.cookie, undefined);
    response.writeHead(200, {
      "content-type": "application/hal+json;v=2.0",
      "set-cookie": [
        "http-session=abc123; Path=/; Secure; HttpOnly",
        "ABBCX=csrf456; Path=/; Secure"
      ]
    });
    response.end('{"_links":{}}');
    return;
  }

  if (request.url === "/binary") {
    assert.equal(request.method, "GET");
    assert.equal(request.headers["x-request-marker"], "preserved");
    response.writeHead(200, {
      "content-type": "application/octet-stream;v=2.0",
      "x-rws-test": "headers-preserved",
      location: "/progress/7"
    });
    response.end(Buffer.from([0x00, 0xff, 0x41, 0x42]));
    return;
  }

  if (request.url === "/form") {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], FORM_CONTENT_TYPE);
    const body = await readBody(request);
    assert.equal(body.toString("utf8"), "name=robot2&item=one&item=two");
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/upload") {
    assert.equal(request.method, "PUT");
    assert.equal(request.headers["content-type"], BYTES_CONTENT_TYPE);
    const body = await readBody(request);
    assert.deepEqual(body, Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]));
    response.writeHead(201, { location: "/files/42" });
    response.end();
    return;
  }

  if (request.url === "/never-ending") {
    assert.equal(request.method, "GET");
    response.writeHead(200, { "content-type": "application/octet-stream;v=2.0" });
    const timer = setInterval(() => {
      fixture.streamChunks += 1;
      response.write(Buffer.from([fixture.streamChunks & 0xff]));
    }, 10);
    timer.unref?.();
    const stop = () => clearInterval(timer);
    request.once("aborted", stop);
    request.once("close", stop);
    response.once("close", stop);
    return;
  }

  if (request.url === "/too-large") {
    response.writeHead(200, { "content-type": "application/octet-stream;v=2.0" });
    response.end(Buffer.alloc(10, 0x5a));
    return;
  }

  response.writeHead(404);
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listen(localServer) {
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localServer.address();
  return `https://localhost:${address.port}`;
}

assert.throws(
  () => new Rws2HttpClient({ baseUrl: "http://127.0.0.1", username: "u" }),
  /requires an https/
);

const baseUrl = await listen(server);
const certificateSha256 = crypto
  .createHash("sha256")
  .update(new crypto.X509Certificate(CERTIFICATE).raw)
  .digest("hex")
  .toUpperCase();
let credentialCalls = 0;
const strictClient = new Rws2HttpClient({
  baseUrl,
  username: "Default User",
  password: "mock-password-only",
  requestTimeoutMs: 500
});
assert.equal(strictClient.validateServerCertificate, true);

try {
  await assert.rejects(strictClient.request({ path: "/session" }));
} finally {
  await strictClient.close({ logout: false });
}

const wrongPinClient = new Rws2HttpClient({
  baseUrl,
  username: "Default User",
  password: "mock-password-only",
  certificateSha256: "0".repeat(64),
  requestTimeoutMs: 500
});
try {
  await assert.rejects(
    wrongPinClient.request({ path: "/must-not-reach-http" }),
    (error) => error.code === "RWS2_CERTIFICATE_PIN_MISMATCH"
  );
} finally {
  await wrongPinClient.close({ logout: false });
}

const pinnedClient = new Rws2HttpClient({
  baseUrl,
  username: "Default User",
  password: "mock-password-only",
  certificateSha256,
  requestTimeoutMs: 500
});
try {
  const pinned = await pinnedClient.request({ path: "/session" });
  assert.equal(pinned.statusCode, 200);
  assert.equal(pinnedClient.certificateSha256, certificateSha256);
} finally {
  await pinnedClient.close({ logout: false });
}

const tlsBlackholeSockets = new Set();
const tlsBlackholeServer = net.createServer((socket) => {
  tlsBlackholeSockets.add(socket);
  socket.once("close", () => tlsBlackholeSockets.delete(socket));
});
const tlsBlackholeBaseUrl = await listen(tlsBlackholeServer);
const tlsConnectTimeoutMs = 80;
let tlsConnectElapsedMs = 0;
const tlsBlackholeClient = new Rws2HttpClient({
  baseUrl: tlsBlackholeBaseUrl,
  username: "Default User",
  password: "mock-password-only",
  certificateSha256,
  requestTimeoutMs: 500,
  connectTimeoutMs: tlsConnectTimeoutMs
});
try {
  const started = performance.now();
  await assert.rejects(
    tlsBlackholeClient.request({ path: "/rw/system" }),
    (error) => {
      tlsConnectElapsedMs = Math.round(performance.now() - started);
      return (
        error.code === "ETIMEDOUT" &&
        error.phase === "connect" &&
        String(error.message).includes(
          `TLS connect timed out after ${tlsConnectTimeoutMs} ms`
        )
      );
    }
  );
} finally {
  await tlsBlackholeClient.close({ logout: false });
  for (const socket of tlsBlackholeSockets) socket.destroy();
  await new Promise((resolve) => tlsBlackholeServer.close(resolve));
}

const client = new Rws2HttpClient({
  baseUrl,
  credentialProvider: async () => {
    credentialCalls += 1;
    return { username: "Default User", password: "mock-password-only" };
  },
  ca: CERTIFICATE,
  requestTimeoutMs: 500,
  maxSockets: 1
});

const requestedDeadlineMs = 80;
let deadlineElapsedMs = 0;
try {
  const session = await client.request({ path: "/session" });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(JSON.parse(session.body), { _links: {} });

  const originalBufferToString = Buffer.prototype.toString;
  let binaryUtf8DecodeCount = 0;
  Buffer.prototype.toString = function patchedToString(encoding, ...args) {
    if (
      encoding === "utf8" &&
      this.length === 4 &&
      this[0] === 0x00 &&
      this[1] === 0xff &&
      this[2] === 0x41 &&
      this[3] === 0x42
    ) {
      binaryUtf8DecodeCount += 1;
    }
    return originalBufferToString.call(this, encoding, ...args);
  };
  let binary;
  try {
    binary = await client.request({
      path: "/binary",
      headers: { "X-Request-Marker": "preserved" }
    });
    assert.equal(binaryUtf8DecodeCount, 0);
    const decodedBinary = binary.body;
    assert.equal(binaryUtf8DecodeCount, 1);
    assert.equal(binary.body, decodedBinary);
    assert.equal(binaryUtf8DecodeCount, 1, "body decoding must be memoized");
  } finally {
    Buffer.prototype.toString = originalBufferToString;
  }
  assert.deepEqual(binary.bytes, Buffer.from([0x00, 0xff, 0x41, 0x42]));
  assert.equal(typeof Object.getOwnPropertyDescriptor(binary, "body")?.get, "function");
  assert.equal(binary.headers["x-rws-test"], "headers-preserved");
  assert.equal(binary.location, "/progress/7");

  const form = await client.request({
    method: "POST",
    path: "/form",
    form: { name: "robot2", item: ["one", "two"] }
  });
  assert.equal(form.statusCode, 204);

  const upload = await client.request({
    method: "PUT",
    path: "/upload",
    bytes: Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef])
  });
  assert.equal(upload.statusCode, 201);
  assert.equal(upload.location, "/files/42");

  const streamed = await client.request({
    path: "/binary",
    headers: { "X-Request-Marker": "preserved" },
    consumeResponse: async (chunks) => {
      const hash = crypto.createHash("sha256");
      for await (const chunk of chunks) hash.update(chunk);
      return hash.digest("hex");
    }
  });
  assert.equal(streamed.streamedBytes, 4);
  assert.equal(streamed.bytes.length, 0);
  assert.equal(streamed.streamResult, crypto.createHash("sha256").update(Buffer.from([0, 255, 65, 66])).digest("hex"));

  const deadlineStarted = performance.now();
  await assert.rejects(
    client.request({ path: "/never-ending", timeoutMs: requestedDeadlineMs,
      consumeResponse: async (chunks) => { for await (const chunk of chunks) assert.ok(chunk.length); } }),
    (error) => {
      deadlineElapsedMs = Math.round(performance.now() - deadlineStarted);
      return (
        error.code === "ETIMEDOUT" &&
        String(error.message).includes(`after ${requestedDeadlineMs} ms`)
      );
    }
  );

  await assert.rejects(
    client.request({ path: "https://example.invalid/rw" }),
    /refuses an unsafe request URL/
  );
  await assert.rejects(
    client.request({ path: `${baseUrl.replace("https://", "https://user:pass@")}/rw` }),
    /refuses an unsafe request URL/
  );
  await assert.rejects(
    client.request({ path: "/too-large", maxResponseBytes: 4,
      consumeResponse: async (chunks) => { for await (const chunk of chunks) assert.ok(chunk.length); } }),
    (error) => error.code === "RwsResponseTooLarge"
  );
} finally {
  await client.close({ logout: false });
  await new Promise((resolve) => server.close(resolve));
}

assert.deepEqual(fixture.errors, []);
assert.equal(credentialCalls, 1);
assert.deepEqual(fixture.paths, [
  "/session",
  "/session",
  "/binary",
  "/form",
  "/upload",
  "/binary",
  "/never-ending",
  "/too-large"
]);
// One pinned-session socket is independent from the CA-validated client. The
// absolute-deadline test then destroys that client's keep-alive socket, so its
// response-limit request must use exactly one fresh connection.
assert.equal(fixture.sockets.size, 3);
assert.ok(fixture.tlsClientErrors >= 1);
assert.ok(fixture.streamChunks >= 3);
assert.ok(deadlineElapsedMs >= 50, `deadline fired too early: ${deadlineElapsedMs} ms`);
assert.ok(deadlineElapsedMs <= 300, `deadline fired too late: ${deadlineElapsedMs} ms`);
assert.ok(
  tlsConnectElapsedMs >= 50,
  `TLS connect timeout fired implausibly early: ${tlsConnectElapsedMs} ms`
);
assert.ok(
  tlsConnectElapsedMs <= 300,
  `TLS connect timeout was not bounded: ${tlsConnectElapsedMs} ms`
);

console.log(
  JSON.stringify(
    {
      result: "PASS",
      strictCertificateValidation: true,
      exactCertificatePinValidation: true,
      protocol: "HTTPS Basic + Cookie + application/*;v=2.0",
      requests: fixture.paths.length,
      tlsSockets: fixture.sockets.size,
      credentialProviderCalls: credentialCalls,
      requestedDeadlineMs,
      deadlineElapsedMs,
      tlsConnectTimeoutMs,
      tlsConnectElapsedMs,
      streamedChunksBeforeDeadline: fixture.streamChunks
    },
    null,
    2
  )
);
