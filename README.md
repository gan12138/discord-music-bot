# Discord Music Bot

基于 `discord.js` v14 的 Discord 音乐机器人，支持 YouTube、Bilibili、Spotify 转 YouTube、关键词搜索、播放队列、播放面板、播放列表、Radio 自动续播、AI 点歌和 24/7 语音频道保持。

当前项目推荐使用 **Lavalink** 作为主要播放后端。Bot 仍保留本地 `yt-dlp + ffmpeg` 播放链路，用于 `local` 后端或 Lavalink 无法播放时的回落。

## 功能

- YouTube 单曲和播放列表播放。
- Bilibili 播放，支持 BV、AV 和 `b23.tv`；默认用 `yt-dlp` 解析音频直链，再交给 Lavalink HTTP 播放。
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

- Node.js `>=18.0.0`
- Discord Bot Token
- Discord Application ID，也就是 `CLIENT_ID`
- Lavalink 后端：Java 17+、Lavalink v4、Lavalink YouTube source plugin
- 元数据解析、搜索、Spotify 转 YouTube、Bilibili 解析和本地回落：系统可用的 `yt-dlp`
- 本地后端或播放回落：系统可用的 `ffmpeg`，或 npm 包 `ffmpeg-static` 支持的平台

## 快速开始

安装依赖：

```bash
npm install
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

推荐使用 Lavalink：

```env
PLAYER_BACKEND=lavalink
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false
LAVALINK_NAME=main
```

启动 Lavalink：

```bash
cd lavalink
java -jar Lavalink.jar
```

后台启动 Lavalink：

```bash
cd lavalink
setsid java -jar Lavalink.jar > lavalink.log 2>&1 < /dev/null &
```

部署 Slash Commands：

```bash
npm run deploy
```

`npm run deploy` 会更新全局应用命令，不是单个服务器的测试命令。全局命令同步可能需要一些时间。

启动 Bot：

```bash
npm start
```

后台启动 Bot：

```bash
setsid npm start > bot.log 2>&1 < /dev/null &
```

## npm 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 Bot |
| `npm run dev` | 使用 Node watch 模式启动 |
| `npm run deploy` | 部署全局 Slash Commands |
| `npm run check` | 对 `src/**/*.js` 和 `src/*.js` 做语法检查 |

## Lavalink

当前 `lavalink/application.yml` 使用 YouTube source plugin，并关闭 Lavalink 内置 YouTube source：

```yaml
lavalink:
  server:
    password: "youshallnotpass"
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
    clients:
      - MUSIC
      - ANDROID_VR
      - TVHTML5_SIMPLY
      - WEB
      - MWEB
```

说明：

- `sources.youtube: false` 是为了避免使用 Lavalink v4 内置 YouTube source。
- YouTube 播放由 `lavalink/plugins/youtube-plugin-1.18.1.jar` 处理。
- `MUSIC` 在日志里可能显示为 `WEB_REMIX`，这是插件内部名称，不代表配置错误。
- `trackStuckThresholdMs: 30000` 用于减少 YouTube 取流慢时的误判 stuck。
- 不建议使用已知不稳定的 `ANDROID`、`IOS` client。
- Bilibili 不是由 Lavalink Bilibili source 直接解析。Bot 会先用 `yt-dlp --cookies ...` 解析出 `bilivideo.com` 音频直链，再使用 Lavalink 的 `http` source 播放。
- Bilibili 直链有过期时间；恢复旧队列或播放前会重新刷新直链。若 Lavalink HTTP 播放失败，Bot 会回退到本地 `yt-dlp + ffmpeg`。
- `src/utils/player.js` 使用 `activeBackend` 跟踪当前实际播放后端，暂停、继续、跳过等控制应按 `activeBackend` 路由，而不是只看 `PLAYER_BACKEND`。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DISCORD_TOKEN` | 是 | Discord Bot Token |
| `CLIENT_ID` | 是 | Discord Application ID |
| `PLAYER_BACKEND` | 否 | `lavalink` 或 `local`，默认示例推荐 `lavalink` |
| `LAVALINK_HOST` | Lavalink 时 | Lavalink 地址，通常 `127.0.0.1` |
| `LAVALINK_PORT` | Lavalink 时 | Lavalink 端口，默认 `2333` |
| `LAVALINK_PASSWORD` | Lavalink 时 | 必须和 `application.yml` 一致 |
| `LAVALINK_SECURE` | 否 | 是否使用 HTTPS/WSS |
| `LAVALINK_NAME` | 否 | Lavalink 节点名称 |
| `YOUTUBE_API_KEY` | 否 | 可选，用于改善部分搜索能力 |
| `SPOTIFY_CLIENT_ID` | 否 | Spotify 解析凭据 |
| `SPOTIFY_CLIENT_SECRET` | 否 | Spotify 解析凭据 |
| `AI_ENABLED` | 否 | 是否启用 `/ai-music` 和 AI 能力 |
| `AI_BASE_URL` | 否 | OpenAI-compatible API 地址 |
| `AI_API_KEY` | AI 时 | AI API key |
| `AI_MODEL` | 否 | AI 模型名 |
| `AI_TIMEOUT_MS` | 否 | AI 请求超时 |
| `RADIO_AI_ENABLED` | 否 | 是否让 Radio 使用 AI 生成推荐搜索词 |
| `YTDLP_COOKIE_FILES` | 否 | `yt-dlp --cookies` 文件路径；用于 Bilibili 解析、YouTube 元数据或本地回落。当前代码会使用逗号分隔列表中的第一个路径 |
| `PLAYER_DEBUG` | 否 | 播放调试日志 |
| `RADIO_DEBUG` | 否 | Radio 调试日志 |

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
| `/help` | 显示帮助信息 |

## Radio 行为

Radio 是自动续播系统。它可以保持开启，但不会抢手动点歌。

- 手动 `/play` 永远优先于 Radio。
- 如果 Radio 正在播放，用户 `/play` 会立即打断 Radio 并播放手动歌。
- Radio 开关不会因为手动点歌被关闭。
- 手动歌播放期间，Radio 不会插队。
- 手动队列播完后，如果 Radio 仍开启，它会继续自动续播。
- `/radio start`、`/radio reset` 和面板 Radio 按钮在手动歌播放中只会开启或刷新 Radio，不会立即抢播。

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

24/7 只负责保持连接，不应该抢占用户手动点歌。Bot 重启时会尝试恢复 24/7 语音频道状态；Lavalink 未 ready 时不会恢复播放，避免启动竞态。

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
- `data/musicbot.json` 可能包含真实 guild id、channel id、user id、播放列表和历史数据，不应公开提交。

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

重启示例：

```bash
kill <bot_pid> <lavalink_pid>
cd lavalink && setsid java -jar Lavalink.jar > lavalink.log 2>&1 < /dev/null &
cd .. && setsid npm start > bot.log 2>&1 < /dev/null &
```

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

确认 `.env` 和 `lavalink/application.yml` 中密码一致。

### 有声音但疯狂跳歌

这通常不是音频链路问题，而是队列推进或 Radio 状态抢占问题。当前代码已经做了以下保护：

- 手动点歌会打断 Radio。
- 手动队列没播完前 Radio 不接管。
- Lavalink 起播有 generation 防旧任务覆盖。
- `ensurePlaybackOutput()` 不会在起播中重复提交同一首歌。
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
advance ignored
got stuck
Attempt to execute executor
```

### YouTube lookup 或播放失败

常见原因是 YouTube client 失效、YouTube 风控、签名、poToken 或 OAuth 问题。

优先检查：

```bash
tail -n 200 lavalink/lavalink.log
```

如果仍失败，尝试更新 Lavalink YouTube source plugin，或给 youtube-source 配置 OAuth / poToken。

### Bilibili 或本地后端失败

Bilibili 的正常路径是：

1. Bot 用 `yt-dlp` 和 `YTDLP_COOKIE_FILES` 解析 Bilibili 视频信息和音频直链。
2. 如果 `PLAYER_BACKEND=lavalink` 且直链未过期，Bot 把 `bilivideo.com` 音频直链交给 Lavalink HTTP source 播放。
3. 如果 Lavalink 播放该直链失败，Bot 回退到本地 `yt-dlp + ffmpeg`。

确认系统命令可用：

```bash
yt-dlp --version
ffmpeg -version
```

如果遇到 403、412、年龄验证、登录验证或 bot 检测，可以配置：

```env
YTDLP_COOKIE_FILES=/path/to/cookies.txt
```

建议使用 Netscape `cookies.txt` 格式。有效的 Bilibili 登录 cookies 通常应包含 `SESSDATA`、`DedeUserID`、`bili_jct` 等字段。cookies 文件包含登录态，不要提交或分享。

验证 cookies 和 Bilibili 解析：

```bash
yt-dlp --cookies "/path/to/cookies.txt" --referer "https://www.bilibili.com" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" --dump-json --no-download "https://www.bilibili.com/video/BV1di421U7DV/"
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
- 没有 repo-defined lint、format 或 test 脚本；安全检查使用 `npm run check`。
- `npm run deploy` 会修改真实 Discord 应用的全局命令。
- `.env`、日志和 `data/musicbot.json` 可能包含敏感信息，不应公开。
- 修改播放控制、Bilibili、Lavalink 或本地 fallback 时，需要同时测试 YouTube、Bilibili、YouTube -> Bilibili、Bilibili -> YouTube 的暂停、继续和跳过。

## 许可和使用

本项目仅供学习和个人使用。请遵守 YouTube、Bilibili、Spotify、Discord 和相关服务的条款，不要用于侵犯版权或违反当地法律的用途。
