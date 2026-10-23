import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CONTROLLER_MUTATION_METHODS = new Set(["commit_job", "apply_backup"]);

function executionTimeoutError(request) {
  const detail = `ABB worker method timed out after ${request.timeoutMs} ms: ${request.method}`;
  if (!CONTROLLER_MUTATION_METHODS.has(request.method)) return new Error(detail);
  return new Error(
    `ControllerWriteUnknown: ${detail}. The request may have reached the controller; ` +
      "perform fresh readback and create a new plan. Do not replay the old token."
  );
}

function interruptedError(request, reason) {
  if (reason.message.startsWith("ControllerWriteUnknown:")) return reason;
  const detail = `ABB worker stopped while ${request.method} was active: ${reason.message}`;
  if (!CONTROLLER_MUTATION_METHODS.has(request.method)) return new Error(detail);
  return new Error(
    `ControllerWriteUnknown: ${detail}. The request may have reached the controller; ` +
      "perform fresh readback and create a new plan. Do not replay the old token."
  );
}

export class PowerShellWorker {
  constructor({
    command,
    args,
    cwd,
    windowsHide = true,
    stderrPrefix = "[abb-worker]",
    defaultQueueTimeoutMs = 2_000,
    maxQueueLength = 64
  }) {
    this.nextId = 1;
    this.pending = new Map();
    this.queue = [];
    this.active = null;
    this.accepting = true;
    this.closed = false;
    this.exited = false;
    this.defaultQueueTimeoutMs = defaultQueueTimeoutMs;
    this.maxQueueLength = maxQueueLength;
    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide
    });

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`${stderrPrefix} ${text}`);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closed) this.#terminate(error);
    });
    this.child.on("error", (error) => {
      this.#terminate(error);
      this.#markExited();
    });
    this.child.on("exit", (code, signal) => {
      const reason = new Error(`ABB PowerShell worker exited code=${code} signal=${signal}`);
      this.closed = true;
      this.accepting = false;
      this.#rejectAll(reason);
      this.#markExited();
    });
  }

  get busy() {
    return this.active !== null || this.queue.length > 0;
  }

  #markExited() {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
  }

  #settle(request, action, value) {
    if (!this.pending.has(request.id)) return;
    this.pending.delete(request.id);
    if (request.queueTimer) clearTimeout(request.queueTimer);
    if (request.executionTimer) clearTimeout(request.executionTimer);
    request.queueTimer = null;
    request.executionTimer = null;
    action(value);
  }

  #rejectAll(reason) {
    const active = this.active;
    this.active = null;
    if (active) {
      this.#settle(active, active.reject, interruptedError(active, reason));
    }

    const queued = this.queue.splice(0);
    for (const request of queued) {
      this.#settle(
        request,
        request.reject,
        new Error(
          `ABB worker recycled after ${active?.method || "startup"} failed; ` +
            `queued method ${request.method} was not executed.`
        )
      );
    }
  }

  #terminate(reason) {
    if (this.closed) return;
    this.closed = true;
    this.accepting = false;
    this.#rejectAll(reason);
    try {
      this.lines.close();
    } catch {}
    try {
      if (!this.child.stdin.destroyed) this.child.stdin.destroy();
    } catch {}
    try {
      if (this.child.exitCode === null && !this.child.killed) this.child.kill();
    } catch {}
  }

  #onLine(line) {
    if (this.closed) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#terminate(new Error(`Invalid JSON from ABB worker: ${error.message}`));
      return;
    }

    const active = this.active;
    if (!active || message.id !== active.id) {
      const workerDetail =
        message?.error?.message ||
        (message && typeof message === "object" ? JSON.stringify(message) : String(message));
      this.#terminate(
        new Error(
          `Unexpected ABB worker response id=${String(message.id)} active=${String(active?.id ?? "none")}: ` +
            workerDetail
        )
      );
      return;
    }
    if (message.progress === true) {
      if (active.onProgress) {
        try {
          Promise.resolve(active.onProgress(message.event)).catch((error) => {
            console.error(`[abb-worker-progress] ${error.message}`);
          });
        } catch (error) {
          console.error(`[abb-worker-progress] ${error.message}`);
        }
      }
      return;
    }

    this.active = null;
    if (message.ok) {
      this.#settle(active, active.resolve, message.result);
    } else {
      this.#settle(
        active,
        active.reject,
        new Error(message.error?.message || "Unknown ABB worker error")
      );
    }
    queueMicrotask(() => this.#dispatchNext());
  }

  #dispatchNext() {
    if (this.closed || !this.accepting || this.active || this.queue.length === 0) return;
    if (!this.child.stdin.writable) {
      this.#terminate(new Error("ABB PowerShell worker stdin is not writable"));
      return;
    }

    const request = this.queue.shift();
    if (!this.pending.has(request.id)) {
      queueMicrotask(() => this.#dispatchNext());
      return;
    }

    if (request.queueTimer) clearTimeout(request.queueTimer);
    request.queueTimer = null;
    this.active = request;
    request.executionTimer = setTimeout(() => {
      const error = executionTimeoutError(request);
      this.#terminate(error);
    }, request.timeoutMs);
    request.executionTimer.unref?.();

    const payload = `${JSON.stringify({
      id: request.id,
      method: request.method,
      params: request.params
    })}\n`;
    this.child.stdin.write(payload, (error) => {
      if (error && this.active?.id === request.id) this.#terminate(error);
    });
  }

  call(
    method,
    params = {},
    timeoutMs = 60_000,
    queueTimeoutMs = this.defaultQueueTimeoutMs,
    onProgress = null
  ) {
    if (!this.accepting || this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error("ABB PowerShell worker is not running"));
    }
    if (this.queue.length >= this.maxQueueLength) {
      return Promise.reject(
        new Error(`WorkerBusy: ABB worker queue is full; ${method} was not started.`)
      );
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const request = {
        id,
        method,
        params,
        timeoutMs,
        queueTimeoutMs,
        onProgress,
        resolve,
        reject,
        queueTimer: null,
        executionTimer: null
      };
      this.pending.set(id, request);
      this.queue.push(request);

      if (this.active || this.queue[0] !== request) {
        request.queueTimer = setTimeout(() => {
          const index = this.queue.findIndex((candidate) => candidate.id === request.id);
          if (index < 0 || this.active?.id === request.id) return;
          this.queue.splice(index, 1);
          this.#settle(
            request,
            request.reject,
            new Error(
              `WorkerBusy: ${method} waited ${queueTimeoutMs} ms behind ` +
                `${this.active?.method || "another request"} and was not started. ` +
                "The active request was not interrupted."
            )
          );
        }, queueTimeoutMs);
        request.queueTimer.unref?.();
      }

      this.#dispatchNext();
    });
  }

  async close() {
    if (this.exited) return;
    this.accepting = false;

    const queued = this.queue.splice(0);
    for (const request of queued) {
      this.#settle(
        request,
        request.reject,
        new Error(`ABB MCP server is closing; queued method ${request.method} was not started.`)
      );
    }

    try {
      if (!this.child.stdin.destroyed) this.child.stdin.end();
    } catch {}

    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000);
        timer.unref?.();
      })
    ]);
    if (graceful) return;

    const closeTimeout = new Error("ABB PowerShell worker did not exit within 3000 ms");
    if (!this.closed) {
      this.#terminate(closeTimeout);
    } else {
      try {
        if (!this.child.stdin.destroyed) this.child.stdin.destroy();
      } catch {}
      try {
        if (this.child.exitCode === null) this.child.kill();
      } catch {}
    }
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      })
    ]);
  }
}
