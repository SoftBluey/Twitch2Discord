"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Limiter, abortable } = require("./async");
const execute = promisify(execFile);

class Twitch {
  constructor(config, run = execute) {
    this.config = config;
    this.run = run;
    this.limiter = new Limiter(config.probeConcurrency);
    this.cache = new Map();
    this.pending = new Map();
    this.shutdown = new AbortController();
  }

  exec(args, timeout, signal) {
    return this.limiter.run(
      () =>
        this.run(
          this.config.ytDlpPath,
          ["--no-config", "--no-warnings", "--no-playlist", ...args],
          {
            timeout,
            signal,
            killSignal: "SIGKILL",
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        ),
      signal,
    );
  }

  check(source, signal) {
    if (this.shutdown.signal.aborted)
      return Promise.reject(new Error("Twitch checks stopped"));
    const cached = this.cache.get(source.id);
    if (cached && Date.now() - cached.at < this.config.probeCacheMs)
      return abortable(Promise.resolve(cached.state), signal);
    if (!this.pending.has(source.id)) {
      const task = this.exec(
        ["--skip-download", "--simulate", "--", source.url],
        this.config.probeTimeoutMs,
        this.shutdown.signal,
      )
        .then(
          () => "online",
          (error) => {
            if (this.shutdown.signal.aborted) throw error;
            // yt-dlp's Twitch extractor distinguishes offline streams from HTTP and extraction failures.
            return /(?:is offline|not currently live|is not live|stream is offline)/i.test(
              String(error.stderr || ""),
            )
              ? "offline"
              : "unknown";
          },
        )
        .then((state) => {
          if (this.cache.size >= 256)
            this.cache.delete(this.cache.keys().next().value);
          this.cache.set(source.id, { at: Date.now(), state });
          return state;
        })
        .finally(() => this.pending.delete(source.id));
      this.pending.set(source.id, task);
    }
    return abortable(this.pending.get(source.id), signal);
  }

  async availability(sources, signal) {
    return Promise.all(
      sources.map(async (source) => ({
        source,
        state: await this.check(source, signal),
      })),
    );
  }

  async resolve(source, signal) {
    const { stdout } = await this.exec(
      ["-f", this.config.twitchFormat, "-g", "--", source.url],
      this.config.resolveTimeoutMs,
      signal,
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1 || !/^https?:\/\//i.test(lines[0]))
      throw new Error(
        "Expected one combined video/audio stream URL; check twitchFormat.",
      );
    return lines[0];
  }

  close() {
    this.shutdown.abort();
  }
}

module.exports = { Twitch };
