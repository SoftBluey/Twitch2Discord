"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMMANDS = {
  help: ["help"],
  now: ["now"],
  status: ["status"],
  suggest: ["suggest"],
  yes: ["yes"],
  no: ["no"],
  vote: ["vote"],
  priority: ["priority", "priorities"],
  check: ["check", "checkpriority", "checkpriorities"],
  play: ["play"],
  auto: ["auto"],
  cancel: ["cancel"],
  restart: ["restart"],
};

const DEFAULTS = {
  token: "",
  guildId: "",
  channelId: "",
  commandChannelId: null,
  nowShowingChannelId: null,
  commandPrefix: "t!",
  streamers: [],
  fallbackStreamer: null,
  encoder: "software",
  vaapiDevice: "/dev/dri/renderD128",
  softwarePreset: "superfast",
  nvencPreset: "p4",
  nvencGpu: 0,
  height: 720,
  fps: 30,
  videoBitrate: 3500,
  videoBitrateMax: 4500,
  audioBitrate: 128,
  includeAudio: true,
  hardwareAcceleratedDecoding: false,
  watermark: false,
  fontFile: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  twitchFormat: "best[height<=1080]/best",
  ytDlpPath: "yt-dlp",
  ffmpegPath: "ffmpeg",
  pollIntervalMs: 30000,
  priorityPollIntervalMs: 60000,
  probeTimeoutMs: 20000,
  resolveTimeoutMs: 30000,
  probeCacheMs: 15000,
  probeConcurrency: 3,
  retryMaxMs: 120000,
  failedSourceCooldownMs: 120000,
  offlineConfirmations: 2,
  voteDurationMs: 60000,
  voteMinimumYes: 1,
  suggestionCooldownMs: 300000,
  switchCooldownMs: 60000,
  priorityCheckCooldownMs: 60000,
  suggestionsEnabled: true,
  suggestionsRequireVoice: true,
  allowEmptyVoiceSwitch: false,
  returnToPriority: "vote",
  moderatorRoleIds: [],
  moderatorUserIds: [],
  watchdogMinimumSpeed: 0.9,
  watchdogSlowWindowMs: 180000,
  watchdogStallWindowMs: 60000,
  shutdownTimeoutMs: 8000,
  commands: COMMANDS,
};

function twitchSource(input) {
  if (typeof input !== "string") return null;
  let name = input.trim().replace(/^@/, "");
  if (/^https?:\/\//i.test(name)) {
    try {
      const url = new URL(name);
      if (
        !["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(
          url.hostname.toLowerCase(),
        ) ||
        url.username ||
        url.password ||
        url.port ||
        !/^\/[a-z0-9_]+\/?$/i.test(url.pathname)
      )
        return null;
      name = url.pathname.replaceAll("/", "");
    } catch {
      return null;
    }
  }
  if (!/^[a-z0-9_]{1,25}$/i.test(name)) return null;
  name = name.toLowerCase();
  if (
    ["videos", "directory", "downloads", "settings", "subscriptions"].includes(
      name,
    )
  )
    return null;
  return { id: name, name, label: name, url: `https://www.twitch.tv/${name}` };
}

function validateConfig(raw, env = process.env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Configuration must be a JSON object.");
  const unknown = Object.keys(raw).filter(
    (key) => !Object.hasOwn(DEFAULTS, key),
  );
  if (unknown.length)
    throw new Error(
      `Unknown configuration keys: ${unknown.join(", ")}. See docs/configuration.md for migration.`,
    );
  const c = { ...DEFAULTS, ...raw, commands: { ...COMMANDS, ...raw.commands } };
  c.token = env.DISCORD_TOKEN || c.token;
  const fail = (message) => {
    throw new Error(`Configuration: ${message}`);
  };
  for (const key of [
    "guildId",
    "channelId",
    "commandChannelId",
    "nowShowingChannelId",
  ]) {
    if (c[key] === null && key !== "guildId" && key !== "channelId") continue;
    if (typeof c[key] !== "string" || !/^\d{17,20}$/.test(c[key]))
      fail(
        `${key} must be a Discord ID in quotes${key.includes("Channel") ? " or null" : ""}.`,
      );
  }
  if (typeof c.token !== "string") fail("token must be a string.");
  if (
    typeof c.commandPrefix !== "string" ||
    !/^\S{1,10}$/.test(c.commandPrefix)
  )
    fail("commandPrefix must contain 1–10 non-space characters.");
  if (
    !Array.isArray(c.streamers) ||
    !c.streamers.length ||
    c.streamers.length > 30
  )
    fail(
      "streamers must contain 1–30 Twitch usernames or channel URLs, in priority order.",
    );
  const sources = c.streamers.map((item, index) => {
    const source = twitchSource(item);
    if (!source) fail(`streamers[${index}] is not a Twitch channel.`);
    return { ...source, priority: index + 1 };
  });
  if (c.fallbackStreamer !== null) {
    const fallback = twitchSource(c.fallbackStreamer);
    if (!fallback) fail("fallbackStreamer must be a Twitch channel or null.");
    sources.push({ ...fallback, priority: sources.length + 1, fallback: true });
  }
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    fail("streamers and fallbackStreamer must not contain duplicates.");
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (typeof value === "boolean" && typeof c[key] !== "boolean")
      fail(`${key} must be true or false.`);
    if (typeof value === "number") {
      const zeroAllowed = [
        "suggestionCooldownMs",
        "switchCooldownMs",
        "priorityCheckCooldownMs",
        "probeCacheMs",
        "nvencGpu",
      ].includes(key);
      if (
        typeof c[key] !== "number" ||
        !Number.isFinite(c[key]) ||
        (c[key] < (zeroAllowed ? 0 : 1) && key !== "watchdogMinimumSpeed")
      )
        fail(`${key} is outside its allowed range.`);
      if (key !== "watchdogMinimumSpeed" && !Number.isSafeInteger(c[key]))
        fail(`${key} must be an integer.`);
      if (key.endsWith("Ms") && c[key] > 2147483647)
        fail(`${key} exceeds the timer limit.`);
    }
  }
  for (const key of [
    "pollIntervalMs",
    "priorityPollIntervalMs",
    "probeTimeoutMs",
    "resolveTimeoutMs",
    "watchdogStallWindowMs",
    "watchdogSlowWindowMs",
  ]) {
    if (c[key] < 1000) fail(`${key} must be at least 1000.`);
  }
  if (c.voteDurationMs < 1000 || c.shutdownTimeoutMs > 30000)
    fail("voteDurationMs must be >=1000 and shutdownTimeoutMs <=30000.");
  if (c.retryMaxMs < c.pollIntervalMs)
    fail("retryMaxMs must be at least pollIntervalMs.");
  if (c.probeCacheMs >= c.pollIntervalMs)
    fail("probeCacheMs must be shorter than pollIntervalMs.");
  if (c.height < 144 || c.height > 2160 || c.height % 2)
    fail("height must be an even number from 144 to 2160.");
  if (
    c.fps > 60 ||
    c.videoBitrateMax < c.videoBitrate ||
    c.videoBitrateMax > 50000 ||
    c.audioBitrate > 512
  )
    fail("invalid frame rate or bitrate.");
  if (c.watchdogMinimumSpeed <= 0 || c.watchdogMinimumSpeed > 1)
    fail("watchdogMinimumSpeed must be greater than 0 and at most 1.");
  if (c.probeConcurrency > 8 || c.offlineConfirmations > 10)
    fail("probeConcurrency must be <=8 and offlineConfirmations <=10.");
  if (!["software", "vaapi", "nvenc"].includes(c.encoder))
    fail("encoder must be software, vaapi or nvenc.");
  if (!/^p[1-7]$/.test(c.nvencPreset) || typeof c.nvencPreset !== "string")
    fail("nvencPreset must be p1 through p7.");
  if (
    ![
      "ultrafast",
      "superfast",
      "veryfast",
      "faster",
      "fast",
      "medium",
      "slow",
      "slower",
      "veryslow",
    ].includes(c.softwarePreset)
  )
    fail("unsupported softwarePreset.");
  if (!["vote", "stay", "automatic"].includes(c.returnToPriority))
    fail("returnToPriority must be vote, stay, or automatic.");
  for (const key of [
    "fontFile",
    "vaapiDevice",
    "ytDlpPath",
    "ffmpegPath",
    "twitchFormat",
  ]) {
    if (typeof c[key] !== "string" || !c[key].trim() || /[\r\n\0]/.test(c[key]))
      fail(`${key} must be a nonempty string without control characters.`);
  }
  for (const key of ["moderatorRoleIds", "moderatorUserIds"]) {
    if (
      !Array.isArray(c[key]) ||
      c[key].some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id))
    )
      fail(`${key} must be an array of quoted Discord IDs.`);
  }
  if (
    raw.commands !== undefined &&
    (!raw.commands ||
      typeof raw.commands !== "object" ||
      Array.isArray(raw.commands))
  )
    fail("commands must be an object.");
  const aliases = new Set();
  for (const [key, names] of Object.entries(c.commands)) {
    if (
      !Object.hasOwn(COMMANDS, key) ||
      !Array.isArray(names) ||
      !names.length ||
      names.some(
        (n) => typeof n !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(n),
      )
    )
      fail(
        `commands.${key} must be a nonempty array of lowercase command names.`,
      );
    for (const name of names) {
      if (aliases.has(name))
        fail(`command alias ${name} is used more than once.`);
      aliases.add(name);
    }
  }
  return { ...c, sources };
}

function loadConfig(
  filename = process.env.CONFIG_PATH ||
    path.resolve(__dirname, "..", "config.json"),
  env = process.env,
) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Config file not found. Copy config.example.json to config.json and edit it.",
      );
    // JSON parser errors can include the token's surrounding text.
    throw new Error(
      "Unable to read configuration. Check file permissions and JSON syntax.",
    );
  }
  return validateConfig(raw, env);
}

module.exports = {
  COMMANDS,
  DEFAULTS,
  twitchSource,
  validateConfig,
  loadConfig,
};
