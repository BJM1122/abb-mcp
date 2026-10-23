import { readDeadlineError, remainingReadTime } from "./read-deadline.mjs";

function queueWaitMilliseconds(value) {
  const milliseconds = Number(value ?? 2_000);
  return Number.isFinite(milliseconds)
    ? Math.max(100, milliseconds)
    : 2_000;
}

function workerBusyError(alias, mode, maximumWait) {
  const detail = mode === "read"
    ? "a shared read remained blocked by an exclusive operation"
    : "an exclusive operation remained blocked by active work";
  const error = new Error(
    `WorkerBusy: ABB alias '${alias}' ${detail} for more than ${maximumWait} ms; ` +
      "the active operation was not interrupted."
  );
  error.code = "WorkerBusy";
  return error;
}

export class AliasReadWriteLock {
  constructor(alias, maxReaders) {
    if (!Number.isSafeInteger(maxReaders) || maxReaders < 1) {
      throw new Error("AliasReadWriteLock maxReaders must be a positive integer.");
    }
    this.alias = String(alias);
    this.maxReaders = maxReaders;
    this.activeReaders = 0;
    this.activeReaderWeight = 0;
    this.activeWriter = false;
    this.queue = [];
  }

  get idle() {
    return !this.activeWriter && this.activeReaders === 0 && this.queue.length === 0;
  }

  hasQueuedWriter() {
    return this.queue.some((waiter) => waiter.mode === "write");
  }

  releaseFor(mode, weight = 1) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "read") {
        this.activeReaders = Math.max(0, this.activeReaders - 1);
        this.activeReaderWeight = Math.max(0, this.activeReaderWeight - weight);
      } else {
        this.activeWriter = false;
      }
      this.drain();
    };
  }

  grant(waiter) {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    clearTimeout(waiter.deadlineTimer);
    waiter.timer = null;
    if (waiter.mode === "read") {
      this.activeReaders += 1;
      this.activeReaderWeight += waiter.weight;
    } else {
      this.activeWriter = true;
    }
    waiter.resolve(this.releaseFor(waiter.mode, waiter.weight));
  }

  expire(waiter) {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return;
    if (
      waiter.mode === "read" &&
      !this.activeWriter &&
      !this.hasQueuedWriter()
    ) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
      waiter.blockedByWriterAt = null;
      this.drain();
      return;
    }
    this.queue.splice(index, 1);
    clearTimeout(waiter.deadlineTimer);
    waiter.timer = null;
    waiter.reject(workerBusyError(this.alias, waiter.mode, waiter.maximumWait));
    this.drain();
  }

  refreshTimers() {
    const writerPresent = this.activeWriter || this.hasQueuedWriter();
    const now = Date.now();
    for (const waiter of this.queue) {
      const timed = waiter.mode === "write" || writerPresent;
      if (!timed) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = null;
        waiter.blockedByWriterAt = null;
        continue;
      }
      if (waiter.timer) continue;
      if (waiter.mode === "read" && waiter.blockedByWriterAt === null) {
        waiter.blockedByWriterAt = now;
      }
      const startedAt = waiter.mode === "write"
        ? waiter.queuedAt
        : waiter.blockedByWriterAt;
      const remaining = Math.max(
        0,
        waiter.maximumWait - (now - startedAt)
      );
      waiter.timer = setTimeout(() => this.expire(waiter), remaining);
    }
  }

  drain() {
    if (this.activeWriter) {
      this.refreshTimers();
      return;
    }

    const writerIndex = this.queue.findIndex((waiter) => waiter.mode === "write");
    if (writerIndex >= 0) {
      if (this.activeReaders === 0) {
        this.grant(this.queue[writerIndex]);
      }
      this.refreshTimers();
      return;
    }

    while (this.activeReaderWeight < this.maxReaders) {
      const reader = this.queue.find((waiter) => waiter.mode === "read");
      if (!reader) break;
      if (this.activeReaderWeight + reader.weight > this.maxReaders) break;
      this.grant(reader);
    }
    this.refreshTimers();
  }

  async acquire(mode, queueTimeoutMs, weight = 1, deadlineAt) {
    const remaining = remainingReadTime(deadlineAt);
    if (mode !== "read" && mode !== "write") {
      throw new Error(`Unsupported ABB alias lock mode: ${mode}`);
    }
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > this.maxReaders) {
      throw new Error(
        `ABB alias read weight must be an integer from 1 to ${this.maxReaders}.`
      );
    }
    if (
      mode === "read" &&
      !this.activeWriter &&
      !this.hasQueuedWriter() &&
      this.activeReaderWeight + weight <= this.maxReaders
    ) {
      this.activeReaders += 1;
      this.activeReaderWeight += weight;
      return this.releaseFor("read", weight);
    }
    if (
      mode === "write" &&
      !this.activeWriter &&
      this.activeReaders === 0 &&
      this.queue.length === 0
    ) {
      this.activeWriter = true;
      return this.releaseFor("write");
    }

    const maximumWait = queueWaitMilliseconds(queueTimeoutMs);
    return await new Promise((resolve, reject) => {
      const waiter = {
        mode,
        weight,
        resolve,
        reject,
        maximumWait,
        queuedAt: Date.now(),
        blockedByWriterAt: null,
        timer: null
      };
      if (remaining !== undefined) {
        waiter.deadlineTimer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          clearTimeout(waiter.timer);
          reject(readDeadlineError());
          this.drain();
        }, remaining);
      }
      this.queue.push(waiter);
      this.refreshTimers();
      this.drain();
    });
  }
}
