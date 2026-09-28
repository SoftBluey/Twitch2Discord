# Linux background service

Complete the README setup and check playback first. Keep the clone in a stable
location, such as `/opt/twitch2discord`. Use a user service for a normal login,
or the root-managed system service below. A separate account is optional.

The easiest option is a **systemd user service**. From the project folder:

```sh
npm run service:install
```

The installer records this folder's absolute path and your Node executable,
installs a user service, and starts it. It never modifies your config.

No manual unit-file edits are normally needed when using this installer. Run it
as the same normal user who successfully ran `npm start`, with your token saved
in the project's `config.json`. Tools must be accessible to that user; use
absolute executable paths if they are only available through a custom shell PATH.

**An old service is not updated automatically.** Stop and disable it before
installing this one, or follow the migration section to update the old unit
instead. Manage this new service with `systemctl --user`, without `sudo`.

Commands:

```sh
systemctl --user status twitch2discord
journalctl --user -u twitch2discord -f
systemctl --user restart twitch2discord
systemctl --user stop twitch2discord
```

To start at boot even when you are not logged in:

```sh
sudo loginctl enable-linger "$USER"
```

The service retries failures with a delay. After repeated failures it stops
retrying: fix the problem, run `systemctl --user reset-failed twitch2discord`,
then `systemctl --user start twitch2discord`.

## Root-managed servers and Proxmox guests

Use this when logged in as root inside your Linux VM/container. No `sudo` or
user login session is needed. Install the relay inside a guest, rather than on
the Proxmox hypervisor itself. The guest must run systemd.

After installing dependencies and editing `/opt/twitch2discord/config.json`,
stop any existing relay and test playback with `npm start`. Stop the foreground test
with Ctrl+C, then run as root:

```sh
cd /opt/twitch2discord
chmod 600 config.json
npm run service:install -- --system
systemctl status twitch2discord
journalctl -u twitch2discord -f
```

This writes `/etc/systemd/system/twitch2discord.service`, enables it at boot,
and starts it as root. No separate account, sudo, or linger setting is required.
The installer records your Node and project paths and checks the configuration
and tools first. Use absolute tool paths if they rely on a custom shell PATH.
Stop any old user service too; a system service does not disable it.

To optionally use an existing dedicated account, install with
`npm run service:install -- --system --user twitch2discord`. That account needs
access to the project, private config, Node, tools and GPU devices. An executable
under `/root` generally cannot be accessed by another account. Running as root
gives the relay and its dependencies root permissions; a separate account limits
that access.

## Updates

The commands below manage a user service. For a system service installed as
root, omit `--user` from every `systemctl` and `journalctl` command. Run dependency
updates as the relay account (for example, `runuser -u twitch2discord -- npm ci`).

From the same project folder:

```sh
systemctl --user stop twitch2discord
git pull --ff-only
npm ci
.venv/bin/python -m pip install --upgrade yt-dlp
npm run diagnose
systemctl --user start twitch2discord
```

Before upgrading, record `git rev-parse HEAD` and make a private copy of your
config outside the checkout. To roll back, stop the service, `git checkout`
that saved commit, run `npm ci`, restore the old config if needed, and start it.
If you move the project or Node executable, rerun the installer with the same
options you originally used (`-- --system` for a root system service).

## Optional GPU encoding

### NVIDIA

Set `"encoder": "nvenc"` in `config.json`. Optional settings are `"nvencPreset":
"p4"` and `"nvencGpu": 0`. Keep `hardwareAcceleratedDecoding` false initially;
NVENC still handles encoding while the CPU decodes and filters the source.

Install a compatible NVIDIA driver and an FFmpeg build with `h264_nvenc`.
See [NVIDIA's FFmpeg guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html).
Run `npm run diagnose`: it encodes a test frame on the selected GPU, rather
than only checking that FFmpeg lists NVENC. A GPU without NVENC cannot use it.
There is no silent fallback; select `software` if GPU encoding is unavailable.

In a Proxmox VM or container, the GPU must be made accessible inside that guest
and usable by the relay account. Installing this service does not configure GPU
passthrough or container devices. Test inside the guest where the relay runs.

### Intel/AMD VAAPI

Set `encoder` to `vaapi` and `vaapiDevice` to the correct `/dev/dri/renderD…`
device. Install the GPU driver for your distribution. Check the device's group
with `ls -l /dev/dri/`; your user needs access to it, usually through `render`:

```sh
sudo usermod -aG render "$USER"
```

Log out and back in (or reboot) so the service gets the new group. Check encoding:

```sh
ffmpeg -hide_banner -loglevel error -vaapi_device /dev/dri/renderD128 -f lavfi -i testsrc2=size=1280x720:rate=30 -vf 'format=nv12,hwupload' -t 3 -c:v h264_vaapi -f null -
```

Use your actual device path. Leave hardware decoding disabled until encoding
works. If VAAPI fails, switch back to `software`.

## Replace an older installation

Install the new version in a separate directory first. Keep the old code,
private config, and service definition until the new version has run reliably.
Do not run both relays on the same account at the same time.

1. Check how the old relay starts. For a system service, use
   `sudo systemctl cat OLD_SERVICE.service` (replace `OLD_SERVICE` with its
   actual name). Note the user, Node path, working directory and any GPU groups.
2. In the new directory, follow the README install steps and copy
   `config.example.json` to `config.json`. Copy your token and channel IDs from
   the old private config. Put your chosen streamers in `streamers`, in order
   from highest to lowest priority, converting old `twitchUrl`/`twitchUrls`
   values directly into the `streamers` array. Do not copy the old `twitchUrl` or
   `twitchUrls` keys; the new validator rejects them.
3. Choose the encoder for the deployment: `software` for CPU, `vaapi` for
   supported Intel/AMD GPUs, or `nvenc` for NVIDIA. Transfer any required quality,
   device, font and executable-path settings from the previous configuration.
   Watermarks are off by default. See the GPU instructions above.
4. Run `npm run config:check` and `npm run diagnose` as the service account.
   Stop the previous relay, then run `npm start` in the new directory. Verify
   picture, sound, resource use, stream switching and recovery after failures.
5. Stop the foreground test. Either update the existing unit's working directory
   and start command, or install a replacement using the appropriate service
   instructions above. Disable any obsolete units: system and user services can
   share a name and still run simultaneously.

For a manually maintained unit, the start command is
`NODE_PATH PROJECT_PATH/index.js --config CONFIG_PATH`; replace the placeholders
with absolute paths. Reload systemd after editing the unit, then restart it.
Run system-service commands as root, or use `sudo` from an administrative account.

VPN launchers are no longer included. Remove obsolete launcher references from
existing units and verify connectivity; the relay does not change host networking.
The streaming library changed from version 6 to 7, so matching encoding settings
alone does not guarantee identical performance. Keep the previous installation
until the replacement has completed an extended playback test. To roll back,
stop the replacement and start the preserved installation.

## Remove the service

For a user service:

```sh
systemctl --user disable --now twitch2discord
rm "$HOME/.config/systemd/user/twitch2discord.service"
systemctl --user daemon-reload
```

For a system service, run as root:

```sh
systemctl disable --now twitch2discord
rm /etc/systemd/system/twitch2discord.service
systemctl daemon-reload
```

You can then remove the clone, after saving any private configuration you need.
