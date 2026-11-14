# Usage Guide

**English** | [中文](zh-CN/usage.md)

[Back to home](../README.md) · [Configuration guide](configuration.md) · [Voice control](voice-control.md)

Join a voice channel first, then request songs with `/play`. Spotify tracks, albums and playlists are resolved and converted into YouTube search results rather than played directly from Spotify audio.

## Commands

| Command | Purpose |
|----------|---------|
| `/play <link/keywords>` | Play a YouTube, Bilibili or Spotify link, or search by keywords |
| `/search <keywords>` | Search YouTube videos |
| `/queue [page]` | Show the playback queue |
| `/nowplaying` | Show what is currently playing |
| `/skip` | Skip the current song |
| `/pause`, `/resume` | Pause, resume |
| `/stop` | Stop and clear the queue |
| `/volume <0-100>` | Adjust the volume |
| `/seek <time>` | Jump to a position; accepts `90`, `1:30`, `01:02:03` |
| `/filter <mode>` | Set an audio filter |
| `/shuffle` | Shuffle the manual queue |
| `/loop <mode>` | Set the loop mode |
| `/remove <position>` | Remove a song from the queue |
| `/playlist` | Manage persistent playlists |
| `/radio`, `/audio` | Automatic continuation; `/audio` is an alias |
| `/ai-music <request>` | Ask AI to queue songs from a natural-language request |
| `/247` | Keep the 24/7 voice channel |
| `/panel` | Get the playback panel |
| `/notify` | Set how playback notifications are delivered |
| `/version` | Set the live or regular version preference for AI/Radio |
| `/settings dj-role` | Set or clear the DJ role |
| `/voice-control` | Manage the listener Bot, STT, wake words and more |
| `/voice-consent` | Opt out of or back into cloud STT |
| `/help` | Show help |

## Permissions and the Playback Panel

When no DJ role is set, any member can use the music controls; once it is set, members need the DJ role or Manage Server. Playback controls usually also require being in the same voice channel as the music Bot.

Server settings such as the `/247` toggle, `/notify`, `/version`, `/settings` and `/voice-control` require Manage Server. Voice commands are open to humans in the same channel, and per-member STT opt-out records still apply.

The panel supports pause/resume, previous, next, stop, loop, Radio, the queue and joining/leaving with the listener Bot. Old playback panels stop working; use `/panel` to get a fresh one.

`/notify` can choose a private panel, update a public panel, notify per track, or disable notifications.

## Radio Auto-Continuation

Radio can recommend by style, era, language and mood; with AI enabled it can also generate recommendation queries or detect the style automatically.

| Command | Purpose |
|----------|---------|
| `/radio start`, `stop` | Turn continuation on or off; turning it off does not affect the manual queue |
| `/radio status` | Show the current state |
| `/radio style` | Set style, era, language and mood |
| `/radio autodetect <true/false>` | Turn AI style auto-detection on or off |
| `/radio reset` | Clear the cache and recommend again |

Manual requests go into a priority queue: when the current Radio song ends naturally the manual songs play first, and Radio continues once the manual queue is done. Starting/resetting Radio never takes over a manual song that is already playing.

Changing style or version preference, turning Radio off/resetting it, or requesting manually invalidates older recommendation jobs. Videos whose recommendations fail go into cooldown, and Radio may try at most two conservatively matched alternate uploads of the same track; URLs the user requested manually are never replaced automatically.

## 24/7 Mode

| Command | Purpose |
|----------|---------|
| `/247 on`, `off` | Turn channel keeping on or off |
| `/247 status` | Show the current state |

24/7 only keeps the connection alive and does not pre-empt requests. With nobody present the current song may finish, the rest of the queue is kept and Radio pauses its recommendations; both resume when someone returns. After a Bot restart it tries to restore the channel and the necessary playback state, and keeps the recovery task queued while the node is not ready yet.

## Playlists

| Command | Purpose |
|----------|---------|
| `/playlist create <name>` | Create a playlist |
| `/playlist delete <name>` | Delete a playlist |
| `/playlist list` | List playlists |
| `/playlist add <name> <link>` | Add a song |
| `/playlist show <name>` | Show the contents |
| `/playlist play <name>` | Play a playlist |
| `/playlist ai` | Manage playlists in natural language; requires configured AI |

Playlists are stored in the private data file, up to 25 playlists per server and 200 songs per playlist. Destructive AI operations show a confirmation preview; if the playlist has changed since the preview, the operation has to be generated again.
