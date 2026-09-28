# Contributing

Use Node 22 or 24 and `npm ci`. Before sending a change:

```sh
npm run check
npm run format:check
npm test
npm run smoke
npm audit
```

`npm run format` formats the code. Unit tests use fake Twitch/Discord interfaces;
`smoke` encodes local synthetic video and audio without logging in. FFmpeg and
yt-dlp are needed for the smoke test.

Keep new settings documented, command replies short, and credentials out of
commits. Changes to switching, voting or cleanup need regression tests. Test
real playback on Linux before releasing media-library updates.

## Where things live

- `index.js`: startup, Discord connection, shutdown.
- `src/config.js`: settings, defaults and validation.
- `src/twitch.js`: Twitch availability and stream URL lookup through yt-dlp.
- `src/relay.js`: which stream to play, switching and retries.
- `src/media.js`: FFmpeg encoding, progress monitoring and cleanup.
- `src/commands.js` / `src/votes.js`: chat commands, permissions and votes.
- `scripts/`: checks, local encoding test and Linux service installation.
- `test/` / `.github/`: regression tests and automated GitHub checks.

Tests establish specific behaviors; they do not prove every Linux/GPU/Discord
setup works. Release notes should name the environments actually tested and
any known limitations. All contributions, including AI-assisted changes, need
review and the relevant checks before release.
