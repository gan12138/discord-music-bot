# Troubleshooting

**English** | [中文](zh-CN/troubleshooting.md)

[Back to home](../README.md) · [Configuration guide](configuration.md) · [Voice control](voice-control.md) · [systemd deployment](../systemd/README.md)

The commands below are for manual diagnostics. Raw logs may contain tokens, cookies, signed audio URLs and user identifiers; redact them before sharing.

One-click deployments use the `discord-music-bot-lavalink` service name (not the `lavalink` of the manual templates), and their configuration lives in `/etc/discord-music-bot/bot.env`. The log commands below apply to the manual templates; for one-click deployments, substitute the matching service names as described in [Service management](installation.md#service-management).

## Logs and Processes

For systemd deployments, check these first:

```bash
journalctl -u discord-music-bot -u lavalink --since '1 hour ago' --no-pager
```

If a development environment redirects logs to files:

```bash
tail -n 100 bot.log
tail -n 100 lavalink/lavalink.log
ps -eo pid,cmd | rg 'Lavalink.jar|node src/index.js'
```

Check the working directory before restarting, so you do not terminate another installed Bot. The Bot uses `data/bot.pid` to prevent duplicate starts; only clear a stale lock once you have confirmed the PID no longer exists. Code changes need a Bot restart and YAML changes need a Lavalink restart, so schedule a playback interruption first.

## The Bot Does Not Come Online

- Check `DISCORD_TOKEN` and `CLIENT_ID` in `.env` or in the systemd environment file.
- Check that Node.js is 22.12+ and that `yt-dlp` and ffmpeg are runnable on the Bot's actual PATH.
- Check the logs for a duplicate-instance lock, a login failure or missing dependencies.

```bash
node --version
yt-dlp --version
ffmpeg -version
```

Local playback requires an ffmpeg built with `--enable-libopus`. Use `FFMPEG_BIN` to point at a system binary.

## Slash Commands Are Not Updated

First set the correct `DISCORD_GUILD_ID` in `.env`, then run:

```bash
npm run deploy
```

Server-scoped commands update immediately. Global deployment requires explicitly setting `ALLOW_GLOBAL_COMMAND_DEPLOY=true`, and syncing can take a while. Also confirm the Bot's invite included the `applications.commands` scope.

## Lavalink Connection Failures

- Confirm the Java process is running and the log shows `Lavalink is ready to accept connections.`.
- `LAVALINK_PASSWORD` must be identical in the Bot and Lavalink private environment files.
- Check `LAVALINK_HOST`, the port, the HTTPS/WSS setting and the YAML configuration.
- Playback is only allowed once the node connection, `/v4/info` and the session ID are all valid; while they are not available the Bot keeps the recovery task.

```bash
ps -eo pid,cmd | rg Lavalink.jar
```

See [Lavalink configuration](configuration.md#lavalink-backend) for configuration and OAuth/helper-service steps. On memory-tight deployments, give the JVM a suitable heap cap to avoid websocket ping timeouts caused by swap pressure.

## No Sound

1. Confirm the member and the Bot are in the correct voice channel.
2. Check the Bot's View Channel, Connect and Speak permissions, and the Discord client's mute/volume.
3. When using Lavalink, check that the node is ready and that it has joined voice.
4. Look for `track start`, `PlaybackRecovery`, `start timeout` and fallback messages in the logs.
5. Bilibili should show direct-URL playback or local fallback logs; local playback must be able to find a usable ffmpeg.

A successful `player.play()` or `trackStart` does not mean audio is being output; Lavalink needs actual server-reported progress to confirm it.

## Songs Skip Erratically or the Panel Stops Working

The expected behaviour is that manual songs are queued with priority and play after the current Radio song ends. When an old playback panel stops working, use `/panel` to get a fresh one.

The current version deduplicates by playback ID and end events, so multiple error/end events cannot skip the next song. Useful log strings to search for:

```text
PlaybackError
PlaybackRecovery
PlaybackRetry
PlaybackSkipAfterError
track start
track error
track stuck
queue end observed
advance ignored
start timeout
```

Controls such as pause, resume and skip are routed by the actual backend. A Lavalink-to-local fallback may legitimately leave and rejoin voice once; if it switches repeatedly, check whether the old backend is being recovered again during `startingBackend` or `backendTransitioning`.

## Playback Failures and Recovery Strategy

Errors distinguish network timeouts, unreachable hosts, 403, login challenges, explicit content restrictions and environment problems. `This video is not available` only means audio cannot be obtained through the current path; it does not necessarily mean the video was deleted.

- Aggregated errors identify the OAuth TV/TVHTML5 client first, so its network errors are not masked by other clients' 403/challenge errors.
- Transient network failures are retried once on Lavalink, then fall back to local `yt-dlp + ffmpeg`.
- Local network timeouts/stream stalls are retried at most twice; ambiguous unavailability, 403 and no-audio-format results are confirmed at most once more; explicit content restrictions or environment problems are not retried.
- One start/recovery round shares a 45-second budget by default. A Lavalink retry gets at most 8 seconds, and 15 seconds are reserved for local connect/resolve/start; if the budget is insufficient it falls back immediately.
- Recovery resumes from about 3 seconds before the failed position where possible. Confirmed output clears the start timeout, and about 30 seconds of sustained progress resets the retry budget; pause does not count as sustained progress.
- Retry waits and alternate-source searches are cancellable, and old tasks must not come back to life after stop/skip/replacement.
- A local stall is only declared when the source has not ended cleanly, the downstream buffer is drained and no new data keeps arriving; a normal early transcode completion is not a stall.
- Child processes are cleaned up with SIGTERM first, then SIGKILL after two stuck seconds; failure notices are suppressed in empty channels.

See [Playback and recovery parameters](configuration.md#playback-and-recovery-parameters) for the parameters. The Lavalink YAML HTTP timeouts are 5 s connect, 3 s connection-pool wait and 8 s read, which differ from the Bot's node reconnect parameters.

### Radio Cooldown and Alternate Sources

Videos whose playback paths are exhausted cool down for 10 minutes by default, extended up to 1 hour after repeated failures; videos explicitly deleted/private/region-restricted cool down for 24 hours. The cache holds at most 1000 entries and is cleared on restart.

A Lavalink-only failure with a successful local playback does not block the whole song; service outages, environment problems and process problems do not count towards video cooldown. Users can still retry by requesting the same link again.

Only Radio tries at most two alternate uploads of the same track, sharing the recovery budget. It matches title, recognisable artist, duration and live/regular version, and excludes covers, instrumentals, remixes and already failed videos; if there is not enough information it moves on to the next song. Manually requested URLs are never replaced.

## YouTube Extraction or Mid-Song 403

- Keep `yt-dlp` and the matching `yt-dlp-ejs` up to date; the Node runtime alone is still not enough.
- Check whether Lavalink OAuth, the snapshot plugin, `yt-cipher` and the poToken provider are available.
- The local yt-dlp uses its own `YTDLP_YOUTUBE_COOKIE_FILES` and cannot reuse Bilibili cookies or Lavalink OAuth.
- Metadata or `-g` returning a URL does not mean the audio can be downloaded completely.

```bash
python3 -m pip install -U 'yt-dlp[default]'
python3 -m pip show yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider
```

In an existing temporary directory, verify a full download with a public video of a suitable length:

```bash
yt-dlp --js-runtimes node --force-ipv4 --socket-timeout 20 \
  --retries 2 --fragment-retries 2 --no-playlist \
  -f 'bestaudio[ext=webm]/bestaudio' \
  -o '/tmp/%(id)s.%(ext)s' 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

You can also check overall availability with Lavalink `GET /youtube/stream/{videoId}`, without `withClient=TV`, because TV has no metadata support. A 200 response or partial audio is still not enough to confirm complete playback; the snapshot endpoint may return an unknown content length, making Node fetch report `terminated` on close, so validate with audio frame duration or sustained playback.

For intermittent network-unreachable failures, record the failing CDN's domain/IP, address family and DNS/route state. Only consider an IPv4-only setting once you have confirmed there is no usable IPv6 route.

## Bilibili Failures

Playback path: yt-dlp resolves with cookies → Lavalink plays the temporary direct URL over HTTP → falls back to local yt-dlp/ffmpeg on failure. The fallback uses the original page URL, cookies, Referer and User-Agent, and expired direct URLs are refreshed.

On 403, 412 or a login challenge, configure your own Netscape cookies:

```env
YTDLP_BILIBILI_COOKIE_FILES=/path/to/bilibili-cookies.txt
```

The legacy `YTDLP_COOKIE_FILES` remains only as a Bilibili compatibility fallback. When verifying extraction, replace `<video-id>` with the actual BV/AV:

```bash
yt-dlp --cookies '/path/to/bilibili-cookies.txt' \
  --referer 'https://www.bilibili.com' --dump-json --no-download \
  'https://www.bilibili.com/video/<video-id>/'
```

`using direct audio URL via Lavalink` in the log means direct-URL playback; `falling back to local yt-dlp` means it has switched to local playback.

## Voice Control Does Not Respond

- Confirm the second Bot has joined the server, its Token differs from the main Bot's, and `VOICE_LISTENER_ENABLED=true`.
- Confirm it is in the same channel as the music Bot, is not self-deafened and has View Channel/Connect permissions.
- Check whether server STT is disabled and whether the member has opted out.
- Use `/voice-control test` to check wake word and command parsing, and `/voice-control diagnostics` to inspect STT, Opus decoding and concurrency limits.
- AI balanced mode additionally needs a valid AI configuration; strict mode does not call AI.

See the [voice control guide](voice-control.md) for the full steps and access policy.
