"use strict";

const { twitchSource } = require("./config");
const { Votes } = require("./votes");
const HELP = {
  help: "Show commands",
  now: "Current stream",
  status: "Playback and vote status",
  priority: "Configured streamers, in order",
  check: "Check which streamers are live",
  suggest: "<channel> — Suggest a stream",
  yes: "Vote yes",
  no: "Vote no",
  vote: "Current vote",
  play: "<channel> — Play a stream (moderator)",
  auto: "Use the priority list (moderator)",
  cancel: "Cancel a vote or pending selection (moderator)",
  restart: "Retry playback (moderator)",
};

class Commands {
  constructor(config, client, guild, voice, relay, twitch, log) {
    Object.assign(this, { config, client, guild, voice, relay, twitch, log });
    this.closed = false;
    this.pendingSuggestion = false;
    this.request = 0;
    this.checking = false;
    this.monitoring = false;
    this.lastCheck = 0;
    this.cooldowns = new Map();
    this.prompted = new Set();
    this.lookup = new AbortController();
    this.aliases = new Map(
      Object.entries(config.commands).flatMap(([key, names]) =>
        names.map((name) => [name, key]),
      ),
    );
    this.votes = new Votes(
      config,
      () => this.members(),
      (vote, approved, counts) => this.finishVote(vote, approved, counts),
    );
    this.onSelection = () => {
      this.request++;
      this.votes.clear();
      this.lookup.abort();
      this.lookup = new AbortController();
      this.prompted.clear();
    };
    relay.on("selection", this.onSelection);
    this.onEnded = (source) => {
      void this.say(
        this.defaultChannel(),
        `${source.name} is offline. Back to the priority list.`,
      );
    };
    relay.on("overrideEnded", this.onEnded);
    this.lastAnnouncement = null;
    this.onPlaying = (source) => {
      if (!config.nowShowingChannelId || this.lastAnnouncement === source.id)
        return;
      this.lastAnnouncement = source.id;
      void this.say(
        guild.channels.cache.get(config.nowShowingChannelId),
        `Now playing: **${source.name}**\n${source.url}\nWatch: https://discord.com/channels/${config.guildId}/${config.channelId}`,
      ).then((sent) => {
        if (!sent && this.lastAnnouncement === source.id)
          this.lastAnnouncement = null;
      });
    };
    relay.on("playing", this.onPlaying);
  }

  usage(key) {
    return `${this.config.commandPrefix}${this.config.commands[key][0]}`;
  }
  defaultChannel() {
    return (
      this.guild.channels.cache.get(this.config.commandChannelId) ||
      this.lastChannel
    );
  }
  members() {
    return new Set(
      [...this.voice.members.values()]
        .filter((m) => !m.user?.bot && m.id !== this.client.user.id)
        .map((m) => m.id),
    );
  }
  moderator(message) {
    return (
      message.author.id === this.guild.ownerId ||
      this.config.moderatorUserIds.includes(message.author.id) ||
      this.config.moderatorRoleIds.some((id) =>
        message.member?.roles?.cache?.has(id),
      ) ||
      Boolean(
        message.member?.permissions?.has("ADMINISTRATOR") ||
        message.member?.permissions?.has("MANAGE_GUILD"),
      )
    );
  }

  async say(channel, text) {
    if (this.closed || !channel?.send) return false;
    let timer;
    try {
      await Promise.race([
        channel.send({
          content: text.slice(0, 2000),
          allowedMentions: { parse: [], repliedUser: false },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Message send timed out")),
            10000,
          );
        }),
      ]);
      return true;
    } catch (error) {
      this.log.warn(`Message failed: ${error.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  startVote(kind, source, channel, requesterId) {
    const vote = this.votes.start({
      kind,
      source,
      channel,
      requesterId,
      generation: this.relay.generation,
    });
    if (!vote)
      return this.say(
        channel,
        `A vote is already open. Use ${this.usage("vote")}.`,
      );
    const action =
      kind === "auto"
        ? "Return to the priority list?"
        : `Switch to **${source.name}**?`;
    return this.say(
      channel,
      `${action} ${this.usage("yes")} / ${this.usage("no")} — ${Math.ceil(this.config.voteDurationMs / 1000)} seconds. Only current voice listeners count.`,
    );
  }

  finishVote(vote, approved, counts) {
    if (this.closed || vote.generation !== this.relay.generation) return;
    if (approved)
      this.relay.change(
        vote.kind === "auto" ? null : vote.source,
        "vote passed",
      );
    void this.say(
      vote.channel,
      `${approved ? "Vote passed." : "Vote did not pass."} ${counts.yes} yes, ${counts.no} no.${approved ? (vote.kind === "auto" ? " Back to the priority list." : ` Switching to ${vote.source.name}.`) : ""}`,
    );
  }

  async suggest(message, argument) {
    const { config, relay } = this;
    if (!config.suggestionsEnabled)
      return this.say(message.channel, "Suggestions are disabled.");
    if (
      config.suggestionsRequireVoice &&
      !this.members().has(message.author.id)
    )
      return this.say(
        message.channel,
        "Join the voice channel to suggest a stream.",
      );
    if (this.pendingSuggestion || this.votes.active)
      return this.say(
        message.channel,
        "A suggestion or vote is already in progress.",
      );
    const source = twitchSource(argument);
    if (!source)
      return this.say(
        message.channel,
        `Usage: ${this.usage("suggest")} <Twitch channel>`,
      );
    if (source.id === relay.current?.id || source.id === relay.override?.id)
      return this.say(message.channel, `${source.name} is already selected.`);
    const now = Date.now();
    for (const [id, until] of this.cooldowns)
      if (until <= now) this.cooldowns.delete(id);
    const wait = Math.max(
      (this.cooldowns.get(message.author.id) || 0) - now,
      relay.lastSwitchAt + config.switchCooldownMs - now,
    );
    if (wait > 0)
      return this.say(
        message.channel,
        `Try again in ${Math.ceil(wait / 1000)} seconds.`,
      );
    if (this.cooldowns.size >= 1000)
      return this.say(message.channel, "Too many requests. Try again later.");
    this.cooldowns.set(message.author.id, now + config.suggestionCooldownMs);
    this.pendingSuggestion = true;
    const request = this.request;
    const generation = relay.generation;
    try {
      const state = await this.twitch.check(source, this.lookup.signal);
      if (
        this.closed ||
        request !== this.request ||
        generation !== relay.generation
      )
        return;
      if (state !== "online")
        return this.say(
          message.channel,
          state === "offline"
            ? `${source.name} is offline.`
            : "Could not check Twitch. Try again later.",
        );
      if (
        config.suggestionsRequireVoice &&
        !this.members().has(message.author.id)
      )
        return this.say(
          message.channel,
          "You left the voice channel. Suggest again after joining.",
        );
      if (!this.members().size) {
        if (!config.allowEmptyVoiceSwitch)
          return this.say(
            message.channel,
            "No listeners are in voice to vote.",
          );
        relay.change(source, "suggestion while voice is empty");
        return this.say(message.channel, `Switching to ${source.name}.`);
      }
      return this.startVote(
        "custom",
        source,
        message.channel,
        message.author.id,
      );
    } catch (error) {
      if (request === this.request && !this.closed) this.log.warn(error);
    } finally {
      this.pendingSuggestion = false;
    }
  }

  async check(channel) {
    if (this.checking) return this.say(channel, "A check is already running.");
    const remaining =
      this.config.priorityCheckCooldownMs - (Date.now() - this.lastCheck);
    if (remaining > 0)
      return this.say(
        channel,
        `Try again in ${Math.ceil(remaining / 1000)} seconds.`,
      );
    this.checking = true;
    this.lastCheck = Date.now();
    try {
      const states = await this.twitch.availability(
        this.config.sources,
        this.lookup.signal,
      );
      return this.say(
        channel,
        states
          .map(
            ({ source, state }) =>
              `${source.priority}. ${source.name}: ${state}`,
          )
          .join("\n"),
      );
    } catch (error) {
      if (!this.closed) this.log.warn(error);
    } finally {
      this.checking = false;
    }
  }

  async handle(message) {
    if (
      this.closed ||
      message.guild?.id !== this.config.guildId ||
      message.author.bot ||
      message.author.id === this.client.user.id
    )
      return;
    if (
      this.config.commandChannelId &&
      message.channel.id !== this.config.commandChannelId
    )
      return;
    const content = String(message.content || "").trim();
    if (
      !content.toLowerCase().startsWith(this.config.commandPrefix.toLowerCase())
    )
      return;
    this.lastChannel = message.channel;
    const [name = "", ...args] = content
      .slice(this.config.commandPrefix.length)
      .trim()
      .split(/\s+/);
    const command = this.aliases.get(name.toLowerCase());
    const argument = args.join(" ");
    const reply = (text) => this.say(message.channel, text);
    if (!command) return reply(`Unknown command. Use ${this.usage("help")}.`);
    if (command === "help")
      return reply(
        Object.entries(HELP)
          .filter(
            ([key]) => this.config.suggestionsEnabled || key !== "suggest",
          )
          .map(([key, description]) => `${this.usage(key)} — ${description}`)
          .join("\n"),
      );
    if (command === "now")
      return reply(
        this.relay.current
          ? `${this.relay.state}: **${this.relay.current.name}**`
          : "Nothing is playing.",
      );
    if (command === "status")
      return reply(
        `Playback: ${this.relay.state}${this.relay.current ? ` (${this.relay.current.name})` : ""}\nSelection: ${this.relay.override?.name || "priority list"}\nListeners: ${this.members().size}\nVote: ${this.votes.active ? "open" : "none"}`,
      );
    if (command === "priority")
      return reply(
        this.config.sources.map((s) => `${s.priority}. ${s.name}`).join("\n"),
      );
    if (command === "check") return this.check(message.channel);
    if (command === "suggest") return this.suggest(message, argument);
    if (command === "vote") {
      const vote = this.votes.active;
      if (!vote) return reply("No vote is open.");
      const counts = this.votes.counts();
      return reply(
        `${vote.kind === "auto" ? "Priority list" : vote.source.name}: ${counts.yes} yes, ${counts.no} no. ${Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 1000))} seconds left.`,
      );
    }
    if (command === "yes" || command === "no") {
      if (!this.votes.active) return reply("No vote is open.");
      const counts = this.votes.cast(message.author.id, command);
      return reply(
        counts
          ? `Vote recorded: ${command}.`
          : "Join the voice channel to vote.",
      );
    }
    if (!this.moderator(message))
      return reply(
        "This command needs Manage Server permission or a configured moderator role.",
      );
    this.request++;
    this.lookup.abort();
    this.lookup = new AbortController();
    this.votes.clear();
    if (command === "cancel")
      return reply("Pending selection and vote cancelled.");
    if (command === "auto") {
      this.relay.change(null);
      return reply("Using the priority list.");
    }
    if (command === "restart") {
      this.relay.failedUntil.clear();
      this.relay.interrupt();
      return reply("Retrying playback.");
    }
    if (command === "play") {
      const source = twitchSource(argument);
      if (!source)
        return reply(`Usage: ${this.usage("play")} <Twitch channel>`);
      const request = this.request;
      const generation = this.relay.generation;
      try {
        const state = await this.twitch.check(source, this.lookup.signal);
        if (
          request !== this.request ||
          generation !== this.relay.generation ||
          this.closed
        )
          return;
        if (state !== "online")
          return reply(
            state === "offline"
              ? `${source.name} is offline.`
              : "Could not check Twitch. Try again later.",
          );
        this.relay.change(source, "moderator selection");
        return reply(`Switching to ${source.name}.`);
      } catch (error) {
        if (request === this.request && !this.closed) this.log.warn(error);
      }
    }
  }

  async monitor() {
    if (this.closed || this.monitoring || this.relay.state !== "playing")
      return;
    this.monitoring = true;
    const generation = this.relay.generation;
    try {
      const states = await this.twitch.availability(
        this.config.sources,
        this.lookup.signal,
      );
      if (
        this.closed ||
        generation !== this.relay.generation ||
        this.relay.state !== "playing"
      )
        return;
      for (const { source, state } of states)
        if (state === "offline") this.prompted.delete(source.id);
      const top = states.find(
        (entry) =>
          entry.state === "online" && this.relay.available(entry.source),
      )?.source;
      if (!top || top.id === this.relay.current?.id) return;
      if (this.relay.override) {
        if (this.config.returnToPriority === "stay") return;
        if (this.config.returnToPriority === "automatic") {
          this.relay.change(null, "priority stream online");
          return;
        }
        if (
          !this.votes.active &&
          !this.pendingSuggestion &&
          this.members().size &&
          !this.prompted.has(top.id) &&
          this.defaultChannel()?.send
        ) {
          this.prompted.add(top.id);
          await this.startVote("auto", top, this.defaultChannel(), null);
        }
      } else {
        const current = states.find(
          (entry) => entry.source.id === this.relay.current?.id,
        );
        if (
          top.priority < (this.relay.current?.priority || Infinity) ||
          current?.state === "offline"
        )
          this.relay.interrupt("priority changed");
      }
    } catch (error) {
      if (!this.closed && generation === this.relay.generation)
        this.log.warn(error);
    } finally {
      this.monitoring = false;
    }
  }

  close() {
    this.closed = true;
    this.lookup.abort();
    this.votes.clear();
    this.relay.off("selection", this.onSelection);
    this.relay.off("overrideEnded", this.onEnded);
    this.relay.off("playing", this.onPlaying);
  }
}

module.exports = { Commands };
