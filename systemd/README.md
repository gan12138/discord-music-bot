# systemd Deployment

[Project home](../README.md) · [Configuration](../docs/configuration.md) · [Troubleshooting](../docs/troubleshooting.md)

The unit files are production deployment templates. They assume:

- the application is installed at `/opt/discord-music-bot`;
- Node.js `>=22.12.0` is installed system-wide and available in `/usr/local/bin` or `/usr/bin`;
- the Bot runs as the non-root `discordbot:discordbot` account;
- Lavalink runs as the non-root `lavalink:lavalink` account;
- `/etc/discord-music-bot/bot.env` and `/etc/discord-music-bot/lavalink.env` exist and are readable only by the corresponding service account/group.

Example provisioning outline:

```bash
sudo install -d -o discordbot -g discordbot -m 0750 /opt/discord-music-bot/data
sudo install -d -o lavalink -g lavalink -m 0750 /opt/discord-music-bot/lavalink
sudo install -d -m 0750 /etc/discord-music-bot
sudo install -o discordbot -g discordbot -m 0640 bot.env /etc/discord-music-bot/bot.env
sudo install -o lavalink -g lavalink -m 0640 lavalink.env /etc/discord-music-bot/lavalink.env
```

Install a supported system-wide Node.js 22+ before enabling `discord-music-bot.service`. Do not point the unit at an nvm installation under `/root`, because `ProtectHome=yes` intentionally prevents the service from reading `/root`.

The Lavalink password must be present in both environment files. The Java process reads `LAVALINK_PASSWORD` for `${LAVALINK_PASSWORD}` in `lavalink/application.yml`; the Bot reads the same variable from its own environment file.

Use `.env.example` as the Bot template and `lavalink/lavalink.env.example` as the
Lavalink template. Fill in the private copies before installing them. The
Lavalink service and token-refresh service both point `LAVALINK_ENV_FILE` to
`/etc/discord-music-bot/lavalink.env`; do not copy real credentials into YAML or
the source repository. Enabling AI also requires an explicitly configured public
HTTPS `AI_BASE_URL`.

After copying the application and creating the service accounts:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lavalink.service
sudo systemctl enable --now lavalink-pot-refresh.timer
sudo systemctl enable --now discord-music-bot.service
sudo systemctl status lavalink.service lavalink-pot-refresh.timer discord-music-bot.service
```

YouTube playback on datacenter IPs can require both a PO-token provider and a
remote cipher service. The reference configuration expects locally bound
containers on `127.0.0.1:4416` (`brainicism/bgutil-ytdlp-pot-provider`) and
`127.0.0.1:8001` (`ghcr.io/kikkia/yt-cipher:master`). Install the matching
`bgutil-ytdlp-pot-provider` Python plugin into the same Python environment as
`yt-dlp`. `lavalink-pot-refresh.timer` refreshes Lavalink's in-memory token every
four hours; `lavalink.service` also runs one best-effort refresh after each JVM
start. Keep both ports private and never publish them publicly without
authentication.

Install `yt-dlp[default]` (not only bare `yt-dlp`) in the service's actual Python
environment. The default extra includes the version-matched `yt-dlp-ejs` challenge
solver; the Node runtime alone is insufficient. A reference combination is
`yt-dlp==2026.8.19` with `yt-dlp-ejs==0.8.0` and provider/container `1.3.2`.
Lavalink OAuth credentials and local yt-dlp YouTube cookies are independent.

The checked-in Lavalink HTTP timeouts are 5s connect, 3s connection-pool wait and
8s read. Bot recovery defaults to one transient Lavalink retry, then local
fallback, with a shared 45s startup/recovery budget. Network-unreachable errors
(`Network is unreachable`, `No route to host`, `ENETUNREACH`, `EHOSTUNREACH`)
are classified as retryable network errors; the OAuth TV/TVHTML5 client's error
takes precedence over secondary clients' login/403 failures.

`LAVALINK_TRACK_RETRY_TIMEOUT_MS` defaults to 8s, including REST/loading and
waiting for confirmed server-reported audio progress. `trackStart` alone does
not clear this deadline. `LOCAL_FALLBACK_RESERVE_MS` defaults to 15s of the shared
budget for the local voice reconnect, extraction and audio start. A retry is
skipped if less than 3s remains after its delay and this reserve; the budget is
checked again after waiting for the guild lock. A timed-out retry aborts pending
work before entering the lock and switches to local once. Pause/resume suspends
the attempt deadline; stop/skip/replacement cancels it. These are time budgets,
not guarantees that an unavailable network will recover.

Recovery logs include error category, primary client, retry count, remaining
budget and retry timeout. `outcome=output-confirmed` measures audio start;
`outcome=stable` reports `confirmedStartMs` and `stableElapsedMs` separately,
so the 30s stability observation is not mistaken for startup latency. Recovery
seeks use confirmed server progress or the attempt's original seek position,
not the client's extrapolated clock.

YAML changes require a
Lavalink restart; Bot recovery code requires a Bot restart. Validate full audio
downloads and the cross-platform pause/resume/skip flows before rollout.

For intermittent network-unreachable failures, capture the actual failing CDN
host/IP and address family alongside DNS and route state at the failure time.
Successful metadata lookup or reading the opening bytes is not a sustained
playback check. Use bounded stream reads and actual playback; do not download
an entire 100-hour video as a diagnostic. Apply an IPv4-only JVM setting only
when the failure is traced to IPv6 without a usable route; route/DNS/CDN errors
need the corresponding network fix.

The Bot's local playback and Lavalink fallback resolve their ffmpeg binary via
`src/utils/ffmpeg.js` (explicit `FFMPEG_BIN` → `/usr/bin/ffmpeg` →
`/usr/local/bin/ffmpeg` → PATH `ffmpeg` → bundled `ffmpeg-static`, requiring
`--enable-libopus`). On Ubuntu, set `FFMPEG_BIN=/usr/bin/ffmpeg` in `bot.env`
so the bundled `ffmpeg-static@5.3.0` binary (which is actually `7.0.2-static`
and can crash with `SIGSEGV` on long Opus streams) is never used.

Use `journalctl -u lavalink -u discord-music-bot` for logs. Do not share raw logs without removing voice tokens, signed media URLs, cookies, and authorization values.
