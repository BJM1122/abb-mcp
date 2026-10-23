import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "credential-helper.cs");
const executablePath = path.join(here, "abb-credential-helper.exe");
const defaultCompiler =
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

async function exists(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureCredentialHelper({ allowBuild = false } = {}) {
  const source = await stat(sourcePath);
  const executable = await exists(executablePath);
  if (executable && executable.mtimeMs >= source.mtimeMs) return executablePath;

  if (!allowBuild) {
    const reason = executable ? "is stale" : "is missing";
    const error = new Error(
      `ABB native credential helper ${reason}. Run "npm run build:native" before starting the MCP server.`
    );
    error.code = "NativeHelperUnavailable";
    throw error;
  }

  const compiler = process.env.ABB_MCP_CSC || defaultCompiler;
  await execFileAsync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      `/out:${executablePath}`,
      "/reference:System.Security.dll",
      sourcePath
    ],
    { cwd: here, windowsHide: true, timeout: 30_000 }
  );
  return executablePath;
}

function expandEnvironmentVariables(value) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => {
    const resolved = process.env[name];
    return resolved === undefined ? match : resolved;
  });
}

async function loadCredentialFile(credentialFile) {
  const helper = await ensureCredentialHelper();
  const { stdout } = await execFileAsync(helper, [credentialFile], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    encoding: "utf8"
  });
  const lines = stdout.trimEnd().split(/\r?\n/);
  if (lines.length !== 2) {
    throw new Error("ABB credential helper returned an invalid response.");
  }
  const username = Buffer.from(lines[0], "base64").toString("utf8");
  const password = Buffer.from(lines[1], "base64").toString("utf8");
  if (!username || !password) {
    throw new Error("ABB credential helper returned an empty user name or password.");
  }
  return { username, password };
}

export class DpapiCredentialProvider {
  constructor({ loadCredential = loadCredentialFile } = {}) {
    if (typeof loadCredential !== "function") throw new Error("loadCredential must be a function.");
    this.loadCredential = loadCredential;
    this.cache = new Map();
  }

  async get(config) {
    const credentialFile = path.resolve(
      expandEnvironmentVariables(config.credentialFile)
    );
    const item = await stat(credentialFile);
    const cacheKey = `${item.mtimeMs}\0${item.size}`;
    const fileKey = process.platform === "win32" ? credentialFile.toLowerCase() : credentialFile;
    let entry = this.cache.get(fileKey);
    if (!entry || entry.key !== cacheKey) {
      entry = { key: cacheKey, promise: Promise.resolve().then(() => this.loadCredential(credentialFile)) };
      this.cache.set(fileKey, entry);
    }
    try {
      return { ...await entry.promise };
    } catch (error) {
      if (this.cache.get(fileKey) === entry) this.cache.delete(fileKey);
      throw error;
    }
  }

  clear() {
    this.cache.clear();
  }
}

async function atomicReplace(source, destination) {
  const helper = await ensureCredentialHelper();
  await execFileAsync(helper, ["--replace", path.resolve(source), path.resolve(destination)], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 128 * 1024
  });
}

export { atomicReplace, ensureCredentialHelper, expandEnvironmentVariables };
