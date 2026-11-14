# 🎵 Discord Music Bot

**English** · [中文](README.zh-CN.md)

A self-hosted Discord music bot for YouTube, Bilibili and Spotify links, with queue
management, radio auto-play, AI song requests, 24/7 voice stay and optional
voice control.

Current version **2.0.0** · [Changelog](CHANGELOG.md)

> The bot's Discord command descriptions and replies are currently in Chinese.
> This repository documents the project in English and [Chinese](README.zh-CN.md);
> it does not translate the in-Discord UI.

## Features

- 🎶 Playback from YouTube and Bilibili links, keyword search and playlists
- ⏯️ Pause, resume, skip, stop, volume, seek, loop, shuffle and remove
- 📻 Radio auto-play with style, era, language and mood selection
- 🤖 AI song requests in natural language (`/ai-music`) and AI playlist editing
- 🎙️ Optional voice control (Mandarin / Cantonese) through a second listener bot
- 🔄 Automatic retry, Lavalink → local fallback and stream-stall recovery
- 🕒 24/7 voice-channel stay without stealing manual song requests
- 💾 Per-guild persistent playlists and settings

Spotify tracks, albums and playlists are resolved and played as matching YouTube
results; Spotify audio itself is not streamed.

## One-command deployment (includes Lavalink)

Supported on **Ubuntu 22.04/24.04 and Debian 12/13, amd64/arm64**, on a machine
with sudo/root access, systemd and an interactive terminal.

Create and invite the Discord bot first. **This repository currently requires
GitHub access**, so run the following from a server that already has an
authorised SSH key:

```bash
work=$(mktemp -d) && git clone --depth=1 git@github.com:gan12138/discord-music-bot.git "$work/source" && sudo bash "$work/source/scripts/install.sh" --source "$work/source"
```

If the repository is publicly readable, the anonymous `curl` entry point in
[the installation guide](docs/installation.md) can be used instead.

The wizard hides all secret input, asks for the application ID, guild ID,
optional Cookie paths and AI settings, then installs **Node, Java, Lavalink,
ffmpeg, yt-dlp/EJS and the local YouTube helper services**, deploys the slash
commands and enables boot-time startup. Re-running the same command updates an
existing install; leave a prompt empty to keep the current value and playlists.

- [Installation guide](docs/installation.md)
- [Configuration](docs/configuration.md)
- [systemd deployment](systemd/README.md)

## Cookies (optional)

Log in to the platform, export a **Netscape `cookies.txt`** file, upload it to the
server and enter its path in the wizard. Leave it empty to skip. The installer
filters entries per platform and copies them outside the repository.

Configuration lives in `/etc/discord-music-bot/bot.env`:

```env
YTDLP_BILIBILI_COOKIE_FILES=/var/lib/discord-music-bot/cookies/bilibili.txt
YTDLP_YOUTUBE_COOKIE_FILES=/var/lib/discord-music-bot/cookies/youtube.txt
```

Bilibili cookies usually contain `SESSDATA`, `DedeUserID` and `bili_jct`. The two
platforms use separate files that never fall back to each other, so Bilibili
login cookies are never sent to Google. **Never commit real cookies, tokens or
API keys.** See [Cookie configuration](docs/installation.md#cookie-export-and-update).

YouTube through Lavalink additionally needs OAuth; local yt-dlp cookies do not
replace it.

## Manual start (local backend)

Requires **Node.js 22.12+, yt-dlp and an ffmpeg build with libopus**. See
[requirements](docs/configuration.md#requirements).

Create the bot in the
[Discord Developer Portal](https://discord.com/developers/applications), invite it
with the `bot` and `applications.commands` scopes, and grant View Channel,
Connect, Speak, Send Messages and Embed Links.

```bash
git clone https://github.com/gan12138/discord-music-bot.git
cd discord-music-bot
npm ci
cp .env.example .env
```

Edit `.env` and replace the placeholders:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_test_guild_id_here

# Local player only: no Lavalink process required
PLAYER_BACKEND=local
```

Deploy the commands and start the bot:

```bash
npm run deploy
npm start
```

Join a voice channel and use `/play`. Global command deployment requires an
explicit `ALLOW_GLOBAL_COMMAND_DEPLOY=true`.

## Commands

| Command | Purpose |
|---|---|
| `/play <link or keywords>` | Play a link or search for a song |
| `/search <keywords>` | Search YouTube videos |
| `/queue [page]` | Show the play queue |
| `/nowplaying` | Show the current song |
| `/skip`, `/pause`, `/resume`, `/stop` | Playback control |
| `/volume <0-100>`, `/seek <time>` | Volume and seeking |
| `/filter`, `/loop`, `/shuffle`, `/remove` | Playback shaping |
| `/playlist` | Persistent playlist management |
| `/radio`, `/audio` | Radio auto-play (`/audio` is an alias) |
| `/ai-music <request>` | AI song request in natural language |
| `/247` | 24/7 voice-channel stay |
| `/panel`, `/notify` | Playback panel and notification mode |
| `/settings dj-role` | Set or clear the DJ role |
| `/voice-control`, `/voice-consent` | Voice control and STT opt-out |
| `/version`, `/help` | Version preference and help |

Without a DJ role every member can control music; once a DJ role is configured it
or Manage Server is required. Server-wide settings require Manage Server.

### YouTube link forms

Plain video links (`youtube.com/watch?v=…`, `youtu.be/…`) and the same links with
Mix/radio parameters (`&list=…&start_radio=1`) play as a **single video**; the
playlist and radio parameters are discarded. Explicit playlist URLs
(`/playlist?list=…`) load the playlist, up to the configured limit. Shorts and
live URLs are not treated as supported link forms and are not guaranteed to play;
search by title if a link is rejected.

## Optional configuration

- **Lavalink**: standalone playback backend — see
  [Lavalink configuration](docs/configuration.md#lavalink-backend) and
  [systemd deployment](systemd/README.md).
- **AI**: your own public HTTPS endpoint, key and model — see
  [AI configuration](docs/configuration.md#ai-song-requests-and-radio).
- **Voice control**: requires a second bot and a speech-to-text service — see
  [voice control](docs/voice-control.md).

Voice control is opt-out based: in `everyone` mode every human member of the
bot's voice channel may use voice commands, and each member can opt out with
`/voice-consent`. Audio segments are sent to the configured STT provider before a
wake word is confirmed. Use `/voice-control stt-policy off` to disable STT for a
guild. Details and privacy notes are in
[voice control](docs/voice-control.md).

## Documentation

- [Installation](docs/installation.md): wizard, cookies, OAuth, upgrades, service management
- [Usage](docs/usage.md): full command list, permissions, radio, 24/7, playlists
- [Configuration](docs/configuration.md): requirements, AI, cookies, Lavalink, environment variables
- [Voice control](docs/voice-control.md): Mandarin/Cantonese, wake words, STT
- [Troubleshooting](docs/troubleshooting.md): login, playback, disconnects, voice
- [Development](docs/development.md): project layout, scripts, tests
- [Changelog](CHANGELOG.md) · [Environment template](.env.example)

中文文档见 [README.zh-CN.md](README.zh-CN.md) 与 [docs/zh-CN](docs/zh-CN/)。

## Project layout

```text
src/index.js                  Bot entry point
src/deploy-commands.js        Slash-command deployment entry point
src/commands/*.js             Slash commands, auto-loaded
src/events/*.js               Discord events, auto-loaded
src/utils/player.js           Queue, backend switching, playback recovery
src/utils/playback.js         Shared enqueue logic
src/utils/playbackState.js    Playback state persistence
src/utils/lavalink.js         Lavalink manager, readiness and track events
src/utils/voiceListenerManager.js  Optional voice listener and STT pipeline
test/                         Isolated Node test suite
docs/                         Usage, configuration and troubleshooting docs
docs/zh-CN/                   Chinese mirror of docs/
scripts/install.sh            Interactive installer entry point
scripts/install.py            Installer, private configuration, rollback
lavalink/application.yml      Lavalink configuration
systemd/                      Service templates and deployment notes
data/                         Runtime data directory (git-ignored)
```

In-memory playback queues live per guild and are lost on restart; playlists,
guild settings and part of the playback state persist in `data/musicbot.json`,
which is git-ignored and created at runtime. The repository ships **no** real
guild data, playlists, cookies, tokens or logs — the data directory is empty on a
fresh clone and filled on first run.

## Requirements

- Node.js `>=22.12.0`
- Discord bot token and application ID
- `yt-dlp` for metadata, search, Bilibili resolution and local fallback
- `ffmpeg` with `--enable-libopus` for the local backend and fallback
  (`FFMPEG_BIN` is honoured; the bundled `ffmpeg-static` is only a last resort)
- For Lavalink: Java 17+, Lavalink v4 and the YouTube source plugin
- Optional: a second bot token and an STT provider for voice control

## Security

- Never commit `.env`, Cookie files, API keys or real playlist data; `.gitignore`
  already excludes them.
- Run the bot and Lavalink as unprivileged service accounts and keep their
  environment files private.
- Keep the YouTube helper ports (`4416`, `8001`) bound to localhost.
- Review `git status` before publishing and only commit source, docs and tests.

## License

Released under the [MIT License](LICENSE).

For learning and personal use. Respect the terms of service of Discord, YouTube,
Bilibili and Spotify, and your local law.
