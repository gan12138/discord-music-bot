# 🎵 Discord 音乐机器人

[English](README.md) · **中文**

支持 YouTube、Bilibili 链接与 Spotify 转换播放的 Discord 音乐机器人，提供队列管理、Radio 自动续播、AI 点歌、24/7 语音频道保持和可选的语音控制。

当前版本 **2.0.0** · [更新记录](CHANGELOG.md)

> Bot 的 Discord 命令描述与回复目前是中文。本仓库同时提供[英文说明](README.md)与本中文说明；文档语言不影响 Bot 内界面。

## 功能

- 🎶 YouTube、Bilibili 链接播放，关键词搜索和播放列表
- ⏯️ 暂停、继续、跳过、停止、音量、seek、循环、随机、移除队列歌曲
- 📻 Radio 自动续播，可按风格、年代、语言和心情推荐
- 🤖 AI 自然语言点歌（`/ai-music`）与 AI 歌单编辑
- 🎙️ 可选的语音控制（普通话 / 粤语），需要独立的监听 Bot
- 🔄 播放失败自动重试、Lavalink → 本地回退、断流检测与恢复
- 🕒 24/7 语音频道保持，不抢占手动点歌
- 💾 每服务器持久化歌单与设置

Spotify 的歌曲、专辑和歌单会解析后转换为 YouTube 搜索结果播放，并非直接播放 Spotify 音频。

## 一键部署（含 Lavalink）

支持 **Ubuntu 22.04/24.04、Debian 12/13，amd64/arm64**，需要有 sudo/root 权限、systemd 和交互式终端。

先在 Discord Developer Portal 创建并邀请音乐 Bot。**当前仓库需 GitHub 访问授权**，请在已配置有权限 SSH key 的服务器执行：

```bash
work=$(mktemp -d) && git clone --depth=1 git@github.com:gan12138/discord-music-bot.git "$work/source" && sudo bash "$work/source/scripts/install.sh" --source "$work/source"
```

若仓库开放公开访问，也可使用[安装指南](docs/zh-CN/installation.md)中的匿名 `curl` 入口。

向导会隐藏输入所有密钥，询问应用 ID、服务器 ID、可选 Cookie 路径和 AI 配置，然后安装 **Node、Java、Lavalink、ffmpeg、yt-dlp/EJS 和本机 YouTube 辅助服务**，部署命令并设置开机启动。重复执行同一命令可更新，留空沿用现有配置并保留歌单。

- [一键安装](docs/zh-CN/installation.md)
- [配置指南](docs/zh-CN/configuration.md)
- [systemd 部署](systemd/README.md)

## Cookie（可选）

登录对应平台，导出 **Netscape `cookies.txt`** 文件并上传服务器，在向导填写路径；留空可跳过。安装器会按平台过滤条目，并复制到仓库之外。

配置文件为 `/etc/discord-music-bot/bot.env`：

```env
YTDLP_BILIBILI_COOKIE_FILES=/var/lib/discord-music-bot/cookies/bilibili.txt
YTDLP_YOUTUBE_COOKIE_FILES=/var/lib/discord-music-bot/cookies/youtube.txt
```

Bilibili Cookie 通常包含 `SESSDATA`、`DedeUserID`、`bili_jct`。两个平台使用独立文件且互不回退，B 站登录 Cookie 不会被发送到 Google。**不要提交真实 Cookie、Token 或 API Key。** 详见 [Cookie 配置](docs/zh-CN/installation.md#cookie-导出与更新)。

Lavalink 播放 YouTube 还需要 OAuth；本地 yt-dlp Cookie 不能替代它。

## 手动启动（本地后端）

需要 **Node.js 22.12+、yt-dlp 和支持 libopus 的 ffmpeg**，详见[运行要求](docs/zh-CN/configuration.md#运行要求)。

先在 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Bot，用 `bot`、`applications.commands` scope 邀请到服务器，授予查看频道、连接、说话、发送消息及嵌入链接权限。

```bash
git clone https://github.com/gan12138/discord-music-bot.git
cd discord-music-bot
npm ci
cp .env.example .env
```

编辑 `.env` 替换占位值：

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_test_guild_id_here

# 仅使用本地播放器，无需启动 Lavalink
PLAYER_BACKEND=local
```

部署命令并启动：

```bash
npm run deploy
npm start
```

加入语音频道后用 `/play` 点歌。全局命令部署需显式设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true`。

## 命令列表

| 命令 | 用途 |
|---|---|
| `/play <链接/关键词>` | 播放链接或搜索歌曲 |
| `/search <关键词>` | 搜索 YouTube 视频 |
| `/queue [页码]` | 查看播放队列 |
| `/nowplaying` | 查看当前播放 |
| `/skip`、`/pause`、`/resume`、`/stop` | 播放控制 |
| `/volume <0-100>`、`/seek <时间>` | 音量与进度 |
| `/filter`、`/loop`、`/shuffle`、`/remove` | 播放设置 |
| `/playlist` | 持久化歌单管理 |
| `/radio`、`/audio` | Radio 自动续播（`/audio` 是别名） |
| `/ai-music <需求>` | 用自然语言让 AI 点歌 |
| `/247` | 24/7 语音频道保持 |
| `/panel`、`/notify` | 播放面板与通知方式 |
| `/settings dj-role` | 设置或清除 DJ 角色 |
| `/voice-control`、`/voice-consent` | 语音控制与 STT 退出 |
| `/version`、`/help` | 版本偏好与帮助 |

未设置 DJ 角色时，成员都可使用音乐控制；设置后需 DJ 角色或管理服务器权限。服务器级设置需管理服务器权限。

### YouTube 链接形式

普通视频链接（`youtube.com/watch?v=…`、`youtu.be/…`）以及带 Mix/电台参数的同一链接（`&list=…&start_radio=1`）都按**单个视频**播放，歌单与电台参数会被丢弃。明确的歌单链接（`/playlist?list=…`）会加载歌单，数量受配置上限约束。Shorts 与 live 链接不属于受支持的链接形式，不保证可播放；被拒绝时请改用标题搜索。

## 可选配置

- **Lavalink**：独立播放后端，见 [Lavalink 配置](docs/zh-CN/configuration.md#lavalink-后端) 与 [systemd 部署](systemd/README.md)。
- **AI**：填写自己的公网 HTTPS 地址、Key 和模型，见 [AI 配置](docs/zh-CN/configuration.md#ai-点歌与-radio)。
- **语音控制**：需要第二个 Bot 和语音识别服务，见 [语音控制](docs/zh-CN/voice-control.md)。

语音控制默认按退出制：`everyone` 模式下，音乐 Bot 所在语音频道的每位真人成员都可使用语音命令，成员可用 `/voice-consent` 退出。语音片段会在确认唤醒词之前发送到配置的 STT 服务。可用 `/voice-control stt-policy off` 关闭该服务器的 STT。细节与隐私说明见 [语音控制](docs/zh-CN/voice-control.md)。

## 文档

- [一键安装](docs/zh-CN/installation.md)：向导、Cookie、OAuth、升级与服务管理
- [使用指南](docs/zh-CN/usage.md)：完整命令、权限、Radio、24/7 和歌单
- [配置指南](docs/zh-CN/configuration.md)：依赖、AI、Cookie、Lavalink 和环境变量
- [语音控制](docs/zh-CN/voice-control.md)：普通话/粤语、唤醒词和 STT
- [故障排查](docs/zh-CN/troubleshooting.md)：登录、播放、断线和语音问题
- [开发与验证](docs/zh-CN/development.md)：项目结构、脚本和测试
- [更新记录](CHANGELOG.md) · [环境模板](.env.example)

English documentation: [README.md](README.md) and [docs/](docs/).

## 项目结构

```text
src/index.js                  Bot 运行入口
src/deploy-commands.js        Slash 命令部署入口
src/commands/*.js             命令，自动加载
src/events/*.js               事件，自动加载
src/utils/player.js           队列、后端切换和播放恢复
src/utils/playback.js         共用入队逻辑
src/utils/playbackState.js    播放状态持久化
src/utils/lavalink.js         Lavalink 管理、就绪与音轨事件
src/utils/voiceListenerManager.js  可选语音监听与 STT 流程
test/                         隔离的 Node 测试
docs/                         使用、配置和排查文档
docs/zh-CN/                   中文文档
scripts/install.sh            交互式安装入口
scripts/install.py            安装、私有配置与失败恢复
lavalink/application.yml      Lavalink 配置
systemd/                      服务模板与部署说明
data/                         运行数据目录（已 gitignore）
```

内存中的播放队列按服务器保存，重启后丢失；歌单、服务器设置和部分播放状态持久化在 `data/musicbot.json`，该文件被 gitignore 且运行时才创建。仓库**不包含**任何真实服务器数据、歌单、Cookie、Token 或日志；新克隆的数据目录为空，首次运行后才会生成。

## 运行要求

- Node.js `>=22.12.0`
- Discord Bot Token 和 Application ID
- `yt-dlp`：元数据、搜索、Bilibili 解析和本地回退
- `ffmpeg`（需 `--enable-libopus`）：本地后端与回退；支持 `FFMPEG_BIN`，打包的 `ffmpeg-static` 仅作最后回退
- Lavalink：Java 17+、Lavalink v4 和 YouTube source plugin
- 可选：第二个 Bot Token 和 STT 服务用于语音控制

## 安全

- 不要提交 `.env`、Cookie 文件、API Key 或真实歌单数据；`.gitignore` 已排除这些内容。
- 使用非 root 服务账号运行 Bot 与 Lavalink，并保护其环境文件权限。
- YouTube 辅助服务端口（`4416`、`8001`）只绑定本机。
- 发布前检查 `git status`，只提交源码、文档和测试。

## 许可

本项目使用 [MIT License](LICENSE)。

仅供学习和个人使用。请遵守 Discord、YouTube、Bilibili 与 Spotify 的服务条款及当地法律。
