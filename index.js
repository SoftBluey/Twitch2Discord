"use strict";

const { loadConfig } = require("./src/config");
const { preflight } = require("./src/preflight");
const { createLogger } = require("./src/log");
const { Twitch } = require("./src/twitch");
const { Relay } = require("./src/relay");
const { Media, settledWithin } = require("./src/media");
const { Commands } = require("./src/commands");

async function main() {
  const args = process.argv.slice(2);
  let filename;
  for (let i = 0; i < args.length; i++) {
    if (!["--config", "--check-config", "--diagnose"].includes(args[i]))
      throw new Error(`Unknown argument: ${args[i]}`);
    if (args[i] === "--config") {
      filename = args[++i];
      if (!filename || filename.startsWith("--"))
        throw new Error("--config requires a path");
    }
  }
  const config = loadConfig(filename);
  const log = createLogger(config.token);
  if (args.includes("--check-config")) {
    log.info(
      "Configuration is valid. Credentials and channel access were not tested.",
    );
    return;
  }
  if (
    !args.includes("--diagnose") &&
    (!config.token || config.token === "PUT_NEW_TOKEN_HERE")
  )
    throw new Error(
      "Set token in your private config.json or set DISCORD_TOKEN.",
    );
  for (const line of await preflight(config)) log.info(line);
  process.env.FFMPEG_PATH = config.ffmpegPath;
  let api;
  try {
    api = await import("@dank074/discord-video-stream");
  } catch {
    throw new Error(
      "Streaming library failed to load. Run npm ci with install scripts enabled on a supported Node/Linux platform.",
    );
  }
  if (args.includes("--diagnose")) {
    log.info(
      "Native streaming library loaded. No account login or network playback attempted.",
    );
    return;
  }
  const { Client } = require("@lng2004/discord.js-selfbot-v13");
  const client = new Client({ checkUpdate: false });
  const twitch = new Twitch(config);
  let streamer, relay, commands, priorityTimer, loop;
  let closing = false;
  async function shutdown(reason, code = 0) {
    if (closing) return;
    closing = true;
    log.info(`Stopping: ${reason}`);
    clearInterval(priorityTimer);
    commands?.close();
    relay?.stop();
    twitch.close();
    const cleanup = (async () => {
      try {
        await Promise.resolve(streamer?.leaveVoice());
      } catch {}
      try {
        await Promise.resolve(client.destroy());
      } catch {}
      await loop?.catch(() => {});
    })();
    const stopped = await settledWithin(cleanup, config.shutdownTimeoutMs);
    process.exit(stopped ? code : 1);
  }
  const fatal = (error) => {
    log.error(error);
    void shutdown("fatal error", 1);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  client.on("error", (error) => log.error(error));
  client.on("invalidated", () => {
    void shutdown("Discord session invalidated", 1);
  });
  client.on("shardDisconnect", () => {
    void shutdown("Discord disconnected", 1);
  });
  client.on("voiceStateUpdate", (_before, after) => {
    if (
      relay &&
      after.id === client.user.id &&
      after.channelId !== config.channelId
    ) {
      void shutdown("Relay left the configured voice channel", 1);
    }
  });
  client.on("messageCreate", (message) => {
    void commands?.handle(message).catch((error) => log.warn(error));
  });
  client.once("ready", () => {
    void (async () => {
      const guild = client.guilds.cache.get(config.guildId);
      const voice = guild?.channels.cache.get(config.channelId);
      if (!guild || voice?.type !== "GUILD_VOICE")
        throw new Error("Configured server or voice channel was not found.");
      for (const id of [
        config.commandChannelId,
        config.nowShowingChannelId,
      ].filter(Boolean)) {
        const channel = guild.channels.cache.get(id);
        if (
          !channel?.send ||
          !channel
            .permissionsFor(client.user)
            ?.has(["VIEW_CHANNEL", "SEND_MESSAGES"])
        )
          throw new Error(
            "A configured text channel is missing or not writable.",
          );
      }
      if (
        !voice
          .permissionsFor(client.user)
          ?.has(["VIEW_CHANNEL", "CONNECT", "SPEAK", "STREAM"])
      )
        throw new Error(
          "Voice channel needs View Channel, Connect, Speak and Video permissions.",
        );
      streamer = new api.Streamer(client);
      const join = streamer.joinVoice(config.guildId, config.channelId);
      if (!(await settledWithin(join, 30000)))
        throw new Error("Voice connection timed out.");
      await join;
      if (closing || !streamer.voiceConnection)
        throw new Error("Voice connection failed.");
      relay = new Relay(
        config,
        twitch,
        new Media(api, streamer, config, log),
        log,
      );
      commands = new Commands(config, client, guild, voice, relay, twitch, log);
      priorityTimer = setInterval(() => {
        void commands.monitor().catch(fatal);
      }, config.priorityPollIntervalMs);
      log.info("Relay ready.");
      loop = relay.run();
      await loop;
    })().catch(fatal);
  });
  const login = client.login(config.token);
  if (!(await settledWithin(login, 60000))) {
    await shutdown("Discord login timed out", 1);
    return;
  }
  await login.catch(fatal);
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
