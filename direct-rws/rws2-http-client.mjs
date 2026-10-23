import https from "node:https";
import crypto from "node:crypto";
import tls from "node:tls";

import { attachLazyUtf8Body } from "./lazy-response-body.mjs";
import { remainingReadTime } from "./read-deadline.mjs";

const DEFAULT_ACCEPT =
  "application/hal+json;v=2.0, application/xhtml+xml;v=2.0";
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;v=2.0";
const TEXT_CONTENT_TYPE = "text/plain;v=2.0";
const BYTES_CONTENT_TYPE = "application/octet-stream;v=2.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

function encodeForm(form) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form || {})) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, String(item));
    } else {
      body.append(key, String(value));
    }
  }
  return Buffer.from(body.toString(), "utf8");
}

function flatBody(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    result[String(name).toLowerCase()] = value;
  }
  return result;
}

function positiveTimeout(value, fallback) {
  const timeout = Number(value ?? fallback);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`ABB RWS2 timeout must be a positive number: ${value}`);
  }
  return Math.min(timeout, 2_147_483_647);
}

function positiveByteLimit(value, fallback) {
  const limit = Number(value ?? fallback);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`ABB RWS2 response limit must be a positive integer: ${value}`);
  }
  return limit;
}

function normalizeCertificateSha256(value) {
  const normalized = String(value || "")
    .replaceAll(":", "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error(
      "ABB RWS2 certificateSha256 must be exactly 64 hexadecimal characters."
    );
  }
  return normalized;
}

class PinnedHttpsAgent extends https.Agent {
  constructor(options, certificateSha256, connectTimeoutMs) {
    super({ ...options, rejectUnauthorized: false });
    this.certificateSha256 = normalizeCertificateSha256(certificateSha256);
    this.connectTimeoutMs = positiveTimeout(
      connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.pendingSockets = new Set();
  }

  createConnection(options, callback) {
    let completed = false;
    let connectTimer;
    const finish = (error, socket) => {
      if (completed) return;
      completed = true;
      clearTimeout(connectTimer);
      this.pendingSockets.delete(socket);
      callback(error, socket);
    };
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    this.pendingSockets.add(socket);
    connectTimer = setTimeout(() => {
      const host = String(options.host || options.hostname || "controller");
      const port = Number(options.port || 443);
      const error = new Error(
        `ABB RWS2 TLS connect timed out after ${this.connectTimeoutMs} ms: ` +
          `${host}:${port}`
      );
      error.code = "ETIMEDOUT";
      error.phase = "connect";
      socket.destroy(error);
      finish(error, socket);
    }, this.connectTimeoutMs);
    connectTimer.unref?.();
    socket.once("secureConnect", () => {
      try {
        const certificate = socket.getPeerCertificate(true);
        if (!certificate?.raw?.length) {
          const error = new Error(
            "ABB RWS2 TLS peer did not provide a certificate for pin verification."
          );
          error.code = "RWS2_CERTIFICATE_PIN_MISSING";
          socket.destroy(error);
          finish(error, socket);
          return;
        }
        const actual = crypto
          .createHash("sha256")
          .update(certificate.raw)
          .digest("hex")
          .toUpperCase();
        if (actual !== this.certificateSha256) {
          const error = new Error(
            `ABB RWS2 certificate pin mismatch: actual=${actual}, ` +
              `expected=${this.certificateSha256}`
          );
          error.code = "RWS2_CERTIFICATE_PIN_MISMATCH";
          socket.destroy(error);
          finish(error, socket);
          return;
        }
        finish(null, socket);
      } catch (error) {
        socket.destroy(error);
        finish(error, socket);
      }
    });
    socket.once("error", (error) => finish(error, socket));
    // Returning undefined keeps the HTTP agent from using the socket before
    // secureConnect has verified the exact controller certificate fingerprint.
    return undefined;
  }

  destroy() {
    for (const socket of this.pendingSockets) socket.destroy();
    this.pendingSockets.clear();
    super.destroy();
  }
}

export class Rws2HttpError extends Error {
  constructor(message, { statusCode = 0, method = "", url = "", body = "" } = {}) {
    super(message);
    this.name = "Rws2HttpError";
    this.statusCode = statusCode;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

export class Rws2HttpClient {
  constructor({
    baseUrl,
    credentialProvider,
    username,
    password,
    requestTimeoutMs = 5_000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    maxSockets = 2,
    maxResponseBytes = 128 * 1024 * 1024,
    validateServerCertificate = true,
    certificateSha256,
    ca,
    servername
  }) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:") {
      throw new Error("ABB RWS2 requires an https:// baseUrl.");
    }
    if (!credentialProvider && username === undefined) {
      throw new Error("ABB RWS2 requires a credentialProvider or username/password.");
    }
    this.credentialProvider = credentialProvider || (async () => ({ username, password }));
    this.requestTimeoutMs = positiveTimeout(requestTimeoutMs, 5_000);
    this.connectTimeoutMs = positiveTimeout(
      connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.maxSockets = Number(maxSockets);
    this.maxResponseBytes = positiveByteLimit(
      maxResponseBytes,
      128 * 1024 * 1024
    );
    this.credentials = null;
    this.credentialsPromise = null;
    this.cookies = new Map();
    this.closed = false;
    this.validateServerCertificate = validateServerCertificate !== false;
    this.certificateSha256 = certificateSha256
      ? normalizeCertificateSha256(certificateSha256)
      : "";

    const agentOptions = {
      keepAlive: true,
      maxSockets,
      maxFreeSockets: maxSockets,
      timeout: 30_000,
      rejectUnauthorized: this.validateServerCertificate
    };
    if (ca !== undefined) agentOptions.ca = ca;
    if (servername !== undefined) agentOptions.servername = servername;
    this.agent = this.certificateSha256
      ? new PinnedHttpsAgent(
          agentOptions,
          this.certificateSha256,
          this.connectTimeoutMs
        )
      : new https.Agent(agentOptions);
  }

  get cookieHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  updateCookies(headers) {
    const setCookies = headers["set-cookie"] || [];
    for (const header of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      const pair = String(header).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  async loadCredentials() {
    if (this.credentials) return this.credentials;
    if (!this.credentialsPromise) {
      this.credentialsPromise = Promise.resolve().then(() => this.credentialProvider()).then((credentials) => {
        if (this.closed) throw new Error("ABB RWS2 client is closed.");
        if (!credentials || credentials.username === undefined) {
          throw new Error("ABB RWS2 credential provider returned no username.");
        }
        this.credentials = {
          username: String(credentials.username),
          password: String(credentials.password ?? "")
        };
        return this.credentials;
      });
    }
    const pending = this.credentialsPromise;
    try {
      return await pending;
    } finally {
      if (this.credentialsPromise === pending) this.credentialsPromise = null;
    }
  }

  async request({
    method = "GET",
    path = "/",
    form,
    text,
    bytes,
    headers: customHeaders,
    accept = DEFAULT_ACCEPT,
    contentType,
    timeoutMs = this.requestTimeoutMs,
    deadlineAt,
    consumeResponse,
    maxResponseBytes = this.maxResponseBytes,
    useAuthorization = true
  }) {
    if (this.closed) throw new Error("ABB RWS2 client is closed.");
    const normalizedMethod = String(method).toUpperCase();
    const url = new URL(path, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error(
        `ABB RWS2 refuses an unsafe request URL: ${url.href}`
      );
    }
    const responseLimit = positiveByteLimit(
      maxResponseBytes,
      this.maxResponseBytes
    );

    const bodySources = [
      form !== undefined,
      text !== undefined,
      bytes !== undefined
    ].filter(Boolean).length;
    if (bodySources > 1) {
      throw new Error("ABB RWS2 request accepts only one of form, text, or bytes.");
    }

    let body = null;
    let defaultContentType = "";
    if (form !== undefined) {
      body = encodeForm(form);
      defaultContentType = FORM_CONTENT_TYPE;
    } else if (text !== undefined) {
      body = Buffer.from(String(text), "utf8");
      defaultContentType = TEXT_CONTENT_TYPE;
    } else if (bytes !== undefined) {
      body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      defaultContentType = BYTES_CONTENT_TYPE;
    } else if (["POST", "PUT", "PATCH"].includes(normalizedMethod)) {
      body = Buffer.alloc(0);
      defaultContentType = FORM_CONTENT_TYPE;
    }

    const headers = normalizedHeaders(customHeaders);
    if (!headers.accept) headers.accept = accept;
    if (!headers["user-agent"]) headers["user-agent"] = "Codex-AbbDirectRws2/1.3";
    if (!headers.connection) headers.connection = "keep-alive";
    if (body !== null) {
      headers["content-type"] = contentType || defaultContentType;
      headers["content-length"] = String(body.length);
    }

    if (useAuthorization) {
      const credentials = await this.loadCredentials();
      headers.authorization = `Basic ${Buffer.from(
        `${credentials.username}:${credentials.password}`,
        "utf8"
      ).toString("base64")}`;
    } else {
      delete headers.authorization;
    }
    const cookie = this.cookieHeader;
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    const deadlineMs = Math.min(
      positiveTimeout(timeoutMs, this.requestTimeoutMs),
      remainingReadTime(deadlineAt) ?? Infinity
    );
    const started = performance.now();
    return await new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let incoming;
      let streamTask;
      const finish = (action, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(absoluteTimer);
        if (action === reject && streamTask) {
          incoming?.destroy(value);
          streamTask.catch(() => {}).then(() => action(value));
        } else {
          action(value);
        }
      };
      const absoluteTimer = setTimeout(() => {
        const error = new Error(
          `ABB RWS2 request timed out after ${deadlineMs} ms: ` +
            `${normalizedMethod} ${url.href}`
        );
        error.code = "ETIMEDOUT";
        request?.destroy(error);
        finish(reject, error);
      }, deadlineMs);
      absoluteTimer.unref?.();

      request = https.request(
        url,
        { method: normalizedMethod, headers, agent: this.agent },
        (response) => {
          incoming = response;
          if (consumeResponse && response.statusCode === 200) {
            let receivedBytes = 0;
            const limitedBody = async function* () {
              for await (const chunk of response) {
                receivedBytes += chunk.length;
                if (receivedBytes > responseLimit) {
                  const error = new Error(`ABB RWS2 response exceeded ${responseLimit} bytes: ${normalizedMethod} ${url.href}`);
                  error.code = "RwsResponseTooLarge";
                  throw error;
                }
                yield chunk;
              }
            };
            streamTask = Promise.resolve().then(() => consumeResponse(limitedBody()));
            streamTask.then((streamResult) => {
              if (!response.complete || !response.readableEnded) {
                throw new Error("ABB RWS2 response consumer returned before end of stream.");
              }
              this.updateCookies(response.headers);
              finish(resolve, {
                statusCode: response.statusCode,
                headers: response.headers,
                location: response.headers.location || "",
                bytes: Buffer.alloc(0),
                streamedBytes: receivedBytes,
                streamResult,
                elapsedMs: Math.round(performance.now() - started)
              });
            }).catch((error) => {
              response.destroy(error);
              finish(reject, error);
            });
            return;
          }
          const chunks = [];
          let receivedBytes = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (receivedBytes > responseLimit) {
              const error = new Error(
                `ABB RWS2 response exceeded ${responseLimit} bytes: ` +
                  `${normalizedMethod} ${url.href}`
              );
              error.code = "RwsResponseTooLarge";
              finish(reject, error);
              response.destroy(error);
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", (error) => finish(reject, error));
          response.on("aborted", () => {
            const error = new Error(
              `ABB RWS2 response aborted: ${normalizedMethod} ${url.href}`
            );
            error.code = "ECONNRESET";
            finish(reject, error);
          });
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            this.updateCookies(response.headers);
            const result = {
              statusCode: response.statusCode || 0,
              headers: response.headers,
              location: response.headers.location || "",
              bytes: buffer
            };
            attachLazyUtf8Body(result, buffer);
            result.elapsedMs = Math.round(performance.now() - started);
            finish(resolve, result);
          });
        }
      );
      request.on("error", (error) => finish(reject, error));
      request.setTimeout(deadlineMs, () => {
        const error = new Error(
          `ABB RWS2 request timed out after ${deadlineMs} ms: ` +
            `${normalizedMethod} ${url.href}`
        );
        error.code = "ETIMEDOUT";
        request.destroy(error);
      });
      if (body?.length) request.write(body);
      request.end();
    });
  }

  async requestOk(options, operation, allowed = [200]) {
    const response = await this.request(options);
    if (!allowed.includes(response.statusCode)) {
      const detail = flatBody(response.body);
      throw new Rws2HttpError(
        `${operation} failed HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}`,
        {
          statusCode: response.statusCode,
          method: options.method || "GET",
          url: new URL(options.path, this.baseUrl).href,
          body: response.body
        }
      );
    }
    return response;
  }

  async close({ logout = true } = {}) {
    if (this.closed) return;
    if (logout) {
      try {
        await this.request({ method: "GET", path: "/logout", timeoutMs: 1_000 });
      } catch {}
    }
    this.closed = true;
    this.credentials = null;
    this.cookies.clear();
    this.agent.destroy();
  }
}

export {
  BYTES_CONTENT_TYPE,
  DEFAULT_ACCEPT,
  FORM_CONTENT_TYPE,
  TEXT_CONTENT_TYPE,
  encodeForm
};
