"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);

async function preflight(config, run = execute) {
  const runCommand = async (file, args) => {
    try {
      return await run(file, args, {
        timeout: 30000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      throw new Error(
        `Cannot run ${file}. Check installation, PATH and executable permissions.`,
      );
    }
  };
  const [version, yt, encoders, filters] = await Promise.all([
    runCommand(config.ffmpegPath, ["-version"]),
    runCommand(config.ytDlpPath, ["--no-config", "--version"]),
    runCommand(config.ffmpegPath, ["-hide_banner", "-encoders"]),
    runCommand(config.ffmpegPath, ["-hide_banner", "-filters"]),
  ]);
  const requiredEncoder = {
    vaapi: "h264_vaapi",
    nvenc: "h264_nvenc",
    software: "libx264",
  }[config.encoder];
  if (!new RegExp(`\\b${requiredEncoder}\\b`).test(encoders.stdout))
    throw new Error(`FFmpeg is missing ${requiredEncoder}.`);
  if (config.encoder === "nvenc") {
    try {
      await runCommand(config.ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-preset",
        config.nvencPreset,
        "-gpu",
        String(config.nvencGpu),
        "-f",
        "null",
        "-",
      ]);
    } catch {
      throw new Error(
        "NVENC encoding check failed. Check NVIDIA drivers, nvencGpu and GPU access inside this machine/container. See docs/linux.md.",
      );
    }
  }
  if (
    config.includeAudio &&
    (!/\blibopus\b/.test(encoders.stdout) || !/\bazmq\b/.test(filters.stdout))
  )
    throw new Error(
      "FFmpeg needs libopus and the azmq filter (libzmq) for audio.",
    );
  if (config.watermark) {
    if (!/\bdrawtext\b/.test(filters.stdout))
      throw new Error("FFmpeg needs the drawtext filter for watermarks.");
    await fs.access(config.fontFile, constants.R_OK).catch(() => {
      throw new Error(
        "Cannot read fontFile. Set a valid font or disable watermark.",
      );
    });
  }
  if (config.encoder === "vaapi")
    await fs
      .access(config.vaapiDevice, constants.R_OK | constants.W_OK)
      .catch(() => {
        throw new Error(
          "Cannot access vaapiDevice. Check device path and render-group permissions.",
        );
      });
  return [
    `Node ${process.version}`,
    version.stdout.split(/\r?\n/)[0],
    `yt-dlp ${yt.stdout.trim()}`,
    `Encoder: ${requiredEncoder}`,
  ];
}

module.exports = { preflight };
