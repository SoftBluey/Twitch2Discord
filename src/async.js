"use strict";

function abortError() {
  return Object.assign(new Error("Operation cancelled"), {
    name: "AbortError",
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // Shared work can finish after its caller cancels; still observe a late failure.
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class Limiter {
  constructor(limit, maxQueue = 64) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }
  async run(fn, signal) {
    if (signal?.aborted) throw abortError();
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue)
        throw new Error("Lookup queue is full");
      await new Promise((resolve, reject) => {
        const entry = {
          resolve: () => {
            cleanup();
            resolve();
          },
        };
        const cancel = () => {
          this.queue.splice(this.queue.indexOf(entry), 1);
          cleanup();
          reject(abortError());
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        this.queue.push(entry);
      });
    } else this.active++;
    try {
      if (signal?.aborted) throw abortError();
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.active--;
    }
  }
}

module.exports = { abortError, abortable, delay, Limiter };
