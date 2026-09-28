"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { validateConfig, twitchSource } = require("../src/config");
const { Relay } = require("../src/relay");
const { Votes } = require("../src/votes");
const { Twitch } = require("../src/twitch");
const { Commands } = require("../src/commands");
const { Limiter, abortable } = require("../src/async");
const { Media, makeEncoder } = require("../src/media");
const { preflight } = require("../src/preflight");
const {
  serviceUnit,
  unitQuote,
  serviceOptions,
} = require("../scripts/service");

const silent = { info() {}, warn() {}, error() {} };
const config = (changes) =>
  validateConfig(
    {
      guildId: "111111111111111111",
      channelId: "222222222222222222",
      streamers: ["first", "second"],
      ...changes,
    },
    {},
  );
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("system installation supports root and optional accounts without ambiguous flags", () => {
  assert.deepEqual(serviceOptions(["--system"], 0), {
    system: true,
    user: "root",
  });
  assert.deepEqual(serviceOptions(["--system", "--user", "relay"], 0), {
    system: true,
    user: "relay",
  });
  assert.deepEqual(serviceOptions([], 1000), { system: false, user: null });
  for (const args of [
    ["--system", "--user"],
    ["--user", "root"],
    ["--system", "--user", "bad\nname"],
    ["--system", "extra"],
  ])
    assert.throws(() => serviceOptions(args, 0));
  assert.throws(() => serviceOptions(["--system"], 1000), /requires root/);
  assert.throws(() => serviceOptions([], 0), /--system/);
  const unit = serviceUnit("/opt/relay", "/usr/bin/node", "root");
  assert.match(unit, /User=root\n/);
  assert.match(unit, /WantedBy=multi-user.target/);
});

test("NVIDIA selection validates GPU and preset and preserves encoder filters", () => {
  for (const changes of [
    { nvencGpu: -1 },
    { nvencGpu: 0.5 },
    { nvencGpu: "0" },
    { nvencPreset: "p8" },
  ])
    assert.throws(() => config(changes));
  const c = config({
    encoder: "nvenc",
    nvencGpu: 2,
    nvencPreset: "p5",
    watermark: true,
  });
  const api = {
    Encoders: {
      nvenc: (options) => {
        assert.deepEqual(options, { gpu: 2, preset: "p5" });
        return () => ({
          H264: {
            name: "h264_nvenc",
            options: ["-gpu 2"],
            outFilters: ["format=yuv420p"],
          },
        });
      },
    },
  };
  const result = makeEncoder(api, c, twitchSource("first"))(3500, 4500).H264;
  assert.equal(result.name, "h264_nvenc");
  assert.match(result.outFilters[0], /drawtext/);
  assert.equal(result.outFilters[1], "format=yuv420p");
  assert.ok(result.options.includes("-gpu 2"));
});

test("NVENC diagnosis probes hardware and reports unavailable devices", async () => {
  let probed = false;
  const run = async (_, args) => {
    if (args.includes("-frames:v")) {
      probed = true;
      assert.equal(args[args.indexOf("-gpu") + 1], "2");
      return { stdout: "" };
    }
    return { stdout: "ffmpeg h264_nvenc libopus azmq" };
  };
  const c = config({ encoder: "nvenc", nvencGpu: 2 });
  await preflight(c, run);
  assert.equal(probed, true);
  await assert.rejects(
    preflight(c, async (file, args) => {
      if (args.includes("-frames:v")) throw new Error("driver unavailable");
      return run(file, args);
    }),
    /NVENC encoding check failed/,
  );
  await assert.rejects(
    preflight(c, async () => ({ stdout: "libx264" })),
    /missing h264_nvenc/,
  );
});

test("system service uses an explicit account and boot target without a user session", () => {
  const unit = serviceUnit("/opt/relay", "/usr/bin/node", "twitch2discord");
  assert.match(unit, /User=twitch2discord\n/);
  assert.match(unit, /WantedBy=multi-user.target/);
  assert.doesNotMatch(unit, /default.target|User=root/);
  assert.throws(() =>
    serviceUnit("/opt/relay", "/usr/bin/node", "bad\nUser=root"),
  );
});

test("configuration derives priority entirely from streamers array order", () => {
  const c = config({
    streamers: ["second", "https://twitch.tv/first", "backup"],
  });
  assert.deepEqual(
    c.sources.map((s) => [s.id, s.priority]),
    [
      ["second", 1],
      ["first", 2],
      ["backup", 3],
    ],
  );
  assert.equal(c.sources.at(-1).id, "backup");
  assert.equal(c.sources.at(-1).priority, c.sources.length);
  assert.equal(c.encoder, "software");
  assert.equal(c.nowShowingChannelId, null);
});

test("configuration rejects typos, duplicate aliases, IDs as numbers, and unsafe values", () => {
  for (const changes of [
    { streamers: [] },
    { streamers: ["first", "FIRST"] },
    { fps: -1 },
    { pollIntervalMs: 1 },
    { watchdogMinimumSpeed: -1 },
    { guildId: 111111111111111111 },
    { commands: { yes: ["no"] } },
    { unknown: true },
    { suggestionsEnabled: "false" },
    { height: 721 },
  ]) {
    assert.throws(() => config(changes));
  }
  assert.equal(config({ switchCooldownMs: 0 }).switchCooldownMs, 0);
});

test("targets only accept Twitch channels, never arbitrary URLs or arguments", () => {
  for (const input of [
    "https://evil.test/first",
    "https://twitch.tv.evil.test/first",
    "https://twitch.tv/videos/123",
    "--exec=x",
    "https://user:pass@twitch.tv/first",
    "first,drawtext=x",
  ])
    assert.equal(twitchSource(input), null);
  assert.equal(twitchSource("@First").id, "first");
});

test("stale URL lookup cannot override a newer selection", async () => {
  const lookup = deferred(),
    resolving = deferred();
  const c = config();
  const twitch = {
    check: async () => "online",
    availability: async () => [{ source: c.sources[0], state: "online" }],
    resolve: async (source) => {
      if (source.id === "first") {
        resolving.resolve();
        return lookup.promise;
      }
      return "https://example.invalid/new";
    },
  };
  const played = [];
  const relay = new Relay(
    c,
    twitch,
    {
      play: async (source) => {
        played.push(source.id);
        relay.stop();
      },
    },
    silent,
  );
  const loop = relay.run();
  await resolving.promise;
  relay.change(twitchSource("second"));
  lookup.resolve("https://example.invalid/old");
  await loop;
  assert.deepEqual(played, ["second"]);
  assert.equal(relay.current, null);
  assert.equal(relay.state, "stopped");
});

test("unknown availability preserves an override; consecutive offline checks clear it", async () => {
  let state = "unknown";
  const relay = new Relay(
    config(),
    { check: async () => state, availability: async () => [] },
    {},
    silent,
  );
  relay.change(twitchSource("first"));
  await relay.candidates(new AbortController().signal);
  assert.equal(relay.override.id, "first");
  state = "offline";
  await relay.candidates(new AbortController().signal);
  assert.equal(relay.override.id, "first");
  await relay.candidates(new AbortController().signal);
  assert.equal(relay.override, null);
});

test("votes count current listeners and ignore stale expiry callbacks", () => {
  let members = new Set(["a", "b"]);
  const finished = [];
  const votes = new Votes(
    config(),
    () => members,
    (...args) => finished.push(args),
  );
  const old = votes.start({ requesterId: "a" });
  votes.clear();
  const current = votes.start({ requesterId: "a" });
  votes.finish(old.id);
  assert.equal(votes.active.id, current.id);
  members = new Set(["b"]);
  votes.cast("b", "no");
  assert.equal(votes.active, null);
  assert.equal(finished[0][1], false);
  assert.deepEqual(finished[0][2], { yes: 0, no: 1, eligible: 1 });
});

test("Twitch distinguishes offline and infrastructure failures", async () => {
  let stderr = "ERROR: first is offline";
  const twitch = new Twitch(config({ probeCacheMs: 0 }), async () => {
    throw { stderr };
  });
  assert.equal(await twitch.check(twitchSource("first")), "offline");
  stderr = "HTTP Error 503: unavailable";
  assert.equal(await twitch.check(twitchSource("first")), "unknown");
  twitch.close();
});

test("concurrent probes share work and a cancelled consumer does not cancel another", async () => {
  const pending = deferred();
  let calls = 0;
  const twitch = new Twitch(config(), async () => {
    calls++;
    return pending.promise;
  });
  const controller = new AbortController();
  const a = twitch.check(twitchSource("first"), controller.signal);
  const b = twitch.check(twitchSource("first"));
  controller.abort();
  await assert.rejects(a, { name: "AbortError" });
  pending.resolve({ stdout: "" });
  assert.equal(await b, "online");
  assert.equal(calls, 1);
  twitch.close();
});

test("lookup limiter bounds concurrency and removes cancelled queued jobs", async () => {
  const gate = deferred();
  const limiter = new Limiter(1);
  const a = limiter.run(() => gate.promise);
  const controller = new AbortController();
  const b = limiter.run(
    () => assert.fail("cancelled job ran"),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(b, { name: "AbortError" });
  const c = limiter.run(async () => "next");
  gate.resolve();
  await a;
  assert.equal(await c, "next");
  assert.equal(limiter.active, 0);
});

test("an already cancelled caller still observes a late shared rejection", async () => {
  const pending = deferred(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(abortable(pending.promise, controller.signal), {
    name: "AbortError",
  });
  pending.reject(new Error("late network error"));
  await tick();
});

function commandFixture(
  changes = {},
  twitch = { check: async () => "online" },
) {
  const c = config(changes),
    sent = [];
  const channel = {
    id: "333333333333333333",
    async send(payload) {
      sent.push(payload);
    },
  };
  const guild = {
    id: c.guildId,
    ownerId: "owner",
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const voice = { members: new Map([["owner", { id: "owner", user: {} }]]) };
  const relay = new Relay(c, twitch, {}, silent);
  const commands = new Commands(
    c,
    { user: { id: "relay" } },
    guild,
    voice,
    relay,
    twitch,
    silent,
  );
  const message = (content) => ({
    content,
    channel,
    guild,
    author: { id: "owner" },
  });
  return { c, sent, channel, guild, voice, relay, commands, message };
}

test("custom aliases and prefix drive parsing, help, and priority output", async () => {
  const f = commandFixture({
    commandPrefix: "!",
    commands: { help: ["commands"], play: ["watch"] },
    streamers: ["second", "first"],
  });
  await f.commands.handle(f.message("!commands"));
  assert.match(f.sent[0].content, /!watch/);
  assert.doesNotMatch(f.sent[0].content, /t!/);
  await f.commands.handle(f.message("!priority"));
  assert.equal(f.sent[1].content, "1. second\n2. first");
  assert.deepEqual(f.sent[0].allowedMentions.parse, []);
  f.commands.close();
});

test("vote expiry during reply no longer throws or changes another vote", async () => {
  const f = commandFixture();
  f.commands.votes.start({
    kind: "custom",
    source: twitchSource("first"),
    channel: f.channel,
    generation: 0,
  });
  f.channel.send = async () => {
    f.commands.votes.clear();
  };
  await f.commands.handle(f.message("t!yes"));
  assert.equal(f.relay.override.id, "first");
  f.commands.close();
});

test("older moderator lookup cannot undo a later auto command", async () => {
  const gate = deferred();
  const f = commandFixture({}, { check: () => gate.promise });
  const pending = f.commands.handle(f.message("t!play first"));
  await f.commands.handle(f.message("t!auto"));
  gate.resolve("online");
  await pending;
  assert.equal(f.relay.override, null);
  assert.equal(
    f.sent.some((x) => x.content === "Switching to first."),
    false,
  );
  f.commands.close();
});

test("unsuccessful suggestions are rate limited before starting another lookup", async () => {
  let calls = 0;
  const f = commandFixture(
    {},
    {
      check: async () => {
        calls++;
        return "offline";
      },
    },
  );
  await f.commands.handle(f.message("t!suggest first"));
  await f.commands.handle(f.message("t!suggest second"));
  assert.equal(calls, 1);
  assert.match(f.sent.at(-1).content, /Try again/);
  f.commands.close();
});

test("priority monitoring does not overlap or demote a stream on unknown results", async () => {
  const gate = deferred();
  let calls = 0;
  const f = commandFixture(
    {},
    {
      availability: () => {
        calls++;
        return gate.promise;
      },
    },
  );
  f.relay.current = f.c.sources[0];
  f.relay.state = "playing";
  const pending = f.commands.monitor();
  await f.commands.monitor();
  gate.resolve([
    { source: f.c.sources[0], state: "unknown" },
    { source: f.c.sources[1], state: "online" },
  ]);
  await pending;
  assert.equal(calls, 1);
  assert.equal(f.relay.generation, 0);
  f.commands.close();
});

test("software encoder does not contain VAAPI options", () => {
  const api = {
    Encoders: {
      software: () => () => ({ H264: { name: "libx264", options: [] } }),
    },
  };
  const result = makeEncoder(
    api,
    config(),
    twitchSource("first"),
  )(3500, 4500).H264;
  assert.equal(result.name, "libx264");
  assert.equal(result.options.includes("-rc_mode"), false);
});

test("media cancellation kills encoder and awaits playback cleanup", async () => {
  const command = new EventEmitter(),
    playback = deferred(),
    encoding = deferred();
  let killed = 0,
    stopped = 0,
    destroyed = 0;
  encoding.promise.kill = () => {
    killed++;
    encoding.resolve();
    playback.resolve();
  };
  const api = {
    Encoders: { software: () => () => ({ H264: { name: "libx264" } }) },
    Utils: { normalizeVideoCodec: (x) => x },
    prepareStream: () => ({
      command,
      output: {
        destroy() {
          destroyed++;
        },
      },
      promise: encoding.promise,
    }),
    playStream: () => playback.promise,
  };
  const media = new Media(
    api,
    {
      stopStream() {
        stopped++;
      },
    },
    config(),
    silent,
  );
  const controller = new AbortController();
  const playing = media.play(
    twitchSource("first"),
    "https://example.invalid",
    controller.signal,
    () => {},
  );
  await tick();
  controller.abort();
  await playing;
  assert.ok(killed);
  assert.equal(stopped, 1);
  assert.equal(destroyed, 1);
});

test("preflight rejects missing audio filter before login", async () => {
  await assert.rejects(
    preflight(config(), async (_, args) => ({
      stdout: args.includes("-encoders") ? "libx264 libopus" : "ffmpeg",
    })),
    /azmq/,
  );
});

test("service installation generates quoted user paths without embedding credentials", () => {
  const unit = serviceUnit("/opt/my relay", "/opt/node/bin/node");
  assert.match(unit, /^WorkingDirectory=\/opt\/my relay$/m);
  assert.match(unit, /"\/opt\/my relay\/index.js"/);
  assert.match(
    serviceUnit("/opt/100%/$name", "/usr/bin/node"),
    /^WorkingDirectory=\/opt\/100%%\/\$name$/m,
  );
  for (const directory of [
    "relative",
    "/opt/relay\nUser=root",
    "/opt/relay ",
    "/opt/relay\\",
  ])
    assert.throws(() => serviceUnit(directory, "/usr/bin/node"));
  assert.match(unit, /Restart=on-failure/);
  assert.doesNotMatch(unit, /User=root|DISCORD_TOKEN|token=/);
  assert.equal(unitQuote("/tmp/100%/$name", true), '"/tmp/100%%/$$name"');
  assert.throws(() => unitQuote("/tmp/a\nExecStart=bad"));
});

test("v7 progress events mark playback active only once", async () => {
  const command = new EventEmitter();
  const encoding = deferred(),
    playback = deferred();
  encoding.promise.kill = () => {
    encoding.resolve();
    playback.resolve();
  };
  const api = {
    Encoders: { software: () => () => ({ H264: { name: "libx264" } }) },
    Utils: { normalizeVideoCodec: (x) => x },
    prepareStream: () => ({
      command,
      output: { destroy() {} },
      promise: encoding.promise,
    }),
    playStream: () => playback.promise,
  };
  const controller = new AbortController();
  let notifications = 0;
  const task = new Media(api, { stopStream() {} }, config(), silent).play(
    twitchSource("first"),
    "https://example.invalid",
    controller.signal,
    () => notifications++,
  );
  await tick();
  command.emit("progress", { frames: 0, timemark: 0 });
  assert.equal(notifications, 0);
  command.emit("progress", { frames: 30, timemark: 1 });
  command.emit("progress", { frames: 60, timemark: 2 });
  assert.equal(notifications, 1);
  controller.abort();
  await task;
});

test("shutdown during URL resolution never starts playback", async () => {
  const gate = deferred(),
    resolving = deferred();
  const c = config();
  const relay = new Relay(
    c,
    {
      availability: async () => [{ source: c.sources[0], state: "online" }],
      resolve: async () => {
        resolving.resolve();
        return gate.promise;
      },
    },
    { play: () => assert.fail("started after shutdown") },
    silent,
  );
  const loop = relay.run();
  await resolving.promise;
  relay.stop();
  gate.resolve("https://example.invalid");
  await loop;
  assert.equal(relay.state, "stopped");
});

test("failed automatic source yields to the next source and gets a cooldown", async () => {
  const c = config(),
    played = [];
  const relay = new Relay(
    c,
    {
      availability: async () =>
        c.sources.map((source) => ({ source, state: "online" })),
      resolve: async (source) => {
        if (source.id === "first") throw new Error("unavailable");
        return "https://example.invalid";
      },
    },
    {
      play: async (source) => {
        played.push(source.id);
        relay.stop();
      },
    },
    silent,
  );
  await relay.run();
  assert.deepEqual(played, ["second"]);
  assert.equal(relay.available(c.sources[0]), false);
});

test("a tied vote or an unmet minimum cannot pass", () => {
  const outcomes = [];
  const votes = new Votes(
    config({ voteMinimumYes: 2 }),
    () => new Set(["a", "b"]),
    (_, passed) => outcomes.push(passed),
  );
  let vote = votes.start({ requesterId: "a" });
  votes.finish(vote.id);
  vote = votes.start({ requesterId: "a" });
  votes.cast("b", "no");
  assert.deepEqual(outcomes, [false, false]);
});

test("commands reject other guilds, channels and unauthorized moderator requests", async () => {
  const f = commandFixture({ commandChannelId: "333333333333333333" });
  const wrongGuild = f.message("t!play first");
  wrongGuild.guild = { id: "other" };
  await f.commands.handle(wrongGuild);
  const wrongChannel = f.message("t!play first");
  wrongChannel.channel = { id: "other" };
  await f.commands.handle(wrongChannel);
  assert.equal(f.sent.length, 0);
  const nonModerator = f.message("t!play first");
  nonModerator.author = { id: "visitor" };
  await f.commands.handle(nonModerator);
  assert.match(f.sent[0].content, /permission/);
  assert.equal(f.relay.override, null);
  f.commands.close();
});

test("environment credential overrides the file without changing the file object", () => {
  const raw = {
    guildId: "111111111111111111",
    channelId: "222222222222222222",
    streamers: ["first"],
    token: "file-secret",
  };
  assert.equal(
    validateConfig(raw, { DISCORD_TOKEN: "environment-secret" }).token,
    "environment-secret",
  );
  assert.equal(raw.token, "file-secret");
});

test("playback that will not clean up is fatal instead of overlapping another stream", async () => {
  const command = new EventEmitter(),
    encoding = deferred(),
    playback = deferred();
  encoding.promise.kill = () => encoding.resolve();
  const api = {
    Encoders: { software: () => () => ({ H264: { name: "libx264" } }) },
    Utils: { normalizeVideoCodec: (x) => x },
    prepareStream: () => ({
      command,
      output: { destroy() {} },
      promise: encoding.promise,
    }),
    playStream: () => playback.promise,
  };
  const controller = new AbortController();
  const media = new Media(
    api,
    { stopStream() {} },
    config({ shutdownTimeoutMs: 10 }),
    silent,
  );
  const task = media.play(
    twitchSource("first"),
    "https://example.invalid",
    controller.signal,
    () => {},
  );
  await tick();
  controller.abort();
  await assert.rejects(task, (error) => error.fatal === true);
  playback.resolve();
});
