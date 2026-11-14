# Voice Control

**English** | [中文](zh-CN/voice-control.md)

[Back to home](../README.md) · [Configuration guide](configuration.md) · [Troubleshooting](troubleshooting.md)

Voice control uses a second Discord Bot to receive audio while the main music Bot keeps handling playback. It supports Mandarin, Cantonese, wake words and optional AI understanding.

## Enabling It

1. Create a second Bot and add it to the same server as the music Bot.
2. Give it View Channel and Connect permissions on the target voice channel.
3. Configure the listener Token and the STT (speech-to-text) service.
4. Explicitly set `VOICE_LISTENER_ENABLED=true` and restart the music Bot in a maintenance window.
5. Once the music Bot joins a voice channel, the listener Bot follows automatically and receives audio self-muted and not self-deafened.

### Vercel AI Gateway

`xai/grok-stt` uses a short-lived token and WebSocket streaming transcription, with `24 kHz / PCM16 / mono` input:

```env
VOICE_LISTENER_ENABLED=true
VOICE_LISTENER_TOKEN=
VOICE_STT_PROVIDER=vercel-ai-gateway
VOICE_STT_GATEWAY_API_KEY=
VOICE_STT_MODEL=xai/grok-stt
VOICE_STT_SAMPLE_RATE=24000
VOICE_STT_TIMEOUT_MS=15000
```

With real Token and Gateway key values filled in, you can probe the STT token on its own without logging in the listener Bot or uploading member audio:

```bash
npm run check:voice-stt
```

If you use your own compatible Gateway, set `VOICE_STT_GATEWAY_BASE_URL` (a public HTTPS address). Only when this address is explicitly set may the Gateway fall back to `VOICE_STT_API_KEY`, so a compatible service's key is never sent to the default service. The transcription WebSocket address is validated against the token response and a code allowlist.

### OpenAI-compatible STT

`/audio/transcriptions` compatible services are also supported:

```env
VOICE_LISTENER_ENABLED=true
VOICE_LISTENER_TOKEN=
VOICE_STT_PROVIDER=openai-compatible
VOICE_STT_BASE_URL=https://api.openai.com/v1
VOICE_STT_API_KEY=
VOICE_STT_MODEL=whisper-1
VOICE_STT_SAMPLE_RATE=48000
```

## Speaking Commands

The default wake words are "音乐助手" ("music assistant") and "语音助手" ("voice assistant"), and they are expected near the start of a sentence. You can either say the whole command at once, or wake the Bot first and then say the command within a short window.

```text
音乐助手，播放罗大佑的童年
音樂助手，幫我播富士山下
音乐助手，暂停
音樂助手，停一停
音乐助手，继续
音樂助手，播返
音乐助手，上一首
音樂助手，播返上一首
音乐助手，下一首
音樂助手，飛歌
```

Administrators can choose:

- **Strict mode** (default): exact wake words and fixed commands, no AI calls.
- **AI balanced mode**: exact standard commands match directly, while small transcription errors in long wake words and unrecognised instructions are handed to AI for confirmation. This requires configured [AI services](configuration.md#ai-song-requests-and-radio).

AI only executes when the confidence reaches the threshold, the evidence can be verified in the original utterance, and the command is still valid. A wake word in the middle of an ordinary sentence, song lyrics, a too-short wake-up or an uncertain result never triggers a command directly.

## Admin and Member Commands

`/voice-control` and the listener Bot join/leave buttons on the playback panel require Manage Server.

| Command | Purpose |
|----------|---------|
| `/voice-control enable`, `disable` | Turn voice control on or off |
| `/voice-control status` | Show the configuration and listener connection |
| `/voice-control stt-policy` | Choose allow-everyone or fully disabled |
| `/voice-control cloud-stt` | Enable STT for everyone or disable STT |
| `/voice-control language` | Mandarin, Cantonese or mixed mode |
| `/voice-control understanding` | Strict or AI balanced understanding |
| `/voice-control wakeword` | Add, remove, replace, list or reset wake words, up to 10 |
| `/voice-control audit-channel` | Set or clear the command-result channel |
| `/voice-control test` | Test parsing results with text |
| `/voice-control diagnostics` | Show recording, decoding, STT, focus and error diagnostics |
| `/voice-consent revoke` | Have a member opt out of STT and stop in-progress processing |
| `/voice-consent grant` | Have a member opt back in |
| `/voice-consent status` | Show your own effective status |

The playback panel shows the STT policy, language, understanding mode and wake words. The join/leave buttons only toggle the listener Bot's automatic following; they do not change the STT policy or a member's opt-out record.

## Access Policy and Audio Processing

- The listener Bot does not log in by default; it only works when explicitly enabled and fully configured.
- Servers allow humans in the same channel to use all voice commands by default, with no role or requester requirement; members can opt out voluntarily, and administrators can disable it entirely.
- **Wake words are recognised by cloud STT, so speech segments are sent to the configured STT service before the wake word is confirmed.**
- The independent audio tracks of the main music Bot, the listener Bot and other Bots are never fed to STT. If speaker audio is picked up again by a member's microphone it is mixed into that member's track, so echo cancellation or headphones are recommended.
- Ordinary conversational transcription is not written to the audit channel; command feedback does not show the raw transcript and has mention parsing disabled.
- When a member opts out, the policy is disabled or the configuration is invalidated, in-progress voice work is cancelled and late results are not executed.

After the final transcript confirms a wake word, the listener locks onto the speaker, stops recording/transcribing other candidates and temporarily lowers the music volume. Listening and the original volume are restored when the command completes or after 8 seconds without a follow-up instruction.

At most 4 candidate users are processed concurrently per server and globally by default. Speakers beyond that are ignored; a successful wake-up takes exclusive use of the short window. Only wake words of at least 4 characters are used for the STT hint, and partial transcripts never execute commands, which avoids false triggers from noise. A single corrupted Opus packet may be dropped, but too many consecutive errors end that speech segment.

## Parameter Reference

| Variable | Default / Description |
|----------|-----------------------|
| `VOICE_LISTENER_ENABLED` | Only `true` enables login; the template defaults to `false` |
| `VOICE_LISTENER_TOKEN` | Token of the second Bot; must differ from the main Bot's |
| `VOICE_STT_PROVIDER` | `vercel-ai-gateway` or `openai-compatible` |
| `VOICE_STT_GATEWAY_API_KEY` | Gateway key |
| `VOICE_STT_GATEWAY_BASE_URL` | Custom public HTTPS Gateway; empty uses the default service |
| `VOICE_STT_BASE_URL`, `VOICE_STT_API_KEY` | OpenAI-compatible service address and key |
| `VOICE_STT_MODEL` | `xai/grok-stt` is recommended for the Gateway; `whisper-1` works with compatible services |
| `VOICE_STT_SAMPLE_RATE` | `24000` for the Gateway, `48000` in the compatible-service example |
| `VOICE_STT_TIMEOUT_MS` | Per-transcription timeout, `15000` milliseconds |
| `VOICE_CONTROL_MAX_GUILD_JOBS`, `VOICE_CONTROL_MAX_GLOBAL_JOBS` | `4` each |
| `VOICE_CONTROL_DUCK_VOLUME` | Temporary volume after wake-up, `15`; does not overwrite the saved volume |
| `VOICE_CONTROL_AI_CONFIDENCE` | AI execution threshold, `0.88` |
| `VOICE_CONTROL_AI_TIMEOUT_MS` | AI classification timeout, `8000` milliseconds |
| `VOICE_CONTROL_MAX_AI_JOBS` | AI classification concurrency cap, `2` |
| `VOICE_CONTROL_MAX_AI_PER_USER_MINUTE`, `VOICE_CONTROL_MAX_AI_PER_GUILD_MINUTE` | Per-minute AI classification caps, `4` and `12` |
| `VOICE_CONTROL_MAX_USER_SEGMENTS_PER_MINUTE`, `VOICE_CONTROL_MAX_GUILD_SEGMENTS_PER_MINUTE` | Per-minute uploaded speech segment caps, `12` and `60` |
| `VOICE_CONTROL_SEARCH_DEADLINE_MS` | Song request search deadline, `15000` milliseconds |
| `VOICE_CONTROL_COMMAND_DEADLINE_MS` | Per-command deadline, `30000` milliseconds |
| `VOICE_CONTROL_FOCUS_DEADLINE_MS` | Maximum duration of one wake-up focus, `45000` milliseconds |
| `VOICE_CONTROL_DEBUG` | Set to `1` to emit diagnostics; keep `0` in production |

The template is [`.env.example`](../.env.example). The parser can be verified safely on its own:

```bash
node --test --import ./test/setup.js test/voiceCommandParser.test.js
```
