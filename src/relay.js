"use strict";

const { EventEmitter } = require("node:events");
const { delay } = require("./async");

class Relay extends EventEmitter {
  constructor(config, twitch, media, log) {
    super();
    Object.assign(this, { config, twitch, media, log });
    this.override = null;
    this.current = null;
    this.state = "idle";
    this.generation = 0;
    this.attempt = null;
    this.stopped = false;
    this.lastSwitchAt = 0;
    this.failedUntil = new Map();
    this.offlineCount = 0;
  }

  change(source, reason = "selection changed") {
    this.override = source;
    this.offlineCount = 0;
    this.lastSwitchAt = Date.now();
    this.failedUntil.clear();
    this.interrupt(reason);
  }

  interrupt(reason = "restart requested") {
    this.generation++;
    this.attempt?.abort(new Error(reason));
    this.emit("selection", this.generation);
  }

  stop() {
    this.stopped = true;
    this.interrupt("shutdown");
  }

  available(source) {
    return (this.failedUntil.get(source.id) || 0) <= Date.now();
  }

  async candidates(signal) {
    const override = this.override;
    if (override) {
      const state = await this.twitch.check(override, signal);
      signal.throwIfAborted();
      if (state === "unknown") {
        this.offlineCount = 0;
        return [];
      }
      if (state === "online") {
        this.offlineCount = 0;
        return [override];
      }
      if (++this.offlineCount < this.config.offlineConfirmations) return [];
      this.override = null;
      this.offlineCount = 0;
      this.emit("overrideEnded", override);
    }
    const states = await this.twitch.availability(this.config.sources, signal);
    signal.throwIfAborted();
    return states
      .filter(
        (entry) => entry.state === "online" && this.available(entry.source),
      )
      .map((entry) => entry.source);
  }

  async run() {
    let failures = 0;
    while (!this.stopped) {
      const attempt = new AbortController();
      this.attempt = attempt;
      const { signal } = attempt;
      const generation = this.generation;
      let madeProgress = false;
      try {
        this.state = "checking";
        const candidates = await this.candidates(signal);
        for (const source of candidates) {
          signal.throwIfAborted();
          try {
            this.state = "resolving";
            const url = await this.twitch.resolve(source, signal);
            signal.throwIfAborted();
            if (generation !== this.generation) break;
            this.current = source;
            this.state = "starting";
            this.log.info(`Starting ${source.name}`);
            await this.media.play(source, url, signal, () => {
              if (signal.aborted || generation !== this.generation) return;
              madeProgress = true;
              this.state = "playing";
              this.emit("playing", source);
            });
            signal.throwIfAborted();
            // A normally ended stream must still be rechecked before reuse.
            break;
          } catch (error) {
            if (error.fatal) throw error;
            if (signal.aborted) break;
            this.failedUntil.set(
              source.id,
              Date.now() + this.config.failedSourceCooldownMs,
            );
            this.log.warn(
              `Playback failed for ${source.name}: ${error.message}`,
            );
          } finally {
            this.current = null;
          }
        }
      } catch (error) {
        if (error.fatal) throw error;
        if (!signal.aborted) this.log.warn(error);
      } finally {
        this.current = null;
        this.state = this.stopped ? "stopped" : "idle";
      }
      if (!signal.aborted && !this.stopped) {
        failures = madeProgress ? 0 : Math.min(failures + 1, 6);
        const wait = Math.min(
          this.config.retryMaxMs,
          this.config.pollIntervalMs * 2 ** Math.max(0, failures - 1),
        );
        await delay(wait, signal).catch(() => {});
      }
      if (signal.aborted) failures = 0;
    }
  }
}

module.exports = { Relay };
