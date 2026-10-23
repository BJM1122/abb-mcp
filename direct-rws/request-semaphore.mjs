import { readDeadlineError, remainingReadTime } from "./read-deadline.mjs";

export class RequestSemaphore {
  constructor(limit, name = "request semaphore") {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`${name} limit must be a positive safe integer.`);
    }
    this.limit = limit;
    this.name = String(name);
    this.active = 0;
    this.peak = 0;
    this.queue = [];
  }

  get idle() {
    return this.active === 0 && this.queue.length === 0;
  }

  releaseForPermit() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  grant(resolve) {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    resolve(this.releaseForPermit());
  }

  drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift();
      clearTimeout(waiter.timer);
      this.grant(waiter.resolve);
    }
  }

  async acquire(deadlineAt) {
    const remaining = remainingReadTime(deadlineAt);
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return this.releaseForPermit();
    }
    return await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      if (remaining !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(readDeadlineError());
        }, remaining);
      }
      this.queue.push(waiter);
      this.drain();
    });
  }

  async run(operation, deadlineAt) {
    if (typeof operation !== "function") {
      throw new Error(`${this.name} operation must be a function.`);
    }
    const release = await this.acquire(deadlineAt);
    try {
      remainingReadTime(deadlineAt);
      return await operation();
    } finally {
      release();
    }
  }
}
