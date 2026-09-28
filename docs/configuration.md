# Settings

Edit `config.json`, then restart. Omitted settings use the defaults below.
Run `npm run config:check` to catch mistakes. Unknown keys are rejected.
Use `npm start -- --config /absolute/path/config.json` for a different file.

## Channels and commands

| Setting | Default / purpose |
| --- | --- |
| `token` | Required credential; `DISCORD_TOKEN` can override it for foreground runs |
| `guildId`, `channelId` | Required server and voice-channel IDs, in quotes |
| `commandChannelId` | Text channel ID; `null` accepts commands in any server channel |
| `nowShowingChannelId` | `null`; set a text channel ID to announce stream changes |
| `streamers` | Required list of 1–30 usernames or Twitch channel URLs, highest priority first |
| `fallbackStreamer` | `null`; optional last-choice channel, checked normally |
| `commandPrefix` | `"t!"`; text before a command, such as `!` for `!help`; 1–10 non-space characters |
| `commands` | An action's names/aliases; see below |
| `moderatorRoleIds`, `moderatorUserIds` | `[]`; extra moderators, using quoted IDs |

No duplicate streamers are allowed. Owners and members with Manage Server or
Administrator permission are always moderators. Announcements indicate encoder
activity, not confirmation that a viewer received the stream.

To rename a command, add or edit its list in `commands`:

```json
"commands": {
  "play": ["watch", "play"],
  "priority": ["channels"]
}
```

The first alias is shown in help. Omitted actions keep their defaults. Action
keys: `help`, `now`, `status`, `priority`, `check`, `suggest`, `yes`, `no`, `vote`,
`play`, `auto`, `cancel`, `restart`. Aliases must be unique lowercase names,
starting with a letter; digits and hyphens are allowed. Lists cannot be empty.

## Picture, sound and tools

| Setting | Default / purpose |
| --- | --- |
| `encoder` | `"software"` for CPU; `"vaapi"` for supported Intel/AMD GPUs; `"nvenc"` for supported NVIDIA GPUs |
| `nvencPreset` | `"p4"`; NVIDIA encoding preset, `p1` (fastest) through `p7` (more quality/work); only used with nvenc |
| `nvencGpu` | `0`; nonnegative integer selecting the NVIDIA GPU index; only used with nvenc |
| `softwarePreset` | `"superfast"`; faster presets use less CPU; only used with software encoding |
| `vaapiDevice` | `"/dev/dri/renderD128"`; GPU render device used by VAAPI; ignored by software encoding |
| `height` | `720`; output picture height in pixels; even number, 144–2160; width preserves aspect ratio |
| `fps` | `30`; output frames per second, 1–60; higher values increase encoding work |
| `videoBitrate` | `3500` kbit/s; target video data rate; higher values use more bandwidth |
| `videoBitrateMax` | `4500` kbit/s; video rate ceiling, at least videoBitrate and at most 50000 |
| `audioBitrate` | `128` kbit/s; audio quality/data rate, 1–512 |
| `includeAudio` | `true`; set false for video without sound |
| `hardwareAcceleratedDecoding` | `false`; ask FFmpeg to use hardware to decode the source, reducing CPU work on supported systems; independent of the encoder setting |
| `watermark` | `false`; draws the Twitch username |
| `fontFile` | `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`; font used for the watermark; ignored when watermark is off |
| `ytDlpPath` | `"yt-dlp"`; executable that checks Twitch and finds playback URLs; the example uses `".venv/bin/yt-dlp"` |
| `ffmpegPath` | `"ffmpeg"`; executable that encodes picture and sound; use an absolute path for a custom installation |
| `twitchFormat` | `"best[height<=1080]/best"`; source-quality selector: prefer up to 1080p, otherwise best available; separate from output height; must produce one combined video/audio URL |

Paths are literal: do not put `~` or `$HOME` in JSON. Relative executable paths
are relative to the working directory, normally the project folder. Watermarks
need a readable font and FFmpeg's drawtext filter. Software presets range from
`ultrafast` to `veryslow`; use `superfast` or `veryfast` as a starting point.

## Suggestions and votes

| Setting | Default / purpose |
| --- | --- |
| `suggestionsEnabled` | `true`; allow listeners to propose streams with the suggest command; does not disable moderator play |
| `suggestionsRequireVoice` | `true`; requester must be in the relay's voice channel to suggest a stream |
| `allowEmptyVoiceSwitch` | `false`; allow suggestions without a vote in empty voice |
| `returnToPriority` | `"vote"`; ask listeners before leaving a custom stream for an available priority streamer; `"automatic"` switches without voting; `"stay"` keeps the custom stream |
| `voteDurationMs` | `60000` (60 seconds); voting deadline, at least 1000; can finish sooner when everyone eligible has voted |
| `voteMinimumYes` | `1`; yes must also exceed no |
| `suggestionCooldownMs` | `300000` (5 minutes); wait between one user's suggestions, including unsuccessful availability checks |
| `switchCooldownMs` | `60000`; delay before suggestions after a switch |
| `priorityCheckCooldownMs` | `60000`; shared limit for availability commands |

Durations are milliseconds. Cooldowns can be `0` to disable them. Empty-voice
switching also requires `suggestionsRequireVoice: false`. Votes count listeners
still in voice when they finish. Votes and custom selections reset on restart.

## Advanced reliability settings

The defaults are suitable for most setups.

| Setting | Default / purpose |
| --- | --- |
| `pollIntervalMs` | `30000`; base idle/retry wait |
| `priorityPollIntervalMs` | `60000`; priority checks while playing |
| `probeTimeoutMs` | `20000`; maximum time for one Twitch availability lookup |
| `resolveTimeoutMs` | `30000`; maximum time to obtain a playable stream URL |
| `probeCacheMs` | `15000`; must be shorter than pollIntervalMs; `0` disables caching |
| `probeConcurrency` | `3`; maximum simultaneous lookups, 1–8 |
| `retryMaxMs` | `120000`; ceiling as repeated failures increase the retry delay; at least pollIntervalMs |
| `failedSourceCooldownMs` | `120000`; pause retrying failed automatic sources |
| `offlineConfirmations` | `2`; consecutive offline checks before clearing a selection |
| `watchdogMinimumSpeed` | `0.9`; minimum sustained encoding speed relative to real time; 1 means keeping up exactly; greater than 0 and at most 1 |
| `watchdogSlowWindowMs` | `180000`; allowed time below minimum speed |
| `watchdogStallWindowMs` | `60000`; allowed time without advancing frames |
| `shutdownTimeoutMs` | `8000`; cleanup deadline, maximum 30000 |

Unknown availability preserves a custom selection. Failed streams retry with
backoff. An encoder that cannot be stopped causes the process to exit so the
service can restart it. The relay never configures routing, firewall or VPNs.

Polling intervals, lookup timeouts and watchdog windows must be at least 1000 ms.
With `commandChannelId: null`, automatic vote prompts use the most recent command
channel; set an explicit channel if you want them to work before anyone sends a command.
The fallback does not trigger a vote to interrupt a custom stream. Custom streams
that are confirmed offline return to the priority list even with `returnToPriority: "stay"`.
