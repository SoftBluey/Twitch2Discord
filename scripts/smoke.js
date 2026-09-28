"use strict";

// Local synthetic media only: this never connects to Twitch or Discord.
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateConfig, twitchSource } = require("../src/config");
const { preflight } = require("../src/preflight");
const { makeEncoder, settledWithin } = require("../src/media");

async function checkCancellation(api, config) {
  const controller = new AbortController();
  const live = api.prepareStream(
    "testsrc2=size=640x360:rate=30",
    {
      encoder: makeEncoder(api, config, twitchSource("example")),
      videoCodec: api.Utils.normalizeVideoCodec("H264"),
      includeAudio: false,
      height: 360,
      frameRate: 30,
      customInputOptions: ["-f", "lavfi", "-re"],
    },
    controller.signal,
  );
  let sawFrames = false;
  const ready = new Promise((resolve) =>
    live.command.on("progress", (progress) => {
      if (progress.frames > 0) {
        sawFrames = true;
        resolve();
      }
    }),
  );
  live.output.resume();
  try {
    if (
      !(await settledWithin(Promise.race([ready, live.promise]), 10000)) ||
      !sawFrames
    )
      throw new Error("Live encoder did not report progress");
    controller.abort();
    live.promise.kill("SIGKILL");
    if (!(await settledWithin(live.promise, 5000)))
      throw new Error("Live encoder did not stop");
    console.log("Live encoder cancellation passed.");
  } finally {
    controller.abort();
    live.promise.kill("SIGKILL");
    live.output.destroy();
    await settledWithin(live.promise, 5000);
  }
}

async function smoke() {
  const config = validateConfig(
    {
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      streamers: ["example"],
      height: 360,
      ytDlpPath: existsSync(path.resolve(__dirname, "../.venv/bin/yt-dlp"))
        ? path.resolve(__dirname, "../.venv/bin/yt-dlp")
        : "yt-dlp",
    },
    {},
  );
  for (const line of await preflight(config)) console.log(line);
  process.env.FFMPEG_PATH = config.ffmpegPath;
  const api = await import("@dank074/discord-video-stream");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "twitch2discord-smoke-"),
  );
  const input = path.join(directory, "sample.mp4");
  let pipeline;
  const controller = new AbortController();
  try {
    await promisify(execFile)(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        input,
      ],
      { timeout: 30000, windowsHide: true },
    );
    pipeline = api.prepareStream(
      input,
      {
        encoder: makeEncoder(api, config, twitchSource("example")),
        videoCodec: api.Utils.normalizeVideoCodec("H264"),
        includeAudio: true,
        height: 360,
        frameRate: 30,
      },
      controller.signal,
    );
    let bytes = 0;
    let frames = 0;
    pipeline.command.on("progress", (progress) => {
      frames = Math.max(frames, progress.frames);
    });
    pipeline.output.on("data", (chunk) => {
      bytes += chunk.length;
    });
    if (!(await settledWithin(pipeline.promise, 30000)))
      throw new Error("Encoding smoke test timed out");
    await pipeline.promise;
    if (!bytes || !frames)
      throw new Error("Encoder produced no media or progress updates");
    console.log(
      `Software H.264/Opus pipeline passed (${bytes} bytes). No Discord login attempted.`,
    );
    await checkCancellation(api, config);
  } finally {
    controller.abort();
    try {
      pipeline?.promise.kill("SIGKILL");
    } catch {}
    pipeline?.output.destroy();
    if (pipeline) await settledWithin(pipeline.promise, 5000);
    await fs.rm(input, { force: true });
    await fs.rmdir(directory);
  }
}

smoke().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
