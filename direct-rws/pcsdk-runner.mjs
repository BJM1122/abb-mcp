import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultExecutable = path.join(
  here,
  "native",
  "pcsdk",
  "bin",
  "abb-pcsdk-host.exe"
);
const defaultSdkDirectory = String.raw`C:\ABB_PCSDK\Bin`;

export class PcSdkHostError extends Error {
  constructor(message, {
    code = "PcSdkHostFailure",
    exitCode = null,
    details = null,
    controllerBackupOutcome = null
  } = {}) {
    super(message);
    this.name = "PcSdkHostError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    if (controllerBackupOutcome) {
      this.controllerBackupOutcome = controllerBackupOutcome;
    }
  }
}

export async function ensurePcSdkHost(executable = defaultExecutable) {
  let item;
  try {
    item = await stat(executable);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new PcSdkHostError(
      'ABB PC SDK host is missing. Run "npm run build:pcsdk" before starting the MCP server.',
      { code: "PcSdkHostUnavailable" }
    );
  }
  if (!item.isFile() || item.size < 1) {
    throw new PcSdkHostError("ABB PC SDK host is not a valid executable file.", {
      code: "PcSdkHostUnavailable"
    });
  }
  return executable;
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    throw new PcSdkHostError("ABB PC SDK host returned no JSON response.", {
      code: "PcSdkHostProtocolError"
    });
  }
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new PcSdkHostError("ABB PC SDK host returned invalid JSON.", {
      code: "PcSdkHostProtocolError"
    });
  }
}

export class PcSdkHostRunner {
  constructor({
    executable = defaultExecutable,
    sdkDirectory = process.env.ABB_PCSDK_DIR?.trim() || defaultSdkDirectory,
    maxOutputBytes = 2 * 1024 * 1024
  } = {}) {
    this.executable = executable;
    this.sdkDirectory = sdkDirectory;
    this.maxOutputBytes = maxOutputBytes;
  }

  async run(command, payload = null, { timeoutMs = 30_000 } = {}) {
    const executable = await ensurePcSdkHost(this.executable);
    const normalizedCommand = String(command);
    if (!["capability", "probe", "connect-probe", "backup"].includes(normalizedCommand)) {
      throw new PcSdkHostError(`Unsupported ABB PC SDK host command: ${command}`, {
        code: "PcSdkHostCommandRejected"
      });
    }
    const input = payload === null ? null : `${JSON.stringify(payload)}\n`;
    const args = [normalizedCommand, "--sdk-dir", this.sdkDirectory];
    const started = performance.now();

    return await new Promise((resolve, reject) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      let timer = null;
      let hardTimeout = null;
      const child = spawn(executable, args, {
        cwd: path.dirname(executable),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const finish = (action, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimeout);
        action(value);
      };
      const timeoutError = (exitCode = null) =>
        new PcSdkHostError(
          `ABB PC SDK ${normalizedCommand} timed out after ${timeoutMs} ms.`,
          {
            code: "PcSdkHostTimeout",
            exitCode,
            controllerBackupOutcome:
              normalizedCommand === "backup" ? "unknown" : null
          }
        );
      const append = (chunks, currentBytes, chunk) => {
        const bytes = Buffer.from(chunk);
        const nextBytes = currentBytes + bytes.length;
        if (nextBytes > this.maxOutputBytes) {
          child.kill();
          throw new PcSdkHostError("ABB PC SDK host output exceeded the safety limit.", {
            code: "PcSdkHostOutputLimit",
            controllerBackupOutcome:
              normalizedCommand === "backup" ? "unknown" : null
          });
        }
        chunks.push(bytes);
        return nextBytes;
      };
      child.stdout.on("data", (chunk) => {
        try {
          stdoutBytes = append(stdoutChunks, stdoutBytes, chunk);
        } catch (error) {
          finish(reject, error);
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderrBytes = append(stderrChunks, stderrBytes, chunk);
        } catch (error) {
          finish(reject, error);
        }
      });
      child.on("error", (error) => finish(reject, error));
      child.on("close", (exitCode) => {
        if (settled) return;
        if (timedOut) {
          finish(reject, timeoutError(exitCode));
          return;
        }
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
        let response;
        try {
          response = parseLastJsonLine(stdout);
        } catch (error) {
          finish(reject, error);
          return;
        }
        const elapsedMs = Math.round(performance.now() - started);
        if (exitCode !== 0 || response?.ok !== true) {
          const code = String(response?.error?.code || "PcSdkHostFailure");
          const message = String(
            response?.error?.message ||
            stderr.trim() ||
            `ABB PC SDK host exited with code ${exitCode}.`
          );
          finish(
            reject,
            new PcSdkHostError(message, {
              code,
              exitCode,
              details: response,
              controllerBackupOutcome:
                response?.controllerBackupOutcome ||
                (normalizedCommand === "backup" ? "unknown" : null)
            })
          );
          return;
        }
        finish(resolve, { ...response, hostElapsedMs: elapsedMs });
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        hardTimeout = setTimeout(
          () => finish(reject, timeoutError()),
          2_000
        );
      }, timeoutMs);
      timer.unref?.();
      child.stdin.on("error", (error) => {
        child.kill();
        finish(
          reject,
          new PcSdkHostError(
            `ABB PC SDK host stdin failed: ${error.message}`,
            {
              code: "PcSdkHostInputFailure",
              controllerBackupOutcome:
                normalizedCommand === "backup" ? "unknown" : null
            }
          )
        );
      });
      if (input === null) child.stdin.end();
      else child.stdin.end(input, "utf8");
    });
  }
}

export { defaultExecutable };
