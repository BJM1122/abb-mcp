import {
  UnsupportedRwsOperationError,
  normalizeRwsProtocol
} from "./rws-adapter.mjs";

const RWS1 = "rws1";
const RWS2 = "rws2";
const SAFE_CONFIG_DOMAINS = new Set(["eio", "sio", "sys", "proc"]);
const SAFE_CFG_FILE_ACTIONS = new Set(["add", "add-with-reset"]);
const FILE_ROOTS = new Map([
  ["$HOME", "HOME:"],
  ["$TEMP", "TEMP:"]
]);
const MAX_FILE_BYTES = 800_000_000;
const OFFICIAL_RWS1_REFERENCES = Object.freeze({
  mastershipRequest:
    "https://developercenter.robotstudio.com/api/rwsApi/msh_actions_page.html",
  mastershipRelease:
    "https://developercenter.robotstudio.com/api/rwsApi/msh_release_page.html",
  cfgSet:
    "https://developercenter.robotstudio.com/api/rwsApi/cfg_instance_action_set_page.html",
  cfgCreateDefault:
    "https://developercenter.robotstudio.com/api/rwsApi/cfg_instances_create_default_page.html",
  cfgDelete:
    "https://developercenter.robotstudio.com/api/rwsApi/cfg_instance_action_delete_page.html",
  cfgValidate:
    "https://developercenter.robotstudio.com/api/rwsApi/cfg_system_validate_page.html",
  cfgLoad:
    "https://developercenter.robotstudio.com/api/rwsApi/cfg_system_load_page.html",
  rapidSetInit:
    "https://developercenter.robotstudio.com/api/rwsApi/rapid_symbol_data_set_initval_page.html",
  rapidLoadModuleReplace:
    "https://developercenter.robotstudio.com/api/rwsApi/rapid_task_loadmod_page.html",
  rapidDeleteModule:
    "https://developercenter.robotstudio.com/api/rwsApi/rapid_task_unloadmod_page.html",
  rapidBuild:
    "https://developercenter.robotstudio.com/api/rwsApi/rapid_task_get_actions_page.html",
  rapidBuildErrors:
    "https://developercenter.robotstudio.com/api/rwsApi/rapid_builderror_get_page.html",
  ordinaryRestart:
    "https://developercenter.robotstudio.com/api/rwsApi/panel_restartcontroller_page.html",
  fileMkdir:
    "https://developercenter.robotstudio.com/api/rwsApi/fs_directory_create_page.html",
  fileUpload:
    "https://developercenter.robotstudio.com/api/rwsApi/fs_file_upload_page.html",
  fileDelete:
    "https://developercenter.robotstudio.com/api/rwsApi/fs_directory_delete_page.html"
});
const OFFICIAL_RWS2_REFERENCES = Object.freeze(
  Object.fromEntries(
    Object.keys(OFFICIAL_RWS1_REFERENCES).map((operation) => [
      operation,
      "https://developercenter.robotstudio.com/api/RWS"
    ])
  )
);

const SAFETY_EXCLUDED_OPERATIONS = new Set([
  "rapidStart",
  "rapidStop",
  "motorsOn",
  "motorsOff",
  "jog",
  "forceIo",
  "setIo",
  "motion",
  "motionCommand",
  "resetProgramPointer"
]);

export class Rws1WriteResponseError extends Error {
  constructor(message, { operation, statusCode = 0, body = "" } = {}) {
    super(message);
    this.name = "Rws1WriteResponseError";
    this.code = "RWS1_WRITE_HTTP";
    this.operation = operation;
    this.statusCode = statusCode;
    this.body = body;
  }
}

function unsupported(operation, reason, protocol = RWS1) {
  throw new UnsupportedRwsOperationError(protocol, operation, reason);
}

function assertIdentifier(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(text)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return text;
}

function assertInstanceKey(value, label = "configuration instance key") {
  const text = String(value ?? "");
  if (
    text.length < 1 ||
    text.length > 160 ||
    text !== text.trim() ||
    /[\x00-\x1f\x7f/\\?#]/.test(text)
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return text;
}

function normalizeDomain(value) {
  const domain = String(value ?? "").trim().toLowerCase();
  if (!SAFE_CONFIG_DOMAINS.has(domain)) {
    throw new Error(`Unsupported configuration domain: ${value}`);
  }
  return domain;
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("CFG fields must be a non-array object.");
  }
  const result = {};
  for (const [name, value] of Object.entries(fields)) {
    if (
      name.length < 1 ||
      name.length > 128 ||
      name !== name.trim() ||
      /[\x00-\x1f\x7f&=]/.test(name)
    ) {
      throw new Error(`Unsafe CFG attribute name: ${name}`);
    }
    if (
      value === undefined ||
      value === null ||
      typeof value === "object" ||
      typeof value === "symbol" ||
      typeof value === "function"
    ) {
      throw new Error(`CFG attribute ${name} must have a scalar value.`);
    }
    result[name] = String(value);
  }
  if (Object.keys(result).length === 0) {
    throw new Error("CFG set requires at least one attribute.");
  }
  return result;
}

function normalizeCfgAction(value, operation, protocol = RWS1) {
  const action = String(value ?? "").trim().toLowerCase();
  if (action === "replace") {
    unsupported(
      operation,
      "whole-domain CFG replace is intentionally excluded; use add or an explicitly planned add-with-reset changeset",
      protocol
    );
  }
  if (!SAFE_CFG_FILE_ACTIONS.has(action)) {
    throw new Error(`CFG action-type must be add or add-with-reset: ${value}`);
  }
  return action;
}

function normalizeControllerFilePath(value, label = "controller file path") {
  const text = String(value ?? "");
  if (
    !/^(?:HOME:\/|TEMP:\/|\$HOME\/|\$TEMP\/)[A-Za-z0-9_.() -]+(?:\/[A-Za-z0-9_.() -]+)*$/i.test(
      text
    ) ||
    text.includes("..") ||
    /[\x00-\x1f\x7f?#\\]/.test(text)
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return text;
}

function normalizeFileRoot(value) {
  const root = String(value ?? "$HOME").toUpperCase();
  if (!FILE_ROOTS.has(root)) {
    throw new Error(`FileService writes are restricted to $HOME or $TEMP: ${value}`);
  }
  return root;
}

function normalizeRelativePath(value, label) {
  const text = String(value ?? "").replaceAll("\\", "/");
  if (
    text.length < 1 ||
    text.length > 240 ||
    text.startsWith("/") ||
    text.endsWith("/") ||
    text.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9_.() -]{1,128}$/.test(part)
    )
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return text;
}

function fileServicePath(root, relativePath = "", trailingSlash = false) {
  const segments = relativePath
    ? relativePath.split("/").map((segment) => encodeURIComponent(segment))
    : [];
  let path = `/fileservice/${root}/`;
  if (segments.length) path += segments.join("/");
  if (trailingSlash && !path.endsWith("/")) path += "/";
  return path;
}

function controllerPath(root, relativePath) {
  return `${FILE_ROOTS.get(root)}/${relativePath}`;
}

function normalizeBytes(bytes) {
  if (
    bytes === undefined ||
    bytes === null ||
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
  ) {
    throw new Error("FileService upload requires Buffer or Uint8Array bytes.");
  }
  if (bytes.byteLength >= MAX_FILE_BYTES) {
    throw new Error(`RWS1 FileService upload must be smaller than ${MAX_FILE_BYTES} bytes.`);
  }
  return Buffer.from(bytes);
}

function normalizeContentType(value) {
  const text = String(value || "application/octet-stream").trim();
  if (
    text.length > 128 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9_.-]+=[A-Za-z0-9_.:+-]+)*$/.test(
      text
    )
  ) {
    throw new Error(`Unsafe upload content type: ${value}`);
  }
  return text;
}

function rws2ContentType(value) {
  const mediaType = String(value).split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/plain") return "text/plain;v=2.0";
  if (mediaType === "application/octet-stream") {
    return "application/octet-stream;v=2.0";
  }
  return `${mediaType};v=2.0`;
}

function responseBody(response) {
  const body = response?.body ?? "";
  return Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
}

function responseLocation(response) {
  const headers = response?.headers || {};
  if (typeof headers.get === "function") return String(headers.get("location") || "");
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "location") return String(value || "");
  }
  return String(response?.location || "");
}

function flatBody(body) {
  return String(body)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function acceptedResponse(response, descriptor) {
  const statusCode = Number(response?.statusCode ?? response?.status ?? 0);
  const body = responseBody(response);
  if (!descriptor.allowedStatusCodes.includes(statusCode)) {
    const detail = flatBody(body);
    throw new Rws1WriteResponseError(
      `${descriptor.operation} failed HTTP ${statusCode}${detail ? `: ${detail}` : ""}`,
      {
        operation: descriptor.operation,
        statusCode,
        body
      }
    );
  }
  return {
    Accepted: true,
    StatusCode: statusCode,
    OfficialStatusCode: descriptor.officialStatusCodes.includes(statusCode),
    CompatibilityStatusCode:
      !descriptor.officialStatusCodes.includes(statusCode),
    Location: responseLocation(response)
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

function span(body, className) {
  const match = String(body).match(
    new RegExp(
      `<span\\b[^>]*class=(?:"|')${className}(?:"|')[^>]*>([\\s\\S]*?)<\\/span>`,
      "i"
    )
  );
  return match ? decodeHtml(match[1]).trim() : "";
}

function nextLink(body) {
  for (const match of String(body).matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    const rel = attributes.match(/\brel=(?:"|')([^"']+)(?:"|')/i)?.[1] || "";
    if (rel.toLowerCase() !== "next") continue;
    return decodeHtml(
      attributes.match(/\bhref=(?:"|')([^"']+)(?:"|')/i)?.[1] || ""
    );
  }
  return "";
}

function jsonDocument(body) {
  const text = String(body || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function halStates(document) {
  const value =
    document?._embedded?._state ??
    document?._embedded?.state ??
    document?._state ??
    document?.state;
  return Array.isArray(value) ? value : value ? [value] : [];
}

function halNext(document) {
  const next = document?._links?.next;
  if (Array.isArray(next)) return String(next[0]?.href ?? next[0] ?? "");
  return String(next?.href ?? next ?? "");
}

function parseCreateDefault(response, descriptor) {
  const accepted = acceptedResponse(response, descriptor);
  const body = responseBody(response);
  const locationKey = decodeURIComponent(
    String(accepted.Location).replace(/\/+$/, "").split("/").at(-1) || ""
  );
  return {
    ...accepted,
    InstanceName: span(body, "instancename") || locationKey,
    InstanceId: span(body, "instanceid") || locationKey
  };
}

function parseCfgValidate(response, descriptor) {
  const accepted = acceptedResponse(response, descriptor);
  const body = responseBody(response);
  const document = jsonDocument(body);
  const item = document ? [document, ...halStates(document)][0] : null;
  return {
    ...accepted,
    Domain: span(body, "domain") || String(item?.domain ?? "")
  };
}

function parseBuildErrors(response, descriptor) {
  const accepted = acceptedResponse(response, descriptor);
  const body = responseBody(response);
  const document = jsonDocument(body);
  if (document) {
    const errors = halStates(document).map((item) => ({
      Module: String(item?.ModuleName ?? item?.module ?? item?.["module-name"] ?? ""),
      Row: Number(item?.row ?? 0),
      Column: Number(item?.column ?? 0),
      Error: String(item?.error ?? item?.message ?? "")
    }));
    return {
      ...accepted,
      Errors: errors,
      Count: errors.length,
      Next: halNext(document)
    };
  }
  const errors = [];
  for (const match of body.matchAll(
    /<li\b[^>]*class=(?:"|')[^"']*\brap-builderrs\b[^"']*(?:"|')[^>]*>([\s\S]*?)<\/li>/gi
  )) {
    const item = match[1];
    errors.push({
      Module: span(item, "ModuleName"),
      Row: Number(span(item, "row") || 0),
      Column: Number(span(item, "column") || 0),
      Error: span(item, "error")
    });
  }
  return {
    ...accepted,
    Errors: errors,
    Count: errors.length,
    Next: nextLink(body)
  };
}

function descriptor({
  protocol = RWS1,
  operation,
  request,
  allowedStatusCodes,
  officialStatusCodes,
  requiresMastership = false,
  mutating = true,
  timeoutClass = "normal",
  effect,
  parse = acceptedResponse,
  metadata = {}
}) {
  const result = {
    protocol,
    operation,
    request,
    allowedStatusCodes: [...allowedStatusCodes],
    officialStatusCodes: [...officialStatusCodes],
    requiresMastership,
    mutating,
    timeoutClass,
    reconnectPolicy: mutating ? "never-replay" : "safe-read",
    effect,
    officialReference:
      (protocol === RWS2 ? OFFICIAL_RWS2_REFERENCES : OFFICIAL_RWS1_REFERENCES)[operation],
    ...metadata
  };
  result.parse = (response) => parse(response, result);
  return result;
}

export class Rws1WriteAdapter {
  constructor({ protocol = RWS1 } = {}) {
    this.protocol = normalizeRwsProtocol(protocol);
  }

  descriptor(options) {
    return descriptor({ ...options, protocol: this.protocol });
  }

  operation(operation, params = {}) {
    if (SAFETY_EXCLUDED_OPERATIONS.has(operation)) {
      unsupported(
        operation,
        "robot execution, motors, jogging, forced I/O, program-pointer, and motion commands are not exposed",
        this.protocol
      );
    }

    switch (operation) {
      case "mastershipRequest":
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: this.protocol === RWS2
              ? "/rw/mastership/request"
              : "/rw/mastership?action=request",
            form: {}
          },
          allowedStatusCodes: [204],
          officialStatusCodes: [204],
          effect: "Request global CFG, Motion, and RAPID mastership; no motion command is issued."
        });

      case "mastershipRelease":
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: this.protocol === RWS2
              ? "/rw/mastership/release"
              : "/rw/mastership?action=release",
            form: {}
          },
          allowedStatusCodes: [204],
          officialStatusCodes: [204],
          effect: "Release all mastership held by this RWS session."
        });

      case "cfgSet": {
        const domain = normalizeDomain(params.domain);
        const type = assertIdentifier(params.type, "configuration type");
        const instance = assertInstanceKey(params.instance);
        const fields = normalizeFields(params.fields);
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path:
              `/rw/cfg/${domain}/${encodeURIComponent(type)}/instances/` +
              `${encodeURIComponent(instance)}` +
              (this.protocol === RWS2 ? "" : "?action=set"),
            form: fields
          },
          allowedStatusCodes: [204],
          officialStatusCodes: [204],
          requiresMastership: true,
          effect: `Set fields on existing CFG instance ${domain}/${type}/${instance}.`
        });
      }

      case "cfgCreateDefault": {
        const domain = normalizeDomain(params.domain);
        const type = assertIdentifier(params.type, "configuration type");
        const name = assertInstanceKey(params.name, "configuration instance name");
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path:
              `/rw/cfg/${domain}/${encodeURIComponent(type)}/instances` +
              (this.protocol === RWS2
                ? "/create-default"
                : "?action=create-default"),
            form: { name }
          },
          allowedStatusCodes: [201],
          officialStatusCodes: [201],
          requiresMastership: true,
          effect: `Create CFG instance ${domain}/${type}/${name} with defaults.`,
          parse: parseCreateDefault
        });
      }

      case "cfgDelete": {
        const domain = normalizeDomain(params.domain);
        const type = assertIdentifier(params.type, "configuration type");
        const deleteKey = assertInstanceKey(params.deleteKey);
        return this.descriptor({
          operation,
          request: {
            method: "DELETE",
            path:
              `/rw/cfg/${domain}/${encodeURIComponent(type)}/instances/` +
              encodeURIComponent(deleteKey)
          },
          allowedStatusCodes: [200, 204],
          officialStatusCodes: [204],
          requiresMastership: true,
          effect: `Delete exact CFG instance key ${domain}/${type}/${deleteKey}.`
        });
      }

      case "cfgValidate":
      case "cfgLoad": {
        const actionType = normalizeCfgAction(
          params.actionType,
          operation,
          this.protocol
        );
        const filepath = normalizeControllerFilePath(params.filepath);
        const action = operation === "cfgValidate" ? "validate" : "load";
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: this.protocol === RWS2
              ? `/rw/cfg/${action}`
              : `/rw/cfg?action=${action}`,
            form: { filepath, "action-type": actionType }
          },
          allowedStatusCodes: operation === "cfgLoad" && this.protocol === RWS2
            ? [202]
            : [200, 204],
          officialStatusCodes: operation === "cfgValidate"
            ? [200]
            : this.protocol === RWS2
              ? [202]
              : [204],
          requiresMastership: true,
          timeoutClass: "long",
          effect:
            operation === "cfgValidate"
              ? `Validate CFG file ${filepath} as ${actionType}; does not load it.`
              : `Load CFG file ${filepath} as ${actionType}.`,
          parse: operation === "cfgValidate" ? parseCfgValidate : acceptedResponse
        });
      }

      case "rapidSetInit": {
        const task = assertIdentifier(params.task, "RAPID task");
        const module = assertIdentifier(params.module, "RAPID module");
        const name = assertIdentifier(params.name, "RAPID data name");
        if (params.value === undefined || params.value === null) {
          throw new Error("RAPID initial value is required.");
        }
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path:
              (this.protocol === RWS2
                ? `/rw/rapid/symbol/RAPID/${encodeURIComponent(task)}/` +
                  `${encodeURIComponent(module)}/${encodeURIComponent(name)}/data?initval=true`
                : `/rw/rapid/symbol/data/RAPID/${encodeURIComponent(task)}/` +
                  `${encodeURIComponent(module)}/${encodeURIComponent(name)}` +
                  "?action=setInitValue"),
            form: { value: String(params.value) }
          },
          allowedStatusCodes: [204],
          officialStatusCodes: [204],
          requiresMastership: true,
          effect: `Set the initial value of existing RAPID data ${task}/${module}/${name}.`
        });
      }

      case "rapidLoadModuleReplace": {
        const task = assertIdentifier(params.task, "RAPID task");
        const modulepath = normalizeControllerFilePath(
          params.modulepath,
          "RAPID module controller path"
        );
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: `/rw/rapid/tasks/${encodeURIComponent(task)}` +
              (this.protocol === RWS2 ? "/loadmod" : "?action=loadmod"),
            form: { modulepath, replace: "true" }
          },
          allowedStatusCodes: [200, 204],
          officialStatusCodes: this.protocol === RWS2 ? [200] : [204],
          requiresMastership: true,
          timeoutClass: "long",
          effect: `Load ${modulepath} into ${task} with replace=true.`
        });
      }

      case "rapidDeleteModule": {
        const task = assertIdentifier(params.task, "RAPID task");
        const module = assertIdentifier(params.module, "RAPID module");
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: `/rw/rapid/tasks/${encodeURIComponent(task)}` +
              (this.protocol === RWS2 ? "/unloadmod" : "?action=unloadmod"),
            form: { module }
          },
          allowedStatusCodes: [200, 204],
          officialStatusCodes: [204],
          requiresMastership: true,
          effect: `Unload RAPID module ${task}/${module}.`
        });
      }

      case "rapidBuild": {
        const task = assertIdentifier(params.task, "RAPID task");
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: `/rw/rapid/tasks/${encodeURIComponent(task)}` +
              (this.protocol === RWS2 ? "/build" : "?action=build"),
            form: {}
          },
          allowedStatusCodes: [200, 204],
          officialStatusCodes: [204],
          requiresMastership: true,
          timeoutClass: "long",
          effect: `Build RAPID task ${task}; build errors must be read separately.`
        });
      }

      case "rapidBuildErrors": {
        const task = assertIdentifier(params.task, "RAPID task");
        const start = Number(params.start ?? 1);
        const limit = Number(params.limit ?? 30);
        if (!Number.isSafeInteger(start) || start < 1 || start > 10_000) {
          throw new Error(`Build-error start must be an integer from 1 to 10000: ${params.start}`);
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
          throw new Error(`Build-error limit must be an integer from 1 to 30: ${params.limit}`);
        }
        return this.descriptor({
          operation,
          request: {
            method: "GET",
            path:
              `/rw/rapid/tasks/${encodeURIComponent(task)}/program/builderror` +
              `?start=${start}&limit=${limit}`
          },
          allowedStatusCodes: [200],
          officialStatusCodes: [200],
          mutating: false,
          effect: `Read one RAPID build-error page for ${task}.`,
          parse: parseBuildErrors
        });
      }

      case "ordinaryRestart": {
        const mode = String(params.mode ?? "restart").toLowerCase();
        if (mode !== "restart") {
          unsupported(
            operation,
            `only ordinary restart is exposed; requested restart-mode=${mode}`,
            this.protocol
          );
        }
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: this.protocol === RWS2
              ? "/rw/panel/restart"
              : "/rw/panel?action=restart",
            form: { "restart-mode": "restart" }
          },
          allowedStatusCodes: [200, 202, 204],
          officialStatusCodes: [204],
          timeoutClass: "long",
          effect: "Perform one ordinary restart; no I-start, P-start, B-start, X-start, or shutdown."
        });
      }

      case "fileMkdir": {
        const root = normalizeFileRoot(params.root);
        const directory = normalizeRelativePath(params.directory, "FileService directory");
        const segments = directory.split("/");
        const name = segments.pop();
        const parent = segments.join("/");
        const allowExisting = params.allowExisting === true;
        return this.descriptor({
          operation,
          request: {
            method: "POST",
            path: this.protocol === RWS2
              ? `${fileServicePath(root, parent, true)}create`
              : fileServicePath(root, parent, true),
            form: this.protocol === RWS2
              ? { "fs-newname": name }
              : { "fs-newname": name, "fs-action": "create" }
          },
          allowedStatusCodes: allowExisting
            ? [200, 201, 204, 409]
            : [200, 201, 204],
          officialStatusCodes: [201],
          effect: `Create FileService directory ${root}/${directory}.`,
          metadata: {
            root,
            directory,
            parent,
            name,
            ControllerDirectory: this.protocol === RWS2
              ? `${root}/${directory}`
              : `${FILE_ROOTS.get(root)}/${directory}`,
            AllowExisting: allowExisting
          }
        });
      }

      case "fileUpload": {
        const root = normalizeFileRoot(params.root);
        const relativePath = normalizeRelativePath(
          params.relativePath,
          "FileService upload path"
        );
        const bytes = normalizeBytes(params.bytes);
        const normalizedContentType = normalizeContentType(params.contentType);
        const contentType = this.protocol === RWS2
          ? rws2ContentType(normalizedContentType)
          : normalizedContentType;
        return this.descriptor({
          operation,
          request: {
            method: "PUT",
            path: fileServicePath(root, relativePath),
            bytes,
            contentType
          },
          allowedStatusCodes: [200, 201, 204],
          officialStatusCodes: [200, 201],
          timeoutClass: "long",
          effect: `Upload or overwrite FileService file ${root}/${relativePath}.`,
          metadata: {
            root,
            relativePath,
            ControllerPath: this.protocol === RWS2
              ? `${root}/${relativePath}`
              : controllerPath(root, relativePath),
            ByteLength: bytes.length
          }
        });
      }

      case "fileDelete": {
        const root = normalizeFileRoot(params.root);
        const relativePath = normalizeRelativePath(
          params.relativePath,
          "FileService delete path"
        );
        const allowMissing = params.allowMissing === true;
        return this.descriptor({
          operation,
          request: {
            method: "DELETE",
            path: fileServicePath(root, relativePath)
          },
          allowedStatusCodes: allowMissing ? [200, 204, 404] : [200, 204],
          officialStatusCodes: [204],
          effect: `Recursively delete FileService path ${root}/${relativePath}.`,
          metadata: {
            root,
            relativePath,
            AllowMissing: allowMissing
          }
        });
      }

      default:
        unsupported(
          operation,
          "operation is not implemented by the ABB write adapter",
          this.protocol
        );
    }
  }

  mastershipRequest(params) {
    return this.operation("mastershipRequest", params);
  }

  mastershipRelease(params) {
    return this.operation("mastershipRelease", params);
  }

  cfgSet(params) {
    return this.operation("cfgSet", params);
  }

  cfgCreateDefault(params) {
    return this.operation("cfgCreateDefault", params);
  }

  cfgDelete(params) {
    return this.operation("cfgDelete", params);
  }

  cfgValidate(params) {
    return this.operation("cfgValidate", params);
  }

  cfgLoad(params) {
    return this.operation("cfgLoad", params);
  }

  rapidSetInit(params) {
    return this.operation("rapidSetInit", params);
  }

  rapidLoadModuleReplace(params) {
    return this.operation("rapidLoadModuleReplace", params);
  }

  rapidDeleteModule(params) {
    return this.operation("rapidDeleteModule", params);
  }

  rapidBuild(params) {
    return this.operation("rapidBuild", params);
  }

  rapidBuildErrors(params) {
    return this.operation("rapidBuildErrors", params);
  }

  ordinaryRestart(params) {
    return this.operation("ordinaryRestart", params);
  }

  fileMkdir(params) {
    return this.operation("fileMkdir", params);
  }

  fileUpload(params) {
    return this.operation("fileUpload", params);
  }

  fileDelete(params) {
    return this.operation("fileDelete", params);
  }
}

export {
  MAX_FILE_BYTES,
  OFFICIAL_RWS1_REFERENCES,
  OFFICIAL_RWS2_REFERENCES,
  RWS1,
  RWS2,
  SAFETY_EXCLUDED_OPERATIONS
};
