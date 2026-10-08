# 🎵 Discord Music Bot

支持 YouTube、Bilibili 和 Spotify 歌曲解析的 Discord 音乐机器人，提供自动续播、AI 点歌和可选语音控制。

当前版本 **2.0.0** · [更新记录](CHANGELOG.md)

## 功能

- 🎶 链接播放、关键词搜索和播放列表
- ⏯️ 暂停、跳歌、音量、循环和播放面板
- 📻 Radio 自动推荐与续播
- 🤖 AI 自然语言点歌
- 🎙️ 普通话、粤语语音控制
- 🔄 播放失败自动重试与备用播放
- 🕒 24/7 语音频道保持

Spotify 内容会转换为 YouTube 搜索结果播放。

## 快速开始

需要 **Node.js 22.12+、yt-dlp 和支持 libopus 的 ffmpeg**，安装方法见 [运行要求](docs/configuration.md#运行要求)。

先在 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Bot，用 `bot`、`applications.commands` scope 邀请到服务器，授予查看、连接、说话、发送消息及嵌入链接权限。

```bash
git clone https://github.com/gan12138/discord-music-bot.git
cd discord-music-bot
npm ci
cp .env.example .env
```

编辑 `.env`，替换以下占位值：

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_test_guild_id_here

# 快速开始使用本地播放器，无需启动 Lavalink
PLAYER_BACKEND=local
```

部署服务器命令并启动：

```bash
npm run deploy
npm start
```

加入语音频道，用 `/play` 点歌。全局命令部署需显式设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true`。

## 常用命令

| 命令 | 功能 |
|---|---|
| `/play` | 播放链接或搜索歌曲 |
| `/pause`、`/resume` | 暂停、继续 |
| `/skip`、`/stop` | 跳歌、停止 |
| `/volume`、`/loop` | 音量、循环 |
| `/queue`、`/panel` | 查看队列、播放面板 |
| `/playlist` | 管理歌单 |
| `/radio` | 自动续播 |
| `/ai-music` | AI 点歌 |
| `/help` | 查看更多命令 |

## 可选配置

- **Lavalink**：独立播放后端，见 [配置指南](docs/configuration.md#lavalink-后端) 和 [服务器部署](systemd/README.md)。
- **AI 点歌**：配置自己的 API 地址、Key 和模型，见 [AI 配置](docs/configuration.md#ai-点歌与-radio)。
- **语音控制**：需要第二个 Bot 和语音识别服务，见 [开启步骤](docs/voice-control.md#开启步骤)。

## 更多文档

- [使用指南](docs/usage.md)：完整命令、权限、Radio、24/7 和歌单
- [配置指南](docs/configuration.md)：依赖、AI、Cookie、Lavalink 和环境变量
- [语音控制](docs/voice-control.md)：普通话/粤语、唤醒词和 STT
- [故障排查](docs/troubleshooting.md)：登录、播放、断线和语音问题
- [开发与验证](docs/development.md)：项目结构、脚本和测试
- [环境模板](.env.example) · [从旧版升级](CHANGELOG.md#从-100-升级)

> 请勿上传真实 Token、API Key、Cookie 或用户数据。启用语音监听后，讲话片段会在确认唤醒词前发送到配置的 STT 服务；成员可退出。

仅供学习和个人使用，请遵守相关平台条款及当地法律。
