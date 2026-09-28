# Changelog

## 3.0.0

- Configure streamers, fallback, command names, voting and encoding in config.json.
- Fix stale stream selections, vote races, retries and process cleanup.
- Add CPU encoding, optional VAAPI/NVIDIA NVENC and startup diagnostics.
- Support root-managed system services with an optional dedicated account.
- Update the streaming library to 7.0.0 and fix known dependency advisories.
- Add Linux service setup, tests and CI.
- Remove hard-coded deployment settings and VPN scripts.

For upgrades, replace `twitchUrl`/`twitchUrls` with `streamers` and optional
`fallbackStreamer`. Select an encoder supported by the deployment host and enable
`watermark` if an overlay is needed. See [migration instructions](docs/linux.md#replace-an-older-installation).
