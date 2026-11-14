# Development and Verification

**English** | [中文](zh-CN/development.md)

[Back to home](../README.md) · [Configuration guide](configuration.md) · [Troubleshooting](troubleshooting.md)

## Project Structure

```text
src/index.js               Runtime entrypoint
src/deploy-commands.js     Slash command deployment entrypoint
src/commands/*.js          Commands, auto-loaded
src/events/*.js            Events, auto-loaded
src/utils/player.js        Queue, backend switching and playback recovery
src/utils/playback.js      Shared enqueue logic
src/utils/playbackState.js Playback state persistence
test/                      Isolated Node tests
docs/                      Usage, configuration and troubleshooting docs
scripts/install.sh         Interactive installation entrypoint
scripts/install.py         Installation, private configuration and failure recovery
lavalink/application.yml   Lavalink configuration
```

The project is Node.js ESM. Commands export `data` and `execute`; events export `name`, `once` and `execute`.

## npm Scripts

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies from the lockfile |
| `npm start` | Log in and start the Bot |
| `npm run dev` | Node watch development mode |
| `npm run deploy` | Update the real Discord commands |
| `npm run check` | Project JavaScript syntax check |
| `npm test` | Isolated playback, data, permission and voice tests |
| `npm run check:voice-stt` | Call the configured service to probe a short-lived STT token |

Syntax and unit tests do not need to log in to Discord:

```bash
npm run check
npm test
python3 -B -m unittest discover -s test -p 'installer_test.py' -v
```

There are no project-defined lint, format or typecheck scripts. `npm start`, command deployment and STT probing involve real services and cannot be treated as purely offline verification.

## Playback Change Acceptance

- Pause, resume and skip on YouTube and Bilibili individually.
- Switching in both directions: YouTube → Bilibili and Bilibili → YouTube.
- Stop/skip while Lavalink has fallen back to local, and the next song using Lavalink again.
- `trackError → trackEnd/queueEnd`, `trackStuck → queueEnd` and the legacy local `Idle` each advancing only once.
- No duplicate recovery during a backend switch, and a normal fallback leaving and rejoining at most once.

Controls route by the actual `activeBackend`, and local fallback must use a real Discord VoiceConnection. Preserve the order in which `.env` is loaded before ffmpeg resolution, and the entrypoint's `File` compatibility shim.

For the full maintenance architecture notes see [AGENTS.md](../AGENTS.md); for service deployment see the [systemd guide](../systemd/README.md).
