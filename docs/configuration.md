# 配置指南

[返回首页](../README.md) · [使用指南](usage.md) · [语音控制](voice-control.md) · [故障排查](troubleshooting.md)

## 运行要求

- Node.js `>=22.12.0`。
- 系统可用的 `yt-dlp`，用于搜索、元数据解析和本地播放。
- 支持 `--enable-libopus` 的 ffmpeg，用于本地播放或 Lavalink 回退。
- 使用 Lavalink 时还需要 Java 17+、Lavalink v4 和 YouTube 插件。

pip 安装 yt-dlp 时使用默认依赖组，包含配套的 EJS 解密组件：

```bash
python3 -m pip install -U 'yt-dlp[default]'
yt-dlp --version
node --version
ffmpeg -version
```

在 Bot 实际使用的 Python/PATH 环境安装。参考组合为 `yt-dlp 2026.8.19`、`yt-dlp-ejs 0.8.0`、bgutil 插件/容器 `1.3.2`；升级时保持相关版本匹配。

## Discord 与基础配置

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用并添加 Bot。
2. 获取 Bot Token 和应用 ID，用 `bot`、`applications.commands` scope 将 Bot 加入服务器。
3. 给 Bot 目标语音频道的查看、连接、说话权限，以及目标文字频道的发送消息、嵌入链接权限。
4. 复制 [`.env.example`](../.env.example) 为 `.env`，填写真实值。不要提交真实配置。

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_test_guild_id_here
PLAYER_BACKEND=local
```

| 变量 | 说明 |
|------|------|
| `DISCORD_TOKEN` | 必填，音乐 Bot 的 Token |
| `CLIENT_ID` | 必填，Discord 应用 ID |
| `DISCORD_GUILD_ID` | 部署到指定服务器时填写，命令立即更新 |
| `ALLOW_GLOBAL_COMMAND_DEPLOY` | 只有显式为 `true` 才允许全局命令部署 |
| `PLAYER_BACKEND` | `local` 或 `lavalink`；模板默认推荐 `lavalink`，首页快速开始使用 `local` |

编辑后运行：

```bash
npm run deploy
npm start
```

`npm run deploy` 会修改真实 Discord 命令。有服务器 ID 时仅更新该服务器；没有服务器 ID 时需要显式允许全局部署，全局同步可能需要一些时间。

## AI 点歌与 Radio

AI 是可选功能，兼容 OpenAI Chat Completions API。启用时必须配置自己的地址、Key 和模型，项目没有预设的私人中转地址。

```env
AI_ENABLED=true
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=your_model_name
RADIO_AI_ENABLED=false
```

| 变量 | 说明 |
|------|------|
| `AI_ENABLED` | 是否启用 AI 点歌等能力 |
| `AI_BASE_URL` | AI 启用时必填，公共 HTTPS API 地址 |
| `AI_API_KEY` | AI 启用时必填，实际服务密钥 |
| `AI_MODEL` | 填写服务支持的模型名 |
| `AI_TIMEOUT_MS` | 请求超时，默认 `15000` 毫秒 |
| `RADIO_AI_ENABLED` | 是否让 Radio 使用 AI 推荐查询词，模板默认关闭 |

API 地址不支持内网、HTTP、内嵌凭据或查询参数。`/version` 可设置 AI/Radio 的现场或普通版本偏好，不影响普通 `/play`。

## Cookie

Cookie 使用 Netscape `cookies.txt` 格式。每项可以填写逗号分隔路径，实际使用第一个非空路径。

```env
YTDLP_BILIBILI_COOKIE_FILES=/path/to/bilibili-cookies.txt
YTDLP_YOUTUBE_COOKIE_FILES=/path/to/youtube-cookies.txt
```

| 变量 | 用途 |
|------|------|
| `YTDLP_BILIBILI_COOKIE_FILES` | Bilibili 登录 Cookie，优先使用 |
| `YTDLP_COOKIE_FILES` | 旧配置名，仅作为 Bilibili 的兼容回退 |
| `YTDLP_YOUTUBE_COOKIE_FILES` | YouTube 专用 Cookie，不回退到 Bilibili 的配置 |

Bilibili 登录 Cookie 通常包含 `SESSDATA`、`DedeUserID`、`bili_jct`。Lavalink 的 YouTube OAuth 不会自动提供给本地 yt-dlp，两者需分别配置。

## Lavalink 后端

Lavalink 在独立进程中处理播放，降低 Bot 内转码压力；无法播放的 YouTube/Bilibili 歌曲可自动回退到本地播放器。

Bot 的 `.env`：

```env
PLAYER_BACKEND=lavalink
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=
LAVALINK_SECURE=false
LAVALINK_NAME=main
```

生成一个唯一密码，在 Bot 和 Lavalink 私有环境文件中填写相同值。开发环境从项目根目录执行：

```bash
cd lavalink
cp lavalink.env.example lavalink.env
# 编辑 lavalink.env，填写密码和所需的 OAuth 配置。
chmod 600 lavalink.env
set -a
. ./lavalink.env
set +a
java -jar Lavalink.jar
```

配置参考：

- [Lavalink YAML](../lavalink/application.yml) 关闭内置 YouTube source，固定使用含 TV 客户端修复的插件快照。
- `MUSIC` 用于元数据/搜索；`TV` 是播放链中优先使用、支持 OAuth 的客户端。
- `YOUTUBE_OAUTH_REFRESH_TOKEN` 只放在私有环境文件，YAML 通过环境变量引用。空值时按插件日志中的设备码完成授权。
- 参考配置使用本机 `yt-cipher`（`127.0.0.1:8001`）和 poToken provider（`127.0.0.1:4416`），配套 bgutil Python 插件需与容器版本匹配。
- `lavalink-pot-refresh.timer` 每四小时刷新 Token，Lavalink 启动后也执行一次尽力刷新。
- Bilibili 先由 yt-dlp 解析临时音频直链，再通过 Lavalink HTTP source 播放；过期直链会重新解析。

生产部署、服务账号和辅助服务说明见 [systemd 部署指南](../systemd/README.md)，Lavalink 私有环境模板见 [`lavalink.env.example`](../lavalink/lavalink.env.example)。

| 变量 | 说明 |
|------|------|
| `LAVALINK_HOST`、`LAVALINK_PORT` | 节点地址，默认 `127.0.0.1:2333` |
| `LAVALINK_PASSWORD` | 必填，必须与 Lavalink 相同 |
| `LAVALINK_SECURE` | 是否使用 HTTPS/WSS |
| `LAVALINK_NAME` | 节点名称，默认 `main` |
| `LAVALINK_RETRY_AMOUNT` | WebSocket 连续重连次数，默认 `12` |
| `LAVALINK_RETRY_DELAY_MS` | 重连间隔，默认 `10000` 毫秒，耗尽后仍会尝试重建节点 |

## 播放与恢复参数

通常保留默认值即可。恢复机制的具体行为见 [故障排查](troubleshooting.md#播放失败与恢复策略)。

| 变量 | 默认值 / 说明 |
|------|------|
| `FFMPEG_BIN` | 可显式指定 ffmpeg；默认优先系统版本，最后回退到 bundled ffmpeg-static |
| `YTDLP_MAX_CONCURRENT` | 元数据/搜索并发进程上限，`6` |
| `MAX_QUEUE_SIZE` | 手动及 Radio 队列长度上限，`100` |
| `AUDIO_BUFFER_MB` | 本地音频缓冲，`8` MB |
| `AUDIO_PREBUFFER_MS` | 本地预缓冲最多等待 `1500` 毫秒 |
| `AUDIO_NORMALIZATION` | 本地 ffmpeg 是否启用音频标准化 |
| `LOCAL_STREAM_STALL_MS` | 源未正常结束、缓冲耗尽且持续无新数据的判定时间，`20000` 毫秒 |
| `PLAYBACK_RECOVERY_TIMEOUT_MS` | 一轮起播/恢复共享预算，`45000` 毫秒 |
| `LAVALINK_TRACK_RETRY_DELAY_MS` | 临时失败同后端重试前等待，`1000` 毫秒，另加不足 200ms 的随机延迟 |
| `LAVALINK_TRACK_RETRY_TIMEOUT_MS` | 一次 Lavalink 重试确认输出的最长时间，`8000` 毫秒 |
| `LOCAL_FALLBACK_RESERVE_MS` | 共享预算中为本地连接/解析/起播保留的时间，`15000` 毫秒 |
| `PLAYER_DEBUG`、`RADIO_DEBUG`、`PLAY_TIMING`、`VOICE_DEBUG` | 设置为 `1` 开启相应调试日志 |
| `MUSICBOT_DATA_PATH` | 可覆盖数据文件路径，默认 `data/musicbot.json` |

ffmpeg 路径顺序：`FFMPEG_BIN` → `/usr/bin/ffmpeg` → `/usr/local/bin/ffmpeg` → PATH → bundled ffmpeg-static。选中的程序必须支持 libopus；推荐使用系统 ffmpeg。

语音监听和 STT 变量见 [语音控制指南](voice-control.md)。完整模板见 [`.env.example`](../.env.example)。

## 数据与隐私

- `data/musicbot.json` 保存歌单、服务器设置及部分播放恢复状态。
- 当前进度、Radio、24/7 等必要状态用于恢复，运行时队列不保证完整恢复。
- 临时音频 URL、播放 ID 和后端切换状态不持久化。
- 实际环境文件、Cookie、运行数据及备份、日志和录音只留在部署环境，不加入 Git。
- 日志可能包含语音 Token、签名媒体 URL 和用户标识，分享前需脱敏。
