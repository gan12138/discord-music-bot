# Discord Music Bot

基于 `discord.js` v14 的 Discord 音乐机器人，支持 YouTube、Bilibili、Spotify 转 YouTube、关键词搜索、播放队列、播放面板、播放列表、Radio 自动续播、AI 点歌、24/7 语音频道保持和可选的第二 Bot 语音控制。

当前项目推荐使用 **Lavalink** 作为主要播放后端。Bot 仍保留本地 `yt-dlp + ffmpeg` 播放链路，用于 `local` 后端或 Lavalink 无法播放时的回落。

当前版本：**2.0.0**。功能变化与旧版升级步骤见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- YouTube 单曲和播放列表播放。
- Bilibili 播放，支持 BV、AV 和 `b23.tv`；默认用 `yt-dlp` 解析临时音频直链，再优先交给 Lavalink HTTP 播放，运行中失败会自动回退本地播放。
- Spotify 歌曲、专辑和播放列表解析，并转换为 YouTube 结果播放。
- 关键词搜索和下拉菜单选歌。
- Lavalink 后端，降低 Bot 进程内转码压力。
- 本地后端，通过 `yt-dlp` 拉流、`ffmpeg` 转码。
- 暂停、继续、跳过、停止、音量、seek、循环、随机、移除队列歌曲。
- 播放控制面板和当前播放通知模式。
- 持久化播放列表。
- Radio 自动续播，可按风格、年代、语言和心情推荐歌曲。
- AI 点歌和 Radio AI 推荐，兼容 OpenAI Chat Completions API。
- 24/7 模式，让 Bot 尽量保持在语音频道。
- 手动点歌优先级高于 Radio：Radio 可以保持开启，但不会抢正在播放的手动歌曲。
- 播放事件按唯一 `playbackId` 去重，避免旧 `trackEnd`、`queueEnd` 或本地 `Idle` 跳过下一首。

## 项目结构

```text
src/index.js               Bot 运行入口
src/deploy-commands.js     Slash Commands 部署入口
src/commands/*.js          Slash 命令模块，自动加载
src/events/*.js            Discord 事件模块，自动加载
src/utils/player.js        播放、队列、Lavalink、Radio 核心逻辑
src/utils/playback.js      /play 等命令共用的入队逻辑
src/utils/playbackState.js 播放状态持久化
data/musicbot.json         播放列表、设置和部分播放状态
lavalink/application.yml   Lavalink 配置
```

## 运行要求

- Node.js `>=22.12.0`
- Discord Bot Token
- Discord Application ID，也就是 `CLIENT_ID`
- Lavalink 后端：Java 17+、Lavalink v4、Lavalink YouTube source plugin
- 元数据解析、搜索、Spotify 转 YouTube、Bilibili 解析和本地回落：系统可用的 `yt-dlp`
- 本地后端或播放回落：系统可用的 `ffmpeg`（需 `--enable-libopus`），或用 `FFMPEG_BIN` 显式指定；`ffmpeg-static` 仅作最后回退

## 快速开始

安装依赖：

```bash
npm ci
```

创建 `.env`：

```bash
cp .env.example .env
```

至少配置：

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
```

AI 是可选功能。启用时必须自行填写 `AI_BASE_URL`、`AI_API_KEY` 和 `AI_MODEL`；项目没有预设的私人中转服务地址。例如：

```env
AI_ENABLED=true
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=your_model_name
```

`AI_BASE_URL` 必须是公共 HTTPS 地址，不支持内网地址或含凭据、查询参数的 URL。

测试 Slash Commands 时可设置 `DISCORD_GUILD_ID`，这样只更新指定服务器并立即生效。全局命令部署默认被禁止，确认要修改真实应用的全局命令后，才设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true`。

推荐使用 Lavalink：

```env
PLAYER_BACKEND=lavalink
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
# Generate a unique high-entropy value and use it in the protected Bot and Lavalink environment files.
LAVALINK_PASSWORD=generate_a_unique_password
LAVALINK_SECURE=false
LAVALINK_NAME=main
```

启动 Lavalink（开发环境）：

```bash
cd lavalink
cp lavalink.env.example lavalink.env
# 编辑 lavalink.env，填写与 Bot 相同的密码；不要提交真实文件。
chmod 600 lavalink.env
set -a
. ./lavalink.env
set +a
java -jar Lavalink.jar
```

生产环境建议使用 `systemd`，不要把密码写入命令行或把日志写到公开可读文件。开发环境如需后台启动，请先通过受保护的环境文件导出 `LAVALINK_PASSWORD`：

```bash
cd lavalink
java -jar Lavalink.jar > lavalink.log 2>&1 &
```

部署 Slash Commands：

```bash
npm run deploy
```

`npm run deploy` 使用 `DISCORD_GUILD_ID` 时更新指定服务器；只有显式设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true` 才会更新全局应用命令。全局命令同步可能需要一些时间。

启动 Bot：

```bash
npm start
```

生产环境建议使用 `systemd`。开发环境如需后台启动 Bot：

```bash
npm start > bot.log 2>&1 &
```

生产部署时应先把项目安装到 `/opt/discord-music-bot`，创建 `discordbot` 和 `lavalink` 两个非 root 服务账号，并把 Bot/Lavalink 环境文件分别放到 `/etc/discord-music-bot/bot.env` 和 `/etc/discord-music-bot/lavalink.env`，权限设为 `0600` 或由对应服务组可读的 `0640`。systemd 模板通过 `/usr/bin/env node` 在系统 PATH 中查找 Node.js 22.12+；不要使用 Node 18 或依赖 nvm login shell。详细步骤见 [systemd/README.md](systemd/README.md)。

## npm 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 Bot |
| `npm run dev` | 使用 Node watch 模式启动 |
| `npm run deploy` | 部署指定服务器命令；全局部署需显式允许 |
| `npm run check` | 对 `src/**/*.js` 和 `src/*.js` 做语法检查 |
| `npm test` | 运行播放恢复、权限、数据、面板和语音单元测试 |
| `npm run check:voice-stt` | 安全探测 Gateway 短期转写 Token |

## Lavalink

当前 `lavalink/application.yml` 固定使用含 TV 客户端修复的 YouTube source plugin 快照，并关闭 Lavalink 内置 YouTube source。以下为关键配置；完整设置以 YAML 文件为准：

```yaml
lavalink:
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:f45bbb7aebfcbc1c553769e04af6cd43afa8b7c3"
      snapshot: true
  server:
    password: "${LAVALINK_PASSWORD}"
    sources:
      youtube: false
      soundcloud: true
      bandcamp: true
      twitch: true
      vimeo: true
      http: true
      local: false
    trackStuckThresholdMs: 30000

plugins:
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    remoteCipher:
      url: "http://127.0.0.1:8001"
      userAgent: "discord-music-bot"
    oauth:
      enabled: true
      refreshToken: "${YOUTUBE_OAUTH_REFRESH_TOKEN:}"
    clients:
      - MUSIC
      - TV
      - ANDROID_VR
      - TVHTML5_SIMPLY
      - WEBEMBEDDED
      - WEB
      - MWEB
```

说明：

- `sources.youtube: false` 是为了避免使用 Lavalink v4 内置 YouTube source。
- YouTube 播放由 `lavalink.plugins` 声明的固定快照处理，包含 `1.18.2` 之后的 TV User-Agent 和客户端版本修复；Lavalink 启动时会按配置安装插件。
- `MUSIC` 用于元数据和搜索；`TV` 是播放链中优先使用、支持 OAuth 的客户端。OAuth refresh token 只通过私有环境变量提供。
- 配置假定本机运行 `yt-cipher`（`127.0.0.1:8001`）和 poToken provider（`127.0.0.1:4416`）。辅助服务安装方法及 Token 定时刷新见 systemd 部署说明。
- `MUSIC` 在日志里可能显示为 `WEB_REMIX`，这是插件内部名称，不代表配置错误。
- `trackStuckThresholdMs: 30000` 用于减少 YouTube 取流慢时的误判 stuck。
- 不建议使用已知不稳定的 `ANDROID`、`IOS` client。
- Bilibili 不是由 Lavalink Bilibili source 直接解析。Bot 会先用 `yt-dlp --cookies ...` 解析出 `bilivideo.com` 音频直链，再使用 Lavalink 的 `http` source 播放。
- Bilibili 直链有过期时间；临时直链和过期时间不会写入持久化状态，恢复旧队列或播放前会重新解析。
- Bilibili 的 Lavalink 搜索、起播、`trackError`、`trackStuck`、载入或语音输出失败时，Bot 会对同一首歌回退到本地 `yt-dlp + ffmpeg`，并尽量从失败位置前约 3 秒继续。
- YouTube 遇到 Lavalink 登录验证、反机器人、签名解析、载入或运行中播放错误时，也会对同一首歌回退到本地 `yt-dlp + ffmpeg`。
- 本地回退只影响当前播放尝试；下一首歌曲仍会优先尝试 Lavalink。
- 本地流在源进程未正常结束、下游缓冲已耗尽且连续 `LOCAL_STREAM_STALL_MS` 没有新数据时会自动重试，仍失败则跳歌并在频道提示。清理子进程先发送 SIGTERM，卡住两秒后升级为 SIGKILL，避免残留 `yt-dlp`/`ffmpeg`。
- Lavalink `trackStart` 标记音轨开始，但只有服务端报告实际进度后才解除输出超时；本地使用 `AudioPlayerStatus.Playing` 确认输出。提交 `player.play()` 不等于确认已有音频输出。
- 每次播放都有唯一 `playbackId`。Lavalink `trackEnd`、`queueEnd`、`trackError`、`trackStuck` 和本地资源 `Idle` 只有在 ID 匹配时才能结束当前播放，而且同一个 ID 只能结束一次。
- 后端切换期间使用 `startingBackend` 和 `backendTransitioning` 阻止语音状态恢复重复启动旧后端。Lavalink 回退本地时可能出现一次正常的离开再加入，但不应连续反复进出频道。
- `src/utils/player.js` 使用 `activeBackend` 跟踪当前实际播放后端，暂停、继续、跳过等控制应按 `activeBackend` 路由，而不是只看 `PLAYER_BACKEND`。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DISCORD_TOKEN` | 是 | Discord Bot Token |
| `CLIENT_ID` | 是 | Discord Application ID |
| `PLAYER_BACKEND` | 否 | `lavalink` 或 `local`，默认示例推荐 `lavalink` |
| `LAVALINK_HOST` | Lavalink 时 | Lavalink 地址，通常 `127.0.0.1` |
| `LAVALINK_PORT` | Lavalink 时 | Lavalink 端口，默认 `2333` |
| `LAVALINK_PASSWORD` | Lavalink 时 | 必须在 Bot 和 Lavalink 的受保护环境文件中配置同一个唯一值 |
| `LAVALINK_SECURE` | 否 | 是否使用 HTTPS/WSS |
| `LAVALINK_NAME` | 否 | Lavalink 节点名称 |
| `LAVALINK_RETRY_AMOUNT` | 否 | 节点 WebSocket 连续重连次数，默认 `12`，用于覆盖较慢的 Lavalink/JVM 重启 |
| `LAVALINK_RETRY_DELAY_MS` | 否 | 节点重连间隔，默认 `10000` 毫秒；耗尽后 Bot 仍会重新创建节点并继续恢复 |
| `AI_ENABLED` | 否 | 是否启用 `/ai-music` 和 AI 能力 |
| `AI_BASE_URL` | AI 时 | 自行配置的公共 HTTPS OpenAI-compatible API 地址；无预设私人地址 |
| `AI_API_KEY` | AI 时 | AI API key |
| `AI_MODEL` | 否 | AI 模型名 |
| `AI_TIMEOUT_MS` | 否 | AI 请求超时 |
| `RADIO_AI_ENABLED` | 否 | 是否让 Radio 使用 AI 生成推荐搜索词 |
| `YTDLP_COOKIE_FILES` | 否 | `yt-dlp --cookies` 文件路径（旧版通用名，现仅作为 Bilibili 的回落）。使用逗号分隔列表中的第一个路径 |
| `YTDLP_BILIBILI_COOKIE_FILES` | 否 | Bilibili 专用 cookies（Netscape 格式，含 `SESSDATA` 等），覆盖 `YTDLP_COOKIE_FILES` |
| `YTDLP_YOUTUBE_COOKIE_FILES` | 否 | YouTube 专用 cookies；不会回落到 Bilibili cookies，避免跨平台泄露登录凭据 |
| `YTDLP_MAX_CONCURRENT` | 否 | 并发 `yt-dlp` 元数据和搜索进程上限，默认 `6` |
| `AUDIO_BUFFER_MB` | 否 | 本地播放音频流缓冲大小，默认 `8` |
| `AUDIO_PREBUFFER_MS` | 否 | 本地播放起播前最多等待预缓冲的时间，默认 `1500` 毫秒 |
| `LOCAL_STREAM_STALL_MS` | 否 | 本地播放持续无音频数据判定断流的时间，默认 `20000` 毫秒；触发后自动重试/跳歌并在频道提示 |
| `AUDIO_NORMALIZATION` | 否 | 是否在本地 ffmpeg 链路启用音频标准化 |
| `FFMPEG_BIN` | 否 | 覆盖本地播放/Lavalink 回落使用的 ffmpeg 二进制路径；默认解析顺序为 `FFMPEG_BIN` → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → PATH 中的 `ffmpeg` → 打包的 `ffmpeg-static`，二进制必须启用 `--enable-libopus` |
| `PLAYER_DEBUG` | 否 | 播放调试日志 |
| `RADIO_DEBUG` | 否 | Radio 调试日志 |
| `PLAY_TIMING` | 否 | 输出点歌和起播各阶段耗时 |
| `VOICE_DEBUG` | 否 | 输出经过脱敏处理的 Discord 语音状态日志 |
| `VOICE_LISTENER_TOKEN` | 否 | 独立监听 Bot Token；未配置时语音控制优雅禁用，主音乐 Bot 正常运行 |
| `VOICE_LISTENER_ENABLED` | 否 | 只有显式设为 `true` 才登录独立监听 Bot；`false`、空值及非法值都关闭 |
| `VOICE_STT_PROVIDER` | 语音控制时 | `vercel-ai-gateway` 或 `openai-compatible` |
| `VOICE_STT_GATEWAY_API_KEY` | Gateway 语音控制时 | Vercel AI Gateway API Key，不要填 NewAPI Key |
| `VOICE_STT_GATEWAY_BASE_URL` | 否 | 自定义 AI Gateway 地址；默认使用 Vercel AI Gateway |
| `VOICE_STT_BASE_URL` | OpenAI-compatible 时 | OpenAI-compatible API 根地址，代码会请求 `/audio/transcriptions` |
| `VOICE_STT_API_KEY` | OpenAI-compatible 时 | OpenAI-compatible STT API key |
| `VOICE_STT_MODEL` | 否 | Gateway 推荐 `xai/grok-stt`；OpenAI-compatible 可使用 `whisper-1` 等 |
| `VOICE_STT_SAMPLE_RATE` | 否 | Gateway `grok-stt` 使用 `24000` Hz PCM16 mono |
| `VOICE_STT_TIMEOUT_MS` | 否 | 单次 STT 超时，默认 `15000` 毫秒 |
| `VOICE_CONTROL_DEBUG` | 否 | 测试时输出语音分段、转写和解析诊断；生产环境保持 `0` |
| `VOICE_CONTROL_MAX_GUILD_JOBS` | 否 | 单个服务器同时监听的候选用户上限，默认 `4` |
| `VOICE_CONTROL_MAX_GLOBAL_JOBS` | 否 | 所有服务器合计的并发流式 STT 上限，默认 `4` |
| `VOICE_CONTROL_DUCK_VOLUME` | 否 | 识别到唤醒词后临时降低到的音量百分比，默认 `15`；不会覆盖保存音量 |
| `VOICE_CONTROL_AI_CONFIDENCE` | 否 | AI 语音意图执行阈值，默认 `0.88` |
| `VOICE_CONTROL_AI_TIMEOUT_MS` | 否 | AI 语音意图分类超时，默认 `8000` 毫秒 |
| `VOICE_CONTROL_MAX_AI_JOBS` | 否 | 同时执行的 AI 语音分类上限，默认 `2` |
| `VOICE_CONTROL_MAX_AI_PER_USER_MINUTE` | 否 | 每位用户每分钟 AI 语音分类上限，默认 `4` |
| `VOICE_CONTROL_MAX_AI_PER_GUILD_MINUTE` | 否 | 每服务器每分钟 AI 语音分类上限，默认 `12` |
| `VOICE_CONTROL_MAX_USER_SEGMENTS_PER_MINUTE` | 否 | 每位用户每分钟上传的候选语音段上限，默认 `12` |
| `VOICE_CONTROL_MAX_GUILD_SEGMENTS_PER_MINUTE` | 否 | 每服务器每分钟上传的候选语音段上限，默认 `60` |
| `VOICE_CONTROL_SEARCH_DEADLINE_MS` | 否 | 语音点歌搜索期限，默认 `15000` 毫秒，超时会终止 `yt-dlp` 搜索并反馈 |
| `VOICE_CONTROL_COMMAND_DEADLINE_MS` | 否 | 单条语音命令执行期限，默认 `30000` 毫秒 |
| `VOICE_CONTROL_FOCUS_DEADLINE_MS` | 否 | 单次唤醒焦点的最长生命周期，默认 `45000` 毫秒 |

## 命令列表

| 命令 | 说明 |
|------|------|
| `/play <链接/关键词>` | 播放 YouTube、Bilibili、Spotify 或搜索关键词 |
| `/search <关键词>` | 搜索 YouTube 视频 |
| `/queue [页码]` | 查看播放队列 |
| `/nowplaying` | 查看当前播放 |
| `/skip` | 跳过当前歌曲 |
| `/pause` | 暂停播放 |
| `/resume` | 继续播放 |
| `/stop` | 停止播放并清空队列 |
| `/volume <0-100>` | 调整音量 |
| `/seek <时间>` | 跳转到指定时间，支持 `90`、`1:30`、`01:02:03` |
| `/filter <模式>` | 设置音频滤镜 |
| `/shuffle` | 随机打乱手动队列 |
| `/loop <模式>` | 设置循环模式 |
| `/remove <位置>` | 移除队列中的歌曲 |
| `/playlist` | 管理持久化播放列表 |
| `/radio` | 自动续播、风格电台和 AI 自动识别 |
| `/audio` | `/radio` 的别名 |
| `/ai-music <需求>` | 用自然语言让 AI 点歌 |
| `/247` | 24/7 语音频道保持模式 |
| `/panel` | 显示播放控制面板 |
| `/notify` | 设置当前播放通知方式 |
| `/version` | 设置 AI/Radio 的版本偏好 |
| `/settings dj-role` | 设置或清除音乐控制 DJ 角色（ManageGuild） |
| `/help` | 显示帮助信息 |
| `/voice-control` | ManageGuild 管理员配置监听、STT 策略、唤醒词、权限、审计、语言和诊断 |
| `/voice-consent` | 用户授权、退出或重新加入云 STT |

## 语音控制

语音控制使用第二个 Discord Bot 接收音频，主 Bot 继续负责 Lavalink 和本地 fallback 播放。第二 Bot 必须加入与主音乐 Bot 相同的服务器，并具有目标语音频道的 `Connect` 和 `View Channel` 权限；它以自我静音、非自我耳聋方式跟随主 Bot 的实际语音频道。播放面板上的“语音 Bot 加入/离开”按钮仅限管理服务器权限使用，用于控制监听 Bot 是否跟随进入频道；它不会开启云 STT，也不会替用户授予语音授权。

隐私保护：所有现有和未来服务器默认启用全员 STT 与全员语音命令，所有与主音乐 Bot 位于同一频道的真人都可直接使用，不需要逐个授权、角色或点播者身份。管理员可使用 `/voice-control stt-policy mode:off` 完全关闭；成员仍可使用 `/voice-consent revoke` 立即退出并停止进行中的处理，再使用 `/voice-consent grant` 重新加入。

唤醒词本身依赖云 STT 识别，因此同频道真人开始讲话后，讲话片段会在最终确认唤醒词之前发送给配置的 STT provider。主音乐 Bot、监听 Bot 和其他 Bot 的音轨始终不会送入 STT。

`xai/grok-stt` 使用 Vercel AI Gateway 的短期 Token 和 WebSocket 流式转写，不经过 NewAPI 的 `/audio/transcriptions`。配置示例：

```env
VOICE_LISTENER_ENABLED=true
VOICE_LISTENER_TOKEN=second_bot_token

VOICE_STT_PROVIDER=vercel-ai-gateway
VOICE_STT_GATEWAY_API_KEY=vercel_ai_gateway_key
VOICE_STT_MODEL=xai/grok-stt
VOICE_STT_SAMPLE_RATE=24000
VOICE_STT_TIMEOUT_MS=15000
```

如果使用自己配置的兼容 Gateway，并与 OpenAI-compatible 服务复用同一个 Key，可配置（示例域名需替换）：

```env
VOICE_STT_PROVIDER=vercel-ai-gateway
VOICE_STT_GATEWAY_BASE_URL=https://gateway.example.com
VOICE_STT_GATEWAY_API_KEY=
VOICE_STT_API_KEY=shared_key
VOICE_STT_MODEL=xai/grok-stt
VOICE_STT_SAMPLE_RATE=24000
```

只有显式设置 `VOICE_STT_GATEWAY_BASE_URL` 时，Gateway Provider 才会回退使用 `VOICE_STT_API_KEY`，避免默认情况下把兼容服务的 Key 误发给 Vercel。

兼容 Gateway 用长期 Key 签发单次 `vcst_` 短期 Token；音频连接由 Token 响应中的转写 WebSocket 地址及代码 allowlist 决定。

监听 Bot 将每位成员的 Discord Opus 独立音轨逐包容错解码为 `24 kHz / 16-bit signed little-endian / mono PCM`。单个损坏的 Opus 包会被丢弃而不会终止整段录音；讲话结束后，完整 PCM 通过有限且明确关闭的输入流提交给 Gateway。普通聊天转写不会写入审计频道。

只有长度至少 4 个字的唤醒词会作为 xAI STT 的 `keyterm` 提示发送。播放、暂停、上一首和下一首等命令词不会作为提示词，避免 STT 在噪声或扬声器回声下把整套提示词回吐成虚假命令。partial transcript 只用于诊断；必须等最终转写确认唤醒词后，才会锁定说话者、降低音量或执行命令。最多保存 10 个唤醒词，重叠时优先匹配最长的词。

使用 `/voice-control understanding` 可以切换语音理解模式：

- `AI 平衡模式`：精确唤醒词加标准命令由本地规则直接执行；长度至少 4 个字的唤醒词允许一个字的漏字或少量常见 STT 混淆。任何模糊唤醒都必须经过 AI 确认，不能直接执行。规则未理解但已确认精确唤醒时，也会使用现有 `AI_ENABLED`、`AI_API_KEY` 和 `AI_MODEL` 配置进行一次严格的语音意图分类。只有置信度达到 `VOICE_CONTROL_AI_CONFIDENCE`、证据可以在用户原话中验证且命令当前仍启用时才会执行。
- `严格模式`：只使用精确唤醒词和固定命令，不调用 AI。

AI 平衡模式可以理解例如“音乐手我想听罗大佑童年”“音乐助手罗大佑童年”“音乐住手接着放”“音乐助手返回刚才那首”“音樂助理呢首唔好聽換歌”。普通句子中间提到助手、歌曲歌词以及只识别到过短的“音乐”不会进入 AI。“音乐歌手/音乐选手/音乐新手/音乐助教/音乐助力/音乐助眠”等普通词也不会作为模糊唤醒。AI 不确定时不会执行。命令结果、未识别、未找到、搜索超时和播放失败优先发送到审计频道；未设置审计频道时回退到当前音乐文字频道。反馈不显示原始转写，并禁用 mention 解析；用户和服务器都有反馈冷却、语音段和 AI 每分钟配额。

服务器可以使用 `/voice-control language` 选择“普通话 + 粤语”“普通话”或“粤语”。混合模式同时支持例如：

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

最终转写确认唤醒词后，监听器会在该服务器锁定说话者、终止其他候选用户的录音和 STT，并临时降低音乐音量。命令执行完成或 8 秒无后续指令时会恢复其他用户监听和原有保存音量。主音乐 Bot、监听 Bot和其他 Bot的 Discord 用户音轨始终不会送入 STT；如果音箱声音经成员麦克风回录，它已经混入该成员音轨，仍建议开启 Discord 回声消除或使用耳机。

默认每服务器和全局最多同时监听 4 个候选用户。超过上限的新说话者会被忽略；一旦有人成功说出唤醒词，该用户会独占监听窗口。`/voice-control diagnostics` 会显示当前焦点用户以及因焦点或并发上限被忽略的次数。

填入 Gateway Key 后，可在不登录监听 Bot、不上传成员语音的情况下测试短期 Token：

```bash
npm run check:voice-stt
```

如果改用支持 OpenAI Audio Transcriptions API 的服务，可切换为：

```env
VOICE_STT_PROVIDER=openai-compatible
VOICE_STT_BASE_URL=https://api.openai.com/v1
VOICE_STT_API_KEY=stt_key
VOICE_STT_MODEL=whisper-1
VOICE_STT_SAMPLE_RATE=48000
```

服务器设置默认允许语音控制，但监听 Bot 只有在显式设置 `VOICE_LISTENER_ENABLED=true` 并完成 Token/STT 配置后才会运行。`/voice-control enable` 会恢复全员 STT、自动跟随和全部语音命令。常用管理入口包括 `stt-policy`、`wakeword`、`audit-channel`、`language`、`test` 和 `diagnostics`。`/voice-control cloud-stt enabled:true` 同样开启全员模式。公开和私密播放面板会显示当前 STT 策略、语言模式和全部唤醒词。

语音解析要求唤醒词位于句首附近，例如“音乐助手，暂停”或“音乐助手，播放歌曲名”。也可以先单独说唤醒词，再在短窗口内说“上一首”或“下一首”。普通句子中间出现唤醒词不会触发。

安全运行 parser 单测：

```bash
node --test --import ./test/setup.js test/voiceCommandParser.test.js
```

## Radio 行为

Radio 是自动续播系统。它可以保持开启，但不会抢手动点歌。

- 手动 `/play` 永远优先于 Radio。
- 如果 Radio 正在播放，用户 `/play` 会把歌曲加入手动队列；当前歌曲自然结束后优先播放手动歌曲。
- Radio 开关不会因为手动点歌被关闭。
- 手动歌播放期间，Radio 不会插队。
- 手动队列播完后，如果 Radio 仍开启，它会继续自动续播。
- `/radio start`、`/radio reset` 和面板 Radio 按钮在手动歌播放中只会开启或刷新 Radio，不会立即抢播。
- 手动点歌、关闭或重置 Radio、更改 Radio 风格、自动识别切换风格、修改 `/version` 时都会使旧的异步推荐任务失效；旧任务完成后不能把过期推荐重新放回队列。

Radio 子命令：

| 命令 | 说明 |
|------|------|
| `/radio start` | 开启自动续播 |
| `/radio stop` | 关闭自动续播，手动队列不受影响 |
| `/radio status` | 查看自动续播状态 |
| `/radio style` | 设置风格、年代、语言、心情 |
| `/radio autodetect <true/false>` | 开关 AI 自动风格识别 |
| `/radio reset` | 清空 Radio 缓存并重新生成推荐 |

## 24/7 行为

| 命令 | 说明 |
|------|------|
| `/247 on` | 开启 24/7 模式 |
| `/247 off` | 关闭 24/7 模式 |
| `/247 status` | 查看状态 |

24/7 只负责保持连接，不应该抢占用户手动点歌。频道无人时，正在播放的歌曲允许自然播完，但不会继续消费手动队列或生成 Radio 推荐；有人回来后再从保留的队列继续。Bot 重启时会尝试恢复 24/7 语音频道状态。Lavalink 节点未 ready 时保留待恢复状态；YouTube 或 Bilibili 的单曲载入/播放失败则可以使用本地 `yt-dlp + ffmpeg` 回退。

## 播放列表

| 命令 | 说明 |
|------|------|
| `/playlist create <名称>` | 创建播放列表 |
| `/playlist delete <名称>` | 删除播放列表 |
| `/playlist list` | 查看播放列表 |
| `/playlist add <名称> <链接>` | 添加歌曲到播放列表 |
| `/playlist show <名称>` | 查看播放列表内容 |
| `/playlist play <名称>` | 播放播放列表 |

## 数据和状态

- `data/musicbot.json` 保存播放列表、服务器设置、Radio 状态、24/7 状态和部分恢复状态。
- `musicQueue` 中的运行时播放队列保存在内存里，进程退出后不会完整保留。
- 当前播放状态会保存必要信息用于 24/7 恢复。
- `audioUrl`、`audioUrlExpiresAt`、播放 ID、后端切换状态和本次 fallback 状态属于临时数据，不会持久化。
- `data/musicbot.json` 可能包含真实 guild id、channel id、user id、播放列表和历史数据，不应公开提交。

发布仓库只包含源码、测试和通用配置模板。`.env`、`*.env`、Cookie 导出、`data/` 运行数据及备份、日志和录音均应留在部署环境；模板中的密钥和密码均为空值。分享日志前应移除凭据、签名音频 URL 和用户标识。

## 常用运维命令

查看进程：

```bash
ps -eo pid,cmd | rg 'Lavalink.jar|node src/index.js'
```

查看日志：

```bash
tail -n 100 bot.log
tail -n 100 lavalink/lavalink.log
```

生产环境优先使用 `journalctl -u discord-music-bot -u lavalink`。Lavalink 请求日志已关闭，仍不要直接分享原始日志；语音 token、签名媒体 URL、Cookie 和授权信息都应在分享前脱敏。

重启示例。机器上可能同时运行其他目录的 Bot，终止进程前应先核对工作目录：

```bash
pwdx <bot_pid>
kill -TERM <bot_pid>
nohup npm start > bot.log 2>&1 &
```

Bot 使用 `data/bot.pid` 防止同一工作目录重复启动。不要直接删除有效锁文件；只有确认其中 PID 已不存在时，才把它当作过期锁处理。一般修复 Bot 代码不需要重启 Lavalink。

## 故障排查

### Bot 没上线

检查 `.env` 是否包含：

```env
DISCORD_TOKEN=...
CLIENT_ID=...
```

然后查看：

```bash
tail -n 100 bot.log
```

### Slash Commands 没更新

```bash
npm run deploy
```

全局命令同步可能需要一些时间。

### Lavalink 连接失败

确认 Lavalink 已运行：

```bash
ps -eo pid,cmd | rg Lavalink.jar
```

确认日志出现：

```text
Lavalink is ready to accept connections.
```

确认 Bot 环境文件和 Lavalink 私有环境文件中的 `LAVALINK_PASSWORD` 一致；YAML 只引用环境变量。

### 有声音但疯狂跳歌

这通常不是音频链路问题，而是队列推进或 Radio 状态抢占问题。当前代码已经做了以下保护：

- 手动点歌会进入高优先级手动队列，当前 Radio 歌曲结束后先播放手动歌曲。
- 手动队列没播完前 Radio 不接管。
- Lavalink track 和本地 AudioResource 都携带唯一 `playbackId`。
- 一首歌的多个结束、错误或 stuck 事件只能认领一次终止处理。
- `startingBackend` 和 `backendTransitioning` 会阻止起播或切换期间重复恢复旧后端。
- `ensurePlaybackOutput()` 不会在起播或后端切换中重复提交同一首歌。
- 并发 `advance()` 会等待已有推进完成。

如果仍复现，请查看：

```bash
tail -n 200 bot.log
tail -n 200 lavalink/lavalink.log
```

重点搜索：

```text
PlaybackError
PlaybackRetry
PlaybackSkipAfterError
track start
track error
track stuck
queue end observed
Bilibili
start timeout
advance ignored
got stuck
Attempt to execute executor
```

### YouTube lookup 或播放失败

常见原因是远端读取超时、YouTube client 失效、签名解密、poToken 或登录限制。`This video is not available` 只表示当前访问方式无法取得音频，不等于视频已删除。

#### 网络超时与恢复策略

`lavalink/application.yml` 为 Lavalink 4.2.2 配置 HTTP 连接超时 5 秒、连接池等待 3 秒、读取超时 8 秒（底层原默认均为 3 秒）。这是 `lavalink.server.timeouts`，与 Bot 的 `LAVALINK_RETRY_DELAY_MS` 节点重连参数不同。

- 聚合异常优先识别 OAuth TV/TVHTML5 客户端；其读取超时不会被其他客户端的 403/登录限制掩盖。
- 明确的临时网络失败先在 Lavalink 重试一次，再回退本地 `yt-dlp + ffmpeg`。仅本地回退需要语音连接切换。
- 本地网络超时/断流最多重试两次；模糊不可用、403、无可用格式最多再确认一次；明确内容限制或环境错误不重复尝试。
- `PLAYBACK_RECOVERY_TIMEOUT_MS=45000` 限制一轮起播/恢复的等待预算，各后端和同曲替代共享。真正开始输出音频后解除起播看门狗，持续推进约 30 秒后重置恢复预算；后续断流开启新一轮恢复。暂停不算持续推进。
- `LAVALINK_TRACK_RETRY_DELAY_MS=1000` 控制那一次同后端重试的等待，额外加入小于 200ms 的随机延迟。
- 重试等待、Radio 替代搜索在状态锁外执行。停止、跳过可以取消旧任务，迟到的结束事件按 playback ID 丢弃。
- 故障提示区分超时、访问验证、不可用及环境错误；无人语音频道仍通过 `sendPlaybackNotice()` 抑制诊断通知。

#### Radio 失败链接与换源

穷尽播放路径后，视频 ID 默认冷却 10 分钟，反复失败逐步延长至 1 小时；明确删除/私有/地区限制冷却 24 小时。记录在有容量上限（1000 项）的进程内缓存中，重启后清空。Lavalink 单独失败但本地成功不会封锁整首歌；服务离线、进程崩溃和环境故障不加入视频冷却。

Radio 在候选筛选、历史回收和出队时检查冷却；用户主动点同一个链接仍可重新尝试。只有自动续播会尝试最多两个同曲上传版本，共享剩余恢复预算。匹配要求歌名、可识别的歌手信息、相近时长及相同现场/普通版本；排除翻唱、伴奏、混音和已失败 ID，信息不足就跳到下一首。手动指定的 URL 不自动替换。

#### yt-dlp JavaScript 解密组件

Node 运行时和 EJS solver 都必须可用。pip 安装时使用默认依赖组，保证 `yt-dlp-ejs` 与 yt-dlp 版本匹配：

```bash
python3 -m pip install -U 'yt-dlp[default]'
python3 -m pip show yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider
yt-dlp --version
node --version
```

在 Bot 实际使用的 Python/PATH 环境执行。参考验证组合为 `yt-dlp 2026.8.19`、`yt-dlp-ejs 0.8.0`、`bgutil-ytdlp-pot-provider 1.3.2`（容器也是 1.3.2）。缺少 EJS 会导致签名/n-challenge 解析失败；升级 yt-dlp 时同步更新其要求的 EJS 版本。

Lavalink 的 OAuth 不会自动提供给本地 yt-dlp。需要 YouTube 登录态时，使用 `YTDLP_YOUTUBE_COOKIE_FILES` 的 Netscape cookies；Bilibili 的 cookies 不会用于 YouTube。

#### 验证与上线

必须验证完整音频下载，不能只检查搜索、标题或 `-g` 返回的 URL。例如在已有临时目录中运行：

```bash
yt-dlp --js-runtimes node --force-ipv4 --socket-timeout 20 \
  --retries 2 --fragment-retries 2 --no-playlist \
  -f 'bestaudio[ext=webm]/bestaudio' \
  -o '/tmp/%(id)s.%(ext)s' 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
npm run check
npm test
journalctl -u discord-music-bot.service -u lavalink.service --since '1 hour ago' --no-pager
```

日志中的 `[PlaybackRecovery]` 包含分类、同后端重试、换源次数及稳定播放结果/耗时；`[PlaybackSkipAfterError]` 表示恢复耗尽。Lavalink 音源也可用 `GET /youtube/stream/{videoId}` 检查，应读取完整响应体；省略 `withClient=TV`，因为 TV 无元数据能力。本次快照还观察到该接口把未知内容长度作为 `Content-Length: 9223372036854775807` 返回：Node fetch 会在响应关闭时报 `terminated`。收到 200 或能解析部分音频均不足以确认完整播放，应结合帧时长或 Bot 实际持续播放验证。

Bot 代码修改在重启 Bot 后生效，YAML 超时配置在重启 Lavalink 后生效；环境中的 EJS 安装对后续新启动的 yt-dlp 进程生效。实际重启需安排播放中断窗口。路由修改后验收 YouTube/Bilibili 各自的暂停、继续、跳过，双向切歌，以及回退期间停止/跳过。回滚仅恢复本次修改的文件/配置，保留已有工作区变更。

### Bilibili 或本地后端失败

Bilibili 的正常路径是：

1. Bot 用 `yt-dlp` 和 `YTDLP_BILIBILI_COOKIE_FILES`（兼容回落到 `YTDLP_COOKIE_FILES`）解析 Bilibili 视频信息和音频直链。
2. 如果 `PLAYER_BACKEND=lavalink` 且直链未过期，Bot 把 `bilivideo.com` 音频直链交给 Lavalink HTTP source 播放。
3. 如果 Lavalink 播放该直链失败，Bot 回退到本地 `yt-dlp + ffmpeg`。

本地回退会使用原始 Bilibili 页面 URL，并让 `yt-dlp` 携带 cookies、Referer 和 User-Agent 拉流，不会直接依赖已经失败的临时 CDN 直链。后端切换需要从 Lavalink 语音连接改为真实 Discord VoiceConnection，因此可能看到 Bot 正常离开再加入一次。

确认系统命令可用：

```bash
yt-dlp --version
ffmpeg -version
```

如果遇到 403、412、年龄验证、登录验证或 bot 检测，可以配置：

```env
YTDLP_BILIBILI_COOKIE_FILES=/path/to/cookies.txt
```

建议使用 Netscape `cookies.txt` 格式。有效的 Bilibili 登录 cookies 通常应包含 `SESSDATA`、`DedeUserID`、`bili_jct` 等字段。cookies 文件包含登录态，不要提交或分享。

验证 cookies 和 Bilibili 解析：

```bash
yt-dlp --cookies "/path/to/cookies.txt" --referer "https://www.bilibili.com" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" --dump-json --no-download "https://www.bilibili.com/video/<video-id>/"
```

如果日志出现：

```text
[Bilibili] using direct audio URL via Lavalink
```

表示 Bilibili 正在通过 Lavalink HTTP 播放直链。如果出现：

```text
[Bilibili] Lavalink direct URL failed, falling back to local yt-dlp
```

表示已回退到本地播放链路。

如果 Bot 在回退时连续多次离开、加入频道，检查代码是否在 `startingBackend` 或 `backendTransitioning` 期间调用了 `ensurePlaybackOutput()`。正常回退最多需要一次后端连接切换，不应循环切换。

### 没有声音

检查顺序：

- Bot 是否在正确语音频道。
- Bot 是否有 `Connect` 和 `Speak` 权限。
- Lavalink 是否 ready 并已连接。
- `bot.log` 是否有 `[Lavalink] node connected: main`。
- `lavalink.log` 是否有 `PATCH /v4/sessions/.../players/... track`。
- 如果是 Bilibili，`bot.log` 是否有 `[Bilibili] using direct audio URL via Lavalink` 或 fallback 日志。
- Discord 客户端是否把 Bot 静音或音量拉低。

### 面板按钮无效

暂停、继续、跳过等控制依赖当前实际播放后端：

- Lavalink 起播成功时 `activeBackend` 应为 `lavalink`。
- 本地 fallback 起播成功时 `activeBackend` 应为 `local`。
- 控制函数应按 `activeBackend` 路由，不要只按全局 `PLAYER_BACKEND` 判断。

如果按钮显示成功但实际没变化，优先查看 `bot.log` 中的 `player:pause`、`player:next`、`Bilibili`、`Lavalink`、`Voice` 相关日志。按钮代码应该检查 `MusicPlayer.pause()` / `resume()` / `skip()` 返回值，避免假成功提示。

## 开发注意事项

- 项目是 ESM，`package.json` 中设置了 `"type": "module"`。
- 命令模块必须导出 `data` 和 `execute`。
- 事件模块必须导出 `name`、`once` 和 `execute`。
- 没有 repo-defined lint 或 format 脚本；语法检查使用 `npm run check`，单元测试使用 `npm test`。
- `npm run deploy` 会修改真实 Discord 命令；优先使用 `DISCORD_GUILD_ID`，全局更新需显式允许。
- `.env`、日志和 `data/musicbot.json` 可能包含敏感信息，不应公开。
- 修改播放控制、Bilibili、Lavalink 或本地 fallback 时，需要同时测试 YouTube、Bilibili、YouTube -> Bilibili、Bilibili -> YouTube 的暂停、继续和跳过。
- 修改播放结束事件时，必须验证 `trackError -> trackEnd/queueEnd`、`trackStuck -> queueEnd` 和旧本地 `Idle` 都只推进一次队列。
- 修改后端切换时，必须验证 Bilibili Lavalink 回退本地最多只离开再加入一次，并且下一首 YouTube 能切回 Lavalink。

## 许可和使用

本项目仅供学习和个人使用。请遵守 YouTube、Bilibili、Spotify、Discord 和相关服务的条款，不要用于侵犯版权或违反当地法律的用途。
