# Twitch2Discord

Play Twitch streams in a Discord voice channel. Choose your streamers in
`config.json`, highest priority first. Listeners can suggest streams and vote;
moderators can switch streams directly.

**Account limitation:** this uses a Discord user account, not a bot token.
[Discord prohibits selfbots](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
and may terminate the account.

## Set up on Linux

**Start with [config.example.json](config.example.json).** Copy it to
`config.json` using the command below, then fill in your own values. The real
config is intentionally not included because it contains your account credential.

Use **Node.js 22.12 or newer** (Node 22 or 24 LTS recommended), FFmpeg and yt-dlp.
Install Node from [nodejs.org](https://nodejs.org/en/download) if your distribution
provides an older version.

On Ubuntu/Debian:

If already logged in as root, omit `sudo`. Root-managed servers can use the
[system service setup](docs/linux.md#root-managed-servers-and-proxmox-guests).

```sh
sudo apt update
sudo apt install ffmpeg python3 python3-venv
```

Open a terminal in the cloned project folder, then:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade yt-dlp
npm ci
cp config.example.json config.json
chmod 600 config.json
```

Edit `config.json`. Set these five values:

- `token`: your Discord account credential. Keep it private.
- `guildId`: your server ID.
- `channelId`: the voice channel ID.
- `commandChannelId`: the text channel where commands will work.
- `streamers`: your Twitch usernames, in priority order.

Use Discord's Developer Mode → Copy ID to get IDs. Keep IDs in quotes.
The account needs View Channel, Connect, Speak and Video in voice, and
View Channel/Send Messages in the command channel.

Then run:

```sh
npm run config:check
npm run diagnose
npm start
```

Join the voice channel to check picture and sound. Stop with Ctrl+C.
For automatic startup and restart after failures, use the [Linux service guide](docs/linux.md).
Replacing an older installation? Follow [the upgrade steps](docs/linux.md#replace-an-older-installation)
to keep its GPU settings and a working rollback.

## Make it yours

The example config contains the common settings. Restart after editing it.

| Setting | What it changes |
| --- | --- |
| `streamers` | Channel names, highest priority first |
| `fallbackStreamer` | Optional last-choice channel; `null` disables it |
| `commandPrefix` | Change `t!` to your preferred prefix |
| `commands` | Rename commands or add aliases |
| `nowShowingChannelId` | Optional announcement channel |
| `height`, `fps`, `videoBitrate` | Picture quality and CPU/bandwidth use |
| `encoder` | `software` for CPU, `vaapi` for Intel/AMD, or `nvenc` for NVIDIA |
| `suggestionsEnabled` | Allow or disable listener suggestions |

Example: `"commands": { "play": ["watch", "play"] }` makes `t!watch` and
`t!play` do the same thing. Help automatically uses your chosen names.
See [all settings](docs/configuration.md) for voting, GPU and retry options.
That reference explains every supported config key, its default, and what it controls.

## NVIDIA GPU encoding

For an NVIDIA GPU with NVENC support, set these values in `config.json`:

```json
"encoder": "nvenc",
"nvencPreset": "p4",
"nvencGpu": 0
```

Merge these settings into the existing config. `nvencGpu` selects the GPU index;
presets range from `p1` (fastest) to `p7` (more quality/work). Install a compatible
NVIDIA driver and FFmpeg with `h264_nvenc`, then run `npm run diagnose` to test
encoding. Leave `hardwareAcceleratedDecoding` false initially. In a Proxmox guest,
the GPU must also be accessible inside that guest. See the
[GPU setup guide](docs/linux.md#nvidia) for details.

## Commands

Send `t!help` in the command channel. With the default names:

| Command | Action |
| --- | --- |
| `t!now` / `t!status` | Current stream and relay status |
| `t!priority` / `t!check` | Your channel list / who is live |
| `t!suggest <username>` | Suggest a stream while in voice |
| `t!yes` / `t!no` / `t!vote` | Vote or check the current vote |
| `t!play <username>` | Moderator: select a stream |
| `t!auto` | Moderator: return to the priority list |
| `t!cancel` / `t!restart` | Moderator: cancel a vote / retry playback |

Moderators need Manage Server or Administrator, or a configured moderator role.
Votes count current voice listeners; ties fail. If nothing is live, the relay
waits and checks again. Network errors do not immediately discard a selection.

## Update

Stop the relay, pull the new code, and run `npm ci`. Restart after checking any
changed settings. Update yt-dlp with `.venv/bin/python -m pip install --upgrade
yt-dlp`. Your ignored `config.json` is not replaced by Git updates.

## If something fails

Run `npm run diagnose`. It checks tools and native libraries without logging in.
FFmpeg needs H.264, Opus and the `azmq` filter for audio. For native install errors,
use Node 22/24 and rerun `npm ci` without disabling install scripts. Lower
`height` or `fps` if playback is too slow.

Validate Discord playback and the selected encoder on the deployment host before
enabling unattended operation. No VPN configuration is included. Automated test
and local encoding-check commands are in [CONTRIBUTING.md](CONTRIBUTING.md).

## AI assistance

Code, tests and documentation for this release were substantially developed with
AI assistance. Contributions and independent code review are welcome.

[MIT license](LICENSE) · [Security](SECURITY.md)
