import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { attachLazyUtf8Body } from "./lazy-response-body.mjs";
import { remainingReadTime } from "./read-deadline.mjs";

const DEFAULT_RWS_MAX_SOCKETS = 4;

function hashName(algorithm) {
  const normalized = String(algorithm || "MD5")
    .replace(/-sess$/i, "")
    .toUpperCase();
  if (normalized === "MD5") return "md5";
  if (normalized === "SHA-256") return "sha256";
  if (normalized === "SHA-512-256") return "sha512-256";
  throw new Error(`Unsupported ABB Digest algorithm: ${algorithm}`);
}

function digestHex(algorithm, value) {
  return crypto.createHash(hashName(algorithm)).update(value, "utf8").digest("hex");
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseDigestChallenge(header) {
  const text = Array.isArray(header) ? header.join(", ") : String(header || "");
  const digestIndex = text.search(/(?:^|,\s*)Digest\s+/i);
  if (digestIndex < 0) return null;
  const digestText = text
    .slice(digestIndex)
    .replace(/^(?:,\s*)?Digest\s+/i, "");
  const values = {};
  const matcher = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  for (const match of digestText.matchAll(matcher)) {
    values[match[1].toLowerCase()] = match[2] !== undefined
      ? match[2].replace(/\\(.)/g, "$1")
      : match[3];
  }
  if (!values.realm || !values.nonce) return null;
  return values;
}

function selectQop(qop) {
  if (!qop) return "";
  const choices = String(qop)
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (choices.includes("auth")) return "auth";
  throw new Error(
    `ABB Digest challenge does not offer supported qop=auth: ${choices.join(",")}`
  );
}

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

export class RwsHttpError extends Error {
  constructor(message, { statusCode = 0, method = "", url = "", body = "" } = {}) {
    super(message);
    this.name = "RwsHttpError";
    this.statusCode = statusCode;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

export class DigestHttpClient {
  constructor({
    baseUrl,
    credentialProvider,
    requestTimeoutMs = 5_000,
    maxSockets = DEFAULT_RWS_MAX_SOCKETS,
    validateServerCertificate = true
  }) {
    if (!Number.isSafeInteger(maxSockets) || maxSockets < 1) {
      throw new Error("ABB RWS maxSockets must be a positive safe integer.");
    }
    this.baseUrl = new URL(baseUrl);
    this.credentialProvider = credentialProvider;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxSockets = maxSockets;
    this.credentials = null;
    this.credentialsPromise = null;
    this.challenge = null;
    this.challengeGeneration = 0;
    this.nonceCount = 0;
    this.cookies = new Map();
    this.closed = false;
    const common = {
      keepAlive: true,
      maxSockets: this.maxSockets,
      maxFreeSockets: this.maxSockets,
      timeout: 30_000
    };
    this.agent = this.baseUrl.protocol === "https:"
      ? new https.Agent({ ...common, rejectUnauthorized: validateServerCertificate })
      : new http.Agent(common);
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
      const pending = Promise.resolve()
        .then(() => this.credentialProvider())
        .then((credentials) => {
          this.credentials = credentials;
          return credentials;
        });
      this.credentialsPromise = pending;
      pending.finally(() => {
        if (this.credentialsPromise === pending) this.credentialsPromise = null;
      }).catch(() => {});
    }
    return await this.credentialsPromise;
  }

  installChallenge(challenge) {
    this.challenge = challenge;
    this.nonceCount = 0;
    this.challengeGeneration += 1;
  }

  authorization(method, url) {
    if (!this.challenge || !this.credentials) return "";
    const algorithm = this.challenge.algorithm || "MD5";
    const qop = selectQop(this.challenge.qop);
    const cnonce = crypto.randomBytes(12).toString("hex");
    this.nonceCount += 1;
    const nc = this.nonceCount.toString(16).padStart(8, "0");
    const uri = `${url.pathname}${url.search}`;
    let ha1 = digestHex(
      algorithm,
      `${this.credentials.username}:${this.challenge.realm}:${this.credentials.password}`
    );
    if (/-sess$/i.test(algorithm)) {
      ha1 = digestHex(algorithm, `${ha1}:${this.challenge.nonce}:${cnonce}`);
    }
    const ha2 = digestHex(algorithm, `${method}:${uri}`);
    const response = qop
      ? digestHex(
          algorithm,
          `${ha1}:${this.challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`
        )
      : digestHex(algorithm, `${ha1}:${this.challenge.nonce}:${ha2}`);
    const fields = [
      `username=${quote(this.credentials.username)}`,
      `realm=${quote(this.challenge.realm)}`,
      `nonce=${quote(this.challenge.nonce)}`,
      `uri=${quote(uri)}`,
      `response=${quote(response)}`,
      `algorithm=${algorithm}`
    ];
    if (this.challenge.opaque) fields.push(`opaque=${quote(this.challenge.opaque)}`);
    if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
    return `Digest ${fields.join(", ")}`;
  }

  async rawRequest({
    method = "GET",
    path = "/",
    form,
    bytes,
    contentType = "application/x-www-form-urlencoded",
    timeoutMs = this.requestTimeoutMs,
    deadlineAt,
    consumeResponse,
    useAuthorization = true,
    maxResponseBytes = 128 * 1024 * 1024
  }) {
    if (this.closed) throw new Error("ABB direct RWS client is closed.");
    timeoutMs = Math.min(timeoutMs, remainingReadTime(deadlineAt) ?? timeoutMs);
    const url = new URL(path, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      url.username ||
      url.password
    ) {
      const error = new Error(
        `ABB RWS cross-origin request rejected: ${url.href}`
      );
      error.code = "RwsCrossOriginRejected";
      throw error;
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error("maxResponseBytes must be a positive safe integer.");
    }
    const body = form !== undefined
      ? encodeForm(form)
      : bytes === undefined
        ? null
        : Buffer.isBuffer(bytes)
          ? bytes
          : Buffer.from(bytes);
    const headers = {
      accept: "application/hal+json, application/json, application/xhtml+xml, */*",
      "user-agent": "Codex-AbbDirectRws/1.3",
      connection: "keep-alive"
    };
    if (body) {
      headers["content-type"] = contentType;
      headers["content-length"] = String(body.length);
    }
    const cookie = this.cookieHeader;
    if (cookie) headers.cookie = cookie;
    if (useAuthorization) {
      const authorization = this.authorization(method, url);
      if (authorization) headers.authorization = authorization;
    }

    const transport = url.protocol === "https:" ? https : http;
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
          `ABB RWS request timed out after ${timeoutMs} ms: ${method} ${url.href}`
        );
        error.code = "ETIMEDOUT";
        request?.destroy(error);
        finish(reject, error);
      }, timeoutMs);
      absoluteTimer.unref?.();
      request = transport.request(
        url,
        { method, headers, agent: this.agent },
        (response) => {
          incoming = response;
          if (consumeResponse && response.statusCode === 200) {
            let receivedBytes = 0;
            const limitedBody = async function* () {
              for await (const chunk of response) {
                receivedBytes += chunk.length;
                if (receivedBytes > maxResponseBytes) {
                  const error = new Error(`ABB RWS response exceeded ${maxResponseBytes} bytes: ${method} ${url.href}`);
                  error.code = "RwsResponseTooLarge";
                  throw error;
                }
                yield chunk;
              }
            };
            streamTask = Promise.resolve().then(() => consumeResponse(limitedBody()));
            streamTask.then((streamResult) => {
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
            }, (error) => {
              response.destroy(error);
              finish(reject, error);
            });
            return;
          }
          const chunks = [];
          let receivedBytes = 0;
          response.on("data", (chunk) => {
            receivedBytes += chunk.length;
            if (receivedBytes > maxResponseBytes) {
              const error = new Error(
                `ABB RWS response exceeded ${maxResponseBytes} bytes: ` +
                  `${method} ${url.href}`
              );
              error.code = "RwsResponseTooLarge";
              response.destroy(error);
              finish(reject, error);
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", (error) => finish(reject, error));
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
      request.setTimeout(timeoutMs, () => {
        const error = new Error(
          `ABB RWS request timed out after ${timeoutMs} ms: ${method} ${url.href}`
        );
        error.code = "ETIMEDOUT";
        request.destroy(error);
      });
      if (body) request.write(body);
      request.end();
    });
  }

  async request(options) {
    const normalized = {
      ...options,
      method: String(options.method || "GET").toUpperCase()
    };
    const firstGeneration = this.challengeGeneration;
    let response = await this.rawRequest(normalized);
    if (response.statusCode !== 401) return response;

    const challenge = parseDigestChallenge(response.headers["www-authenticate"]);
    if (!challenge) return response;
    await this.loadCredentials();
    if (this.challengeGeneration === firstGeneration) {
      this.installChallenge(challenge);
    }
    const secondGeneration = this.challengeGeneration;
    response = await this.rawRequest(normalized);
    if (response.statusCode === 401) {
      const refreshed = parseDigestChallenge(response.headers["www-authenticate"]);
      if (this.challengeGeneration !== secondGeneration) {
        response = await this.rawRequest(normalized);
      } else if (refreshed && refreshed.nonce !== this.challenge?.nonce) {
        this.installChallenge(refreshed);
        response = await this.rawRequest(normalized);
      }
    }
    return response;
  }

  async requestOk(options, operation, allowed = [200]) {
    const response = await this.request(options);
    if (!allowed.includes(response.statusCode)) {
      const detail = flatBody(response.body);
      throw new RwsHttpError(
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
    this.challenge = null;
    this.cookies.clear();
    this.agent.destroy();
  }
}

export {
  DEFAULT_RWS_MAX_SOCKETS,
  encodeForm,
  flatBody,
  parseDigestChallenge
};
