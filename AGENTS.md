# AGENTS.md

## Project Shape
- Node.js ESM Discord music bot; runtime entrypoint is `src/index.js`, slash-command deploy entrypoint is `src/deploy-commands.js`.
- Commands are auto-loaded from every `src/commands/*.js` file; each command module must export `data` and `execute`.
- Events are auto-loaded from every `src/events/*.js` file; event modules export `name`, `once`, and `execute`.

## Commands
- Install dependencies with `npm install`; lockfile is `package-lock.json`.
- Start the bot with `npm start`.
- Run development watch mode with `npm run dev`.
- Deploy slash commands with `npm run deploy`; this uses `Routes.applicationCommands(process.env.CLIENT_ID)`, so it updates global application commands, not guild-scoped test commands.
- `npm run check` runs `node --check` across `src/**/*.js` and `src/*.js`; there are no repo-defined `test`, `lint`, `format`, or `typecheck` scripts.

## Runtime Requirements
- Requires Node `>=18.0.0`.
- `.env` is loaded via `dotenv/config`; required vars are `DISCORD_TOKEN` and `CLIENT_ID`.
- Playback metadata/search shell out to system `yt-dlp`; local playback and playback fallback use `yt-dlp` plus `ffmpeg`/`ffmpeg-static`.
- With `PLAYER_BACKEND=lavalink`, YouTube playback uses Lavalink. Bilibili is not parsed by a Lavalink Bilibili source: the bot first uses `yt-dlp` and `YTDLP_COOKIE_FILES` to resolve a short-lived `bilivideo.com` audio URL, then asks Lavalink HTTP source to play that direct URL. If Lavalink direct playback fails, the bot falls back to local `yt-dlp + ffmpeg`.
- `YTDLP_COOKIE_FILES` is passed as `yt-dlp --cookies`; current code accepts comma-separated paths but uses the first non-empty path. Bilibili cookies should be Netscape `cookies.txt` format and normally include login fields such as `SESSDATA`, `DedeUserID`, and `bili_jct`.
- `src/index.js` sets `globalThis.File = File` from `node:buffer` before importing Discord code; keep this compatibility shim unless the dependency/runtime issue is verified gone.

## Playback Architecture Notes
- `src/utils/player.js` owns queue advancement, Lavalink playback, local fallback, and control routing.
- `activeBackend` tracks the actual backend for the current song: `lavalink` after successful Lavalink `player.play()`, `local` after successful Discord audio player `play()`, and `null` after stop/cleanup. Pause/resume/skip/volume/seek controls must route by `activeBackend` or actual player availability, not just by global `PLAYER_BACKEND`.
- Bilibili songs may need their direct `audioUrl` refreshed before playback or restore because Bilibili CDN URLs expire. Use `Bilibili.getVideoInfo()` to refresh `audioUrl` and `audioUrlExpiresAt` when `freshAudioUrl(song)` is missing/stale.
- Keep local fallback functional even when Lavalink is enabled. Do not assume `isLavalinkEnabled()` means local `ffmpegProcess`, `ytdlpProcess`, or `player` can be ignored; fallback may have created them.
- `lavalinkConnectionShim()` is only a Lavalink state shim. Local playback requires a real Discord voice connection from `joinVoiceChannel()`; do not subscribe a local audio player to the shim.

## Data And State
- Playlist/settings persistence is JSON at `data/musicbot.json`, created by `src/models/database.js`.
- In-memory playback queues live in `musicQueue` in `src/utils/player.js`; they are per-guild and are lost on process restart.
- `.gitignore` excludes `.env`, logs, sqlite/db files, `node_modules`, `data/musicbot.json`, and the local Bilibili cookies export; avoid committing real guild/user playlist data or cookies.

## Verification Notes
- Without Discord credentials and a voice channel, `npm start` only verifies startup/login path partially and may connect to the real bot.
- `npm run deploy` requires real credentials and mutates Discord application commands; do not run it as a harmless validation step.
- For safe syntax/import checks, prefer targeted `node --check <file>` or dynamic imports that avoid logging in.
- `npm run check` is the safe whole-project syntax check.
- Safe Bilibili parser verification can use a dynamic import of `Bilibili.getVideoInfo()` after loading `dotenv/config`; this does not log in to Discord.
- Do not run `npm run deploy` or restart the real bot unless explicitly requested. When restarting this workspace's test bot, only kill processes whose `pwdx` is `/root/discord bot test`; there may be another `/root/discord bot` process.
- After changing playback routing, test or ask the user to test these flows: YouTube pause/resume/skip, Bilibili pause/resume/skip, YouTube -> Bilibili next, and Bilibili -> YouTube next.
