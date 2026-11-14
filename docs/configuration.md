# Configuration Guide

**English** | [中文](zh-CN/configuration.md)

[Back to home](../README.md) · [Usage guide](usage.md) · [Voice control](voice-control.md) · [Troubleshooting](troubleshooting.md)

If you want the Bot, Lavalink and the dependencies installed automatically, start with [one-click installation](installation.md). The `.env` steps below are for a manual start; for one-click deployments, edit `/etc/discord-music-bot/bot.env`.

## Requirements

- Node.js `>=22.12.0`.
- A `yt-dlp` available on the system, used for search, metadata parsing and local playback.
- An ffmpeg built with `--enable-libopus`, used for local playback or Lavalink fallback.
- When using Lavalink, Java 17+, Lavalink v4 and the YouTube plugin are also required.

When installing yt-dlp with pip, use the default dependency group, which includes the matching EJS challenge solver:

```bash
python3 -m pip install -U 'yt-dlp[default]'
yt-dlp --version
node --version
ffmpeg -version
```

Install it into the Python/PATH environment the Bot actually uses. A reference combination is `yt-dlp 2026.8.19`, `yt-dlp-ejs 0.8.0` and bgutil plugin/container `1.3.2`; keep these versions matched when upgrading.

## Discord and Basic Configuration

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and add a Bot.
2. Copy the Bot Token and application ID, then invite the Bot to your server with the `bot` and `applications.commands` scopes.
3. Grant the Bot View Channel, Connect and Speak on the target voice channel, plus Send Messages and Embed Links on the target text channel.
4. Copy [`.env.example`](../.env.example) to `.env` and fill in real values. Never commit real configuration.

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_test_guild_id_here
PLAYER_BACKEND=local
```

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Required; the Token of the music Bot |
| `CLIENT_ID` | Required; the Discord application ID |
| `DISCORD_GUILD_ID` | Set it to deploy commands to a specific server; commands update immediately |
| `ALLOW_GLOBAL_COMMAND_DEPLOY` | Global command deployment is only allowed when this is explicitly `true` |
| `PLAYER_BACKEND` | `local` or `lavalink`; the template recommends `lavalink`, the README quick start uses `local` |

After editing, run:

```bash
npm run deploy
npm start
```

`npm run deploy` modifies real Discord commands. With a server ID it updates only that server; without one, global deployment must be explicitly allowed, and global sync can take a while.

## AI Song Requests and Radio

AI is optional and compatible with the OpenAI Chat Completions API. When enabled you must configure your own endpoint, key and model; the project ships no preset private relay address.

```env
AI_ENABLED=true
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=your_model_name
RADIO_AI_ENABLED=false
```

| Variable | Description |
|----------|-------------|
| `AI_ENABLED` | Whether AI features such as AI song requests are enabled |
| `AI_BASE_URL` | Required when AI is enabled; a public HTTPS API address |
| `AI_API_KEY` | Required when AI is enabled; the key for your actual service |
| `AI_MODEL` | A model name supported by that service |
| `AI_TIMEOUT_MS` | Request timeout, `15000` milliseconds by default |
| `RADIO_AI_ENABLED` | Whether Radio may use AI to generate recommendation queries; disabled in the template by default |

API addresses do not support private networks, plain HTTP, embedded credentials or query parameters. `/version` sets the live or regular version preference for AI/Radio and does not affect plain `/play`.

## Cookie

Cookies use Netscape `cookies.txt` format. Each entry accepts comma-separated paths; the first non-empty path is used.

```env
YTDLP_BILIBILI_COOKIE_FILES=/path/to/bilibili-cookies.txt
YTDLP_YOUTUBE_COOKIE_FILES=/path/to/youtube-cookies.txt
```

| Variable | Purpose |
|----------|---------|
| `YTDLP_BILIBILI_COOKIE_FILES` | Bilibili login cookies, preferred |
| `YTDLP_COOKIE_FILES` | Legacy name, kept only as a Bilibili compatibility fallback |
| `YTDLP_YOUTUBE_COOKIE_FILES` | YouTube-only cookies; never falls back to the Bilibili configuration |

Bilibili login cookies usually contain `SESSDATA`, `DedeUserID` and `bili_jct`. Lavalink's YouTube OAuth is not handed to the local yt-dlp automatically; the two must be configured separately.

## Lavalink Backend

Lavalink handles playback in its own process, reducing transcoding load inside the Bot; YouTube/Bilibili tracks that cannot be played can fall back to the local player automatically.

The Bot's `.env`:

```env
PLAYER_BACKEND=lavalink
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=
LAVALINK_SECURE=false
LAVALINK_NAME=main
```

Generate a unique password and put the same value in the Bot and Lavalink private environment files. For development, run this from the project root:

```bash
cd lavalink
cp lavalink.env.example lavalink.env
# Edit lavalink.env, fill in the password and any required OAuth settings.
chmod 600 lavalink.env
set -a
. ./lavalink.env
set +a
java -jar Lavalink.jar
```

Configuration notes:

- [Lavalink YAML](../lavalink/application.yml) disables the built-in YouTube source and pins the plugin snapshot that contains the TV client fixes.
- `MUSIC` is used for metadata/search; `TV` is the preferred OAuth-capable client in the playback chain.
- `YOUTUBE_OAUTH_REFRESH_TOKEN` belongs only in the private environment file; the YAML references it through an environment variable. When it is empty, complete authorisation with the device code from the plugin log.
- The reference configuration uses a local `yt-cipher` (`127.0.0.1:8001`) and a poToken provider (`127.0.0.1:4416`); the matching bgutil Python plugin must be the same version as the container.
- `lavalink-pot-refresh.timer` refreshes the token every four hours, and Lavalink also performs one best-effort refresh after startup.
- Bilibili audio is first resolved by yt-dlp into a temporary direct audio URL and then played through the Lavalink HTTP source; expired direct URLs are resolved again.

Production deployment, service accounts and helper services are covered by the [systemd deployment guide](../systemd/README.md); the Lavalink private environment template is [`lavalink.env.example`](../lavalink/lavalink.env.example).

| Variable | Description |
|----------|-------------|
| `LAVALINK_HOST`, `LAVALINK_PORT` | Node address, default `127.0.0.1:2333` |
| `LAVALINK_PASSWORD` | Required; must match Lavalink |
| `LAVALINK_SECURE` | Whether to use HTTPS/WSS |
| `LAVALINK_NAME` | Node name, default `main` |
| `LAVALINK_RETRY_AMOUNT` | Number of consecutive WebSocket reconnects, default `12` |
| `LAVALINK_RETRY_DELAY_MS` | Reconnect interval, default `10000` milliseconds; node re-creation is still attempted once these are exhausted |

## Playback and Recovery Parameters

The defaults are usually fine. For how recovery behaves in detail, see [Troubleshooting](troubleshooting.md#playback-failures-and-recovery-strategy).

| Variable | Default / Description |
|----------|-----------------------|
| `FFMPEG_BIN` | Optionally pins ffmpeg; by default the system binary is preferred, falling back to bundled ffmpeg-static last |
| `YTDLP_MAX_CONCURRENT` | Cap on concurrent metadata/search processes, `6` |
| `MAX_QUEUE_SIZE` | Queue length cap for manual and Radio queues, `100` |
| `AUDIO_BUFFER_MB` | Local audio buffer, `8` MB |
| `AUDIO_PREBUFFER_MS` | Maximum wait for the local pre-buffer, `1500` milliseconds |
| `AUDIO_NORMALIZATION` | Whether local ffmpeg applies audio normalization |
| `LOCAL_STREAM_STALL_MS` | Threshold for declaring a stall when the source has not ended cleanly, the buffer is drained and no new data keeps arriving, `20000` milliseconds |
| `PLAYBACK_RECOVERY_TIMEOUT_MS` | Shared budget for one start/recovery round, `45000` milliseconds |
| `LAVALINK_TRACK_RETRY_DELAY_MS` | Wait before a same-backend retry of a transient failure, `1000` milliseconds, plus under 200 ms of random jitter |
| `LAVALINK_TRACK_RETRY_TIMEOUT_MS` | Maximum time to confirm output for one Lavalink retry, `8000` milliseconds |
| `LOCAL_FALLBACK_RESERVE_MS` | Time reserved inside the shared budget for local connect/resolve/start, `15000` milliseconds |
| `PLAYER_DEBUG`, `RADIO_DEBUG`, `PLAY_TIMING`, `VOICE_DEBUG` | Set to `1` to enable the corresponding debug logs |
| `MUSICBOT_DATA_PATH` | Overrides the data file path; default `data/musicbot.json` |

ffmpeg resolution order: `FFMPEG_BIN` → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → PATH → bundled ffmpeg-static. The selected binary must support libopus; system ffmpeg is recommended.

Voice listening and STT variables are covered in the [voice control guide](voice-control.md). The complete template is [`.env.example`](../.env.example).

## Data and Privacy

- `data/musicbot.json` stores playlists, server settings and some playback recovery state.
- Current progress, Radio, 24/7 and other necessary state are used for recovery; runtime queues are not guaranteed to restore completely.
- Temporary audio URLs, playback IDs and backend switch state are not persisted.
- Real environment files, cookies, runtime data and backups, logs and recordings stay in the deployment environment and are not added to Git.
- Logs may contain voice tokens, signed media URLs and user identifiers; redact them before sharing.
