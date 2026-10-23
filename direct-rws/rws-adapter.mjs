const RWS1 = "rws1";
const RWS2 = "rws2";
const RWS2_ACCEPT = "application/hal+json;v=2.0";
const SAFE_CONFIG_DOMAINS = new Set(["eio", "sio", "sys", "proc"]);

const PROTOCOL_ALIASES = new Map([
  ["1", RWS1],
  ["1.0", RWS1],
  ["rws1", RWS1],
  ["rws1.0", RWS1],
  ["2", RWS2],
  ["2.0", RWS2],
  ["rws2", RWS2],
  ["rws2.0", RWS2]
]);

export class RwsProtocolDetectionError extends Error {
  constructor(message, evidence = []) {
    super(message);
    this.name = "RwsProtocolDetectionError";
    this.code = "RWS_PROTOCOL_UNDETERMINED";
    this.evidence = evidence;
  }
}

export class UnsupportedRwsOperationError extends Error {
  constructor(protocol, operation, reason) {
    super(`Unsupported ${protocol} ${operation}: ${reason}`);
    this.name = "UnsupportedRwsOperationError";
    this.code = "RWS_UNSUPPORTED";
    this.protocol = protocol;
    this.operation = operation;
    this.reason = reason;
  }
}

export function normalizeRwsProtocol(value) {
  const normalized = PROTOCOL_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) {
    throw new RwsProtocolDetectionError(
      `RWS protocol must be explicit as rws1/1.0 or rws2/2.0; received: ${value}`
    );
  }
  return normalized;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? value.join(", ") : String(value || "");
    }
  }
  return "";
}

function protocolFromAuthentication(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "digest" || text === "digest-http") return RWS1;
  if (text === "basic" || text === "basic-https") return RWS2;
  return "";
}

/**
 * Resolve the protocol only from an explicit choice or protocol-level evidence.
 * RobotWare 7 alone is intentionally not evidence: it can expose deprecated
 * RWS 1.0 as well as RWS 2.0.
 */
export function detectRwsProtocol({
  explicit,
  headers,
  wwwAuthenticate,
  authentication,
  transport
} = {}) {
  const evidence = [];
  const add = (protocol, source) => {
    if (protocol) evidence.push({ protocol, source });
  };

  if (explicit !== undefined && explicit !== null && explicit !== "") {
    add(normalizeRwsProtocol(explicit), "explicit");
  }

  const challenge =
    String(wwwAuthenticate || "") || headerValue(headers, "www-authenticate");
  if (/^\s*digest(?:\s|$)/i.test(challenge)) add(RWS1, "www-authenticate:digest");
  if (/^\s*basic(?:\s|$)/i.test(challenge)) add(RWS2, "www-authenticate:basic");

  add(protocolFromAuthentication(authentication), "authentication");
  add(protocolFromAuthentication(transport), "transport");

  const contentType = headerValue(headers, "content-type");
  if (/;\s*v=2(?:\.|;|$)/i.test(contentType)) {
    add(RWS2, "content-type:v=2");
  }

  const protocols = new Set(evidence.map((item) => item.protocol));
  if (protocols.size === 0) {
    throw new RwsProtocolDetectionError(
      "RWS protocol is not detectable. Configure rws1/rws2 explicitly or provide an HTTP authentication challenge/content type.",
      evidence
    );
  }
  if (protocols.size > 1) {
    throw new RwsProtocolDetectionError(
      `Conflicting RWS protocol evidence: ${evidence
        .map((item) => `${item.source}=${item.protocol}`)
        .join(", ")}`,
      evidence
    );
  }
  return [...protocols][0];
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(String(value))) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return String(value);
}

function assertInstanceKey(value) {
  const text = String(value);
  if (
    text.length < 1 ||
    text.length > 160 ||
    text !== text.trim() ||
    /[\x00-\x1f\x7f/\\?#]/.test(text)
  ) {
    throw new Error(`Unsafe configuration instance key: ${value}`);
  }
  return text;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!SAFE_CONFIG_DOMAINS.has(domain)) {
    throw new Error(`Unsupported configuration domain: ${value}`);
  }
  return domain;
}

function integerOption(value, label, { minimum = 0, maximum = 20_000 } = {}) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}: ${value}`);
  }
  return number;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function appendQuery(path, entries) {
  const query = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) query.append(name, String(value));
  }
  const encoded = query.toString();
  if (!encoded) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${encoded}`;
}

function rws1Json(path) {
  return appendQuery(path, [["json", 1]]);
}

function requestDescriptor(protocol, path) {
  const request = { method: "GET", path };
  if (protocol === RWS2) request.accept = RWS2_ACCEPT;
  return request;
}

function responseBody(response) {
  if (
    response &&
    typeof response === "object" &&
    !Buffer.isBuffer(response) &&
    Object.hasOwn(response, "body")
  ) {
    return response.body;
  }
  return response;
}

function parseJsonDocument(response, operation) {
  const body = responseBody(response);
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${operation} returned invalid HAL JSON: ${error.message}`);
  }
}

function stateItems(document) {
  const value =
    document?._embedded?._state ??
    document?._embedded?.state ??
    document?._state ??
    document?.state ??
    document?._embedded?.resources;
  return Array.isArray(value) ? value : value ? [value] : [];
}

function firstState(document, operation) {
  const item = stateItems(document)[0];
  if (!item) throw new Error(`${operation} response contains no state resource.`);
  return item;
}

function fieldFromDocument(document, field, operation) {
  if (document && document[field] !== undefined) return String(document[field] ?? "");
  for (const item of stateItems(document)) {
    if (item?.[field] !== undefined) return String(item[field] ?? "");
  }
  throw new Error(`${operation} response is missing ${field}.`);
}

function normalizeSystemId(value) {
  return String(value || "").trim().replace(/^\{|\}$/g, "").toLowerCase();
}

function parseIdentity(response) {
  const document = parseJsonDocument(response, "Read ABB controller identity");
  const system = firstState(document, "Read ABB controller identity");
  return {
    Name: String(system.name ?? system["system-name"] ?? ""),
    SystemId: normalizeSystemId(system.sysid ?? system["system-id"] ?? ""),
    RobotWare: String(system.rwversion ?? system["rw-version"] ?? "")
  };
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 10))
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseModuleText(response, protocol) {
  const body = responseBody(response);
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  if (
    (body && typeof body === "object" && !Buffer.isBuffer(body)) ||
    /^\s*[\[{]/.test(text)
  ) {
    const document = parseJsonDocument(response, "Read RAPID module text");
    const item = [document, ...stateItems(document)].find(
      (candidate) =>
        candidate?.["module-text"] !== undefined ||
        candidate?._type === "rap-module-text"
    );
    if (item?.["module-text"] !== undefined) {
      return String(item["module-text"]);
    }
    if (protocol === RWS2) {
      throw new UnsupportedRwsOperationError(
        protocol,
        "moduleText",
        "the documented endpoint did not return inline module-text; RWS2 file-service handoff for large modules is not implemented"
      );
    }
    throw new Error("Read RAPID module text response contains no module text.");
  }

  const className = protocol === RWS2 ? "module-text" : "text";
  const match = text.match(
    new RegExp(`<span\\s+class=(?:"|')${className}(?:"|')>([\\s\\S]*?)<\\/span>`, "i")
  );
  if (match) return decodeHtml(match[1]);
  if (protocol === RWS2) {
    throw new UnsupportedRwsOperationError(
      protocol,
      "moduleText",
      "the documented endpoint did not return inline module-text; RWS2 file-service handoff for large modules is not implemented"
    );
  }
  throw new Error("Read RAPID module text response contains no module text.");
}

export function rws2ModuleTextFilePath(response) {
  const document = parseJsonDocument(response, "Read RAPID module text");
  const item = [document, ...stateItems(document)].find(
    (candidate) => candidate?.["file-path"] !== undefined
  );
  const filePath = String(item?.["file-path"] ?? "");
  if (!filePath) return "";
  if (!/^\/TEMP\/[A-Za-z0-9_.-]{1,160}$/.test(filePath)) {
    throw new Error(
      `RWS2 module-text handoff returned an unsafe temporary file path: ${filePath}`
    );
  }
  return filePath;
}

function parseModules(response, task) {
  const document = parseJsonDocument(response, "List RAPID modules");
  return stateItems(document).map((item) => ({
    Name: String(item?.name ?? ""),
    Type: String(item?.type ?? ""),
    Task: task
  }));
}

function parseRapidData(response) {
  const document = parseJsonDocument(response, "Read RAPID data");
  const items = stateItems(document);
  const item =
    items.find((candidate) => candidate?._type === "rap-data") ??
    (items.length === 1 && items[0]?.value !== undefined ? items[0] : undefined);
  if (!item) throw new Error("Read RAPID data response contains no rap-data resource.");
  return String(item.value ?? "");
}

function attributes(item) {
  const embedded = item?._embedded;
  const list =
    item?.attrib ??
    item?.attributes ??
    embedded?.attrib ??
    embedded?._state?.filter((candidate) => candidate?._type === "cfg-ia-t") ??
    [];
  const result = {};
  for (const attribute of Array.isArray(list) ? list : [list]) {
    const name = attribute?._title ?? attribute?.title ?? attribute?.name;
    if (name === undefined) continue;
    result[String(name)] = String(attribute?.value ?? "");
  }
  return result;
}

function configInstanceView(item, { domain, type, instance } = {}) {
  const key = String(item?._title ?? item?.title ?? "");
  const instanceId = String(item?.instanceid ?? item?.["instance-id"] ?? "");
  return {
    Domain: domain,
    Type: type,
    Instance: instance ?? key,
    Key: key,
    InstanceId: instanceId,
    DeleteKey: instanceId || key,
    ReadOnly: String(item?.rdonly ?? item?.["read-only"] ?? "").toLowerCase() === "true",
    Attributes: attributes(item)
  };
}

function ioSignalView(item, requestedName = "") {
  const title = String(item?._title ?? item?.title ?? "");
  const name = String(item?.name ?? "") || title.split("/").at(-1) || requestedName;
  const logicalState = String(item?.lstate ?? "");
  return {
    Name: requestedName || name,
    Value: String(item?.lvalue ?? ""),
    LogicalState: logicalState,
    PhysicalState: String(item?.phstate ?? ""),
    Quality: String(item?.quality ?? ""),
    Simulated: String(item?.simstate ?? "") || logicalState
  };
}

function nextHref(document) {
  const next = document?._links?.next;
  if (Array.isArray(next)) return String(next[0]?.href ?? next[0] ?? "");
  return String(next?.href ?? next ?? "");
}

// Controllers return the next link relative to the HAL base ("eio/instances?
// start=5&limit=5&json=1"), and RobotWare 6 even drops the type segment from
// it, so the href's path part cannot be trusted as a request path. Keep only
// its query (the pagination cursor) and rebuild it on the canonical list path.
function normalizedNextPath(document, basePath, protocol) {
  const href = nextHref(document);
  if (!href) return "";
  const queryIndex = href.indexOf("?");
  const query = new URLSearchParams(queryIndex >= 0 ? href.slice(queryIndex + 1) : "");
  if ([...query.keys()].length === 0) return "";
  if (protocol === RWS1) query.set("json", "1");
  return `${basePath}?${query.toString()}`;
}

function rws2Unsupported(operation, reason) {
  throw new UnsupportedRwsOperationError(RWS2, operation, reason);
}

export class RwsAdapter {
  constructor({ protocol, evidence } = {}) {
    this.protocol = evidence
      ? detectRwsProtocol({ ...evidence, explicit: protocol ?? evidence.explicit })
      : detectRwsProtocol({ explicit: protocol });
  }

  request(operation, params = {}) {
    switch (operation) {
      case "identity":
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1 ? "/rw/system?json=1" : "/rw/system"
        );

      case "opmode":
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1
            ? "/rw/panel/opmode?json=1"
            : "/rw/panel/opmode"
        );

      case "ctrlstate":
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1
            ? "/rw/panel/ctrlstate?json=1"
            : "/rw/panel/ctrl-state"
        );

      case "rapidState":
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1
            ? "/rw/rapid/execution?json=1"
            : "/rw/rapid/execution"
        );

      case "modules": {
        const task = assertIdentifier(params.task, "RAPID task");
        const path =
          this.protocol === RWS1
            ? rws1Json(
                appendQuery("/rw/rapid/modules", [
                  ["task", task]
                ])
              )
            : `/rw/rapid/tasks/${encodeSegment(task)}/modules`;
        return requestDescriptor(this.protocol, path);
      }

      case "moduleText": {
        const task = assertIdentifier(params.task, "RAPID task");
        const module = assertIdentifier(params.module, "RAPID module");
        const path =
          this.protocol === RWS1
            ? appendQuery(`/rw/rapid/modules/${encodeSegment(module)}`, [
                ["task", task],
                ["startrow", 1],
                ["startcol", 1],
                ["endrow", 10_000],
                ["endcol", -1]
              ])
            : `/rw/rapid/tasks/${encodeSegment(task)}/modules/${encodeSegment(
                module
              )}/text`;
        return requestDescriptor(this.protocol, path);
      }

      case "rapidData": {
        const task = assertIdentifier(params.task, "RAPID task");
        const module = assertIdentifier(params.module, "RAPID module");
        const name = assertIdentifier(params.name, "RAPID data name");
        const symbol = [task, module, name].map(encodeSegment).join("/");
        const path =
          this.protocol === RWS1
            ? `/rw/rapid/symbol/data/RAPID/${symbol}?json=1`
            : `/rw/rapid/symbol/RAPID/${symbol}/data`;
        return requestDescriptor(this.protocol, path);
      }

      case "signal": {
        const network = assertIdentifier(params.network, "I/O network");
        const device = assertIdentifier(params.device, "I/O device");
        const name = assertIdentifier(params.name, "I/O signal");
        const base = `/rw/iosystem/signals/${encodeSegment(network)}/${encodeSegment(
          device
        )}/${encodeSegment(name)}`;
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1 ? rws1Json(base) : base
        );
      }

      case "signals": {
        if (this.protocol === RWS2) {
          if (params.start !== undefined || params.limit !== undefined) {
            rws2Unsupported(
              operation,
              "numeric start/limit pagination is not declared for GET /rw/iosystem/signals in the RWS2 OpenAPI; follow the controller-provided next link instead"
            );
          }
          return requestDescriptor(this.protocol, "/rw/iosystem/signals");
        }
        const start = integerOption(params.start, "signal start");
        const limit = integerOption(params.limit, "signal limit", {
          minimum: 1,
          maximum: 5_000
        });
        return requestDescriptor(
          this.protocol,
          rws1Json(
            appendQuery("/rw/iosystem/signals", [
              ["start", start],
              ["limit", limit]
            ])
          )
        );
      }

      case "configInstances": {
        const domain = normalizeDomain(params.domain);
        const type = assertIdentifier(params.type, "configuration type");
        const base = `/rw/cfg/${domain}/${encodeSegment(type)}/instances`;
        if (this.protocol === RWS2) {
          if (params.start !== undefined || params.mark !== undefined) {
            rws2Unsupported(
              operation,
              "RWS2 v2.0 does not document a numeric page cursor; mark is documented only for v2.1"
            );
          }
          const limit = integerOption(params.limit, "configuration limit", {
            minimum: 1,
            maximum: 10
          });
          return requestDescriptor(
            this.protocol,
            appendQuery(base, [["limit", limit]])
          );
        }
        const start = integerOption(params.start, "configuration start");
        const limit = integerOption(params.limit, "configuration limit", {
          minimum: 1,
          maximum: 5_000
        });
        return requestDescriptor(
          this.protocol,
          rws1Json(
            appendQuery(base, [
              ["start", start],
              ["limit", limit]
            ])
          )
        );
      }

      case "configInstance": {
        const domain = normalizeDomain(params.domain);
        const type = assertIdentifier(params.type, "configuration type");
        const instance = assertInstanceKey(params.instance);
        const base =
          `/rw/cfg/${domain}/${encodeSegment(type)}/instances/` +
          encodeSegment(instance);
        return requestDescriptor(
          this.protocol,
          this.protocol === RWS1 ? rws1Json(base) : base
        );
      }

      default:
        throw new UnsupportedRwsOperationError(
          this.protocol,
          operation,
          "operation is not implemented by the protocol adapter"
        );
    }
  }

  parse(operation, response, params = {}) {
    switch (operation) {
      case "identity":
        return parseIdentity(response);
      case "opmode":
        return fieldFromDocument(
          parseJsonDocument(response, "Read operation mode"),
          "opmode",
          "Read operation mode"
        );
      case "ctrlstate":
        return fieldFromDocument(
          parseJsonDocument(response, "Read controller state"),
          "ctrlstate",
          "Read controller state"
        );
      case "rapidState":
        return fieldFromDocument(
          parseJsonDocument(response, "Read RAPID state"),
          "ctrlexecstate",
          "Read RAPID state"
        );
      case "modules":
        return parseModules(response, String(params.task));
      case "moduleText":
        return parseModuleText(response, this.protocol);
      case "rapidData":
        return parseRapidData(response);
      case "signal": {
        const document = parseJsonDocument(response, "Read I/O signal");
        return ioSignalView(
          firstState(document, "Read I/O signal"),
          String(params.name || "")
        );
      }
      case "signals": {
        const document = parseJsonDocument(response, "List I/O signals");
        return {
          Signals: stateItems(document).map((item) => ioSignalView(item)),
          Next: normalizedNextPath(document, "/rw/iosystem/signals", this.protocol)
        };
      }
      case "configInstances": {
        const document = parseJsonDocument(response, "List configuration instances");
        const context = {
          domain: normalizeDomain(params.domain),
          type: assertIdentifier(params.type, "configuration type")
        };
        return {
          Instances: stateItems(document).map((item) =>
            configInstanceView(item, context)
          ),
          Next: normalizedNextPath(
            document,
            `/rw/cfg/${context.domain}/${encodeSegment(context.type)}/instances`,
            this.protocol
          )
        };
      }
      case "configInstance": {
        const document = parseJsonDocument(response, "Read configuration instance");
        return configInstanceView(
          firstState(document, "Read configuration instance"),
          {
            domain: normalizeDomain(params.domain),
            type: assertIdentifier(params.type, "configuration type"),
            instance: String(params.instance)
          }
        );
      }
      default:
        throw new UnsupportedRwsOperationError(
          this.protocol,
          operation,
          "response parser is not implemented by the protocol adapter"
        );
    }
  }

  operation(operation, params = {}) {
    const captured = { ...params };
    return {
      protocol: this.protocol,
      operation,
      request: this.request(operation, captured),
      parse: (response) => this.parse(operation, response, captured)
    };
  }

  identity(params) {
    return this.operation("identity", params);
  }

  opmode(params) {
    return this.operation("opmode", params);
  }

  ctrlstate(params) {
    return this.operation("ctrlstate", params);
  }

  rapidState(params) {
    return this.operation("rapidState", params);
  }

  modules(params) {
    return this.operation("modules", params);
  }

  moduleText(params) {
    return this.operation("moduleText", params);
  }

  rapidData(params) {
    return this.operation("rapidData", params);
  }

  signal(params) {
    return this.operation("signal", params);
  }

  signals(params) {
    return this.operation("signals", params);
  }

  configInstances(params) {
    return this.operation("configInstances", params);
  }

  configInstance(params) {
    return this.operation("configInstance", params);
  }
}

export { RWS1, RWS2, RWS2_ACCEPT };
