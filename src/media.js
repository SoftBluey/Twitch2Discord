"use strict";

const { abortable } = require("./async");

function filterPath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/[:'\[\],;]/g, (character) => `\\${character}`);
}

function makeEncoder(api, config, source) {
  const base =
    config.encoder === "vaapi"
      ? api.Encoders.vaapi({ device: config.vaapiDevice })
      : config.encoder === "nvenc"
        ? api.Encoders.nvenc({
            preset: config.nvencPreset,
            gpu: config.nvencGpu,
          })
        : api.Encoders.software({
            x264: { preset: config.softwarePreset, tune: "zerolatency" },
          });
  return (bitrate, maxBitrate) => {
    const settings = base(bitrate, maxBitrate);
    const h264 = { ...settings.H264 };
    if (!h264.name) throw new Error("H.264 encoder unavailable");
    // The label is a validated Twitch username, not arbitrary filter syntax.
    h264.outFilters = [
      ...(config.watermark
        ? [
            `drawtext=fontfile='${filterPath(config.fontFile)}':text='${source.name}':expansion=none:fontsize=18:fontcolor=white@0.92:x=20:y=h-th-20:box=1:boxcolor=black@0.58:boxborderw=7`,
          ]
        : []),
      ...(h264.outFilters || []),
    ];
    h264.options = [
      ...(h264.options || []),
      ...(config.encoder === "vaapi" ? ["-rc_mode", "VBR"] : []),
      "-g",
      String(config.fps),
    ];
    return { ...settings, H264: h264 };
  };
}

function settledWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class Media {
  constructor(api, streamer, config, log) {
    Object.assign(this, { api, streamer, config, log });
  }

  async play(source, url, signal, onProgress) {
    const { config, api, streamer, log } = this;
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal]);
    combined.throwIfAborted();
    const {
      command,
      output,
      promise: encoding,
    } = api.prepareStream(
      url,
      {
        encoder: makeEncoder(api, config, source),
        height: config.height,
        frameRate: config.fps,
        bitrateVideo: config.videoBitrate,
        bitrateVideoMax: config.videoBitrateMax,
        bitrateAudio: config.audioBitrate,
        includeAudio: config.includeAudio,
        videoCodec: api.Utils.normalizeVideoCodec("H264"),
        hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
        minimizeLatency: false,
        customInputOptions: [
          "-thread_queue_size",
          "1024",
          "-rw_timeout",
          "30000000",
        ],
        customFfmpegFlags: ["-max_muxing_queue_size", "2048"],
      },
      combined,
    );

    let lastProgress = Date.now();
    let lastFrame = -1;
    let slowSince = null;
    let started = false;
    let playback;
    let previousSample = null;
    command.on("error", (error) => {
      if (!combined.aborted) local.abort(error);
    });
    command.on("progress", ({ frames, timemark }) => {
      const now = Date.now();
      if (Number.isFinite(frames) && frames > lastFrame) {
        lastFrame = frames;
        lastProgress = now;
        if (!started && lastFrame > 0 && !combined.aborted) {
          started = true;
          onProgress();
        }
      }
      if (Number.isFinite(timemark)) {
        if (previousSample && now > previousSample.at) {
          const speed =
            ((timemark - previousSample.time) * 1000) /
            (now - previousSample.at);
          if (speed < config.watchdogMinimumSpeed) slowSince ??= now;
          else slowSince = null;
        }
        previousSample = { at: now, time: timemark };
      }
    });
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastProgress > config.watchdogStallWindowMs)
          local.abort(new Error("Encoder stalled"));
        else if (
          slowSince &&
          Date.now() - slowSince > config.watchdogSlowWindowMs
        )
          local.abort(
            new Error("Encoder cannot keep up; lower height, fps or bitrate"),
          );
      },
      Math.min(5000, config.watchdogStallWindowMs),
    );
    const kill = () => {
      try {
        encoding.kill("SIGKILL");
      } catch {}
    };
    combined.addEventListener("abort", kill, { once: true });
    try {
      // Observe both promises immediately; announcements never gate playback supervision.
      const encoderFailure = encoding.then(() => new Promise(() => {}));
      playback = Promise.resolve().then(() => {
        combined.throwIfAborted();
        return api.playStream(
          output,
          streamer,
          { type: "go-live", streamPreview: false },
          combined,
        );
      });
      await abortable(Promise.race([playback, encoderFailure]), combined);
      if (combined.aborted) throw combined.reason;
    } catch (error) {
      if (!signal.aborted) throw combined.reason || error;
    } finally {
      clearInterval(watchdog);
      local.abort(new Error("Playback finished"));
      kill();
      output.destroy();
      try {
        streamer.stopStream();
      } catch (error) {
        log.warn(error);
      }
      combined.removeEventListener("abort", kill);
      // Never start a second stream while an old library call can still mutate the connection.
      const cleaned = await settledWithin(
        Promise.allSettled([encoding, playback]),
        config.shutdownTimeoutMs,
      );
      if (!cleaned)
        throw Object.assign(
          new Error(
            "Playback cleanup timed out; restarting the process is required",
          ),
          { fatal: true },
        );
    }
  }
}

module.exports = { Media, makeEncoder, settledWithin };
