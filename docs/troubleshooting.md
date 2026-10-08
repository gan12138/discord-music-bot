# 故障排查

[返回首页](../README.md) · [配置指南](configuration.md) · [语音控制](voice-control.md) · [systemd 部署](../systemd/README.md)

以下命令用于手动排查。原始日志可能包含 Token、Cookie、签名音频 URL 和用户标识，分享前需脱敏。

## 日志与进程

systemd 部署优先查看：

```bash
journalctl -u discord-music-bot -u lavalink --since '1 hour ago' --no-pager
```

如果开发环境将日志重定向到文件：

```bash
tail -n 100 bot.log
tail -n 100 lavalink/lavalink.log
ps -eo pid,cmd | rg 'Lavalink.jar|node src/index.js'
```

重启前核对工作目录，避免终止其他安装的 Bot。Bot 使用 `data/bot.pid` 防止重复启动；只有确认 PID 已不存在时才处理过期锁。代码变更需重启 Bot，YAML 变更需重启 Lavalink，安排播放中断窗口后操作。

## Bot 没上线

- 检查 `.env` 或 systemd 环境文件中的 `DISCORD_TOKEN`、`CLIENT_ID`。
- 检查 Node.js 是否为 22.12+，Bot 实际 PATH 中是否可运行 `yt-dlp` 和 ffmpeg。
- 检查日志中是否有重复实例锁、登录失败或依赖缺失。

```bash
node --version
yt-dlp --version
ffmpeg -version
```

本地播放器要求 ffmpeg 支持 `--enable-libopus`。可通过 `FFMPEG_BIN` 指定系统程序。

## Slash 命令没更新

先在 `.env` 设置正确的 `DISCORD_GUILD_ID`，再执行：

```bash
npm run deploy
```

指定服务器命令立即更新。全局部署需显式设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true`，且同步可能需要时间。也要确认 Bot 的邀请包含 `applications.commands` scope。

## Lavalink 连接失败

- 确认 Java 进程已启动，日志出现 `Lavalink is ready to accept connections.`。
- Bot 与 Lavalink 私有环境文件中的 `LAVALINK_PASSWORD` 必须一致。
- 检查 `LAVALINK_HOST`、端口、HTTPS/WSS 设置及 YAML 配置。
- 节点连接、`/v4/info` 与 session ID 全部有效后才允许播放，暂不可用时 Bot 保留恢复任务。

```bash
ps -eo pid,cmd | rg Lavalink.jar
```

配置和 OAuth/辅助服务步骤见 [Lavalink 配置](configuration.md#lavalink-后端)。内存紧张的部署可为 JVM 配置合适的堆上限，避免交换压力造成 websocket ping 超时。

## 没声音

1. 确认成员与 Bot 在正确的语音频道。
2. 检查 Bot 的查看、连接、说话权限，以及 Discord 客户端静音/音量。
3. 使用 Lavalink 时检查节点是否就绪、是否已连接语音。
4. 查看日志中的 `track start`、`PlaybackRecovery`、`start timeout` 和回退信息。
5. Bilibili 应有直链播放或本地回退日志；本地播放应能找到可用 ffmpeg。

`player.play()` 或 `trackStart` 成功不代表音频已输出，Lavalink 需要实际服务端进度确认。

## 乱跳歌或面板无效

正常行为是手动歌曲优先排队、当前 Radio 歌曲结束后播放。旧播放面板失效时用 `/panel` 获取最新面板。

新版通过播放 ID 和结束事件去重，避免多个错误/结束事件跳过下一首。排查日志可搜索：

```text
PlaybackError
PlaybackRecovery
PlaybackRetry
PlaybackSkipAfterError
track start
track error
track stuck
queue end observed
advance ignored
start timeout
```

暂停、继续、跳过等控制按实际后端路由。Lavalink 回退本地可能正常离开/加入一次；若连续反复切换，应检查 `startingBackend`、`backendTransitioning` 期间是否重复恢复旧后端。

## 播放失败与恢复策略

错误区分网络超时、不可达、403、登录验证、明确内容限制及环境问题。`This video is not available` 只表示当前路径拿不到音频，不一定意味着视频已删除。

- 聚合异常优先识别 OAuth TV/TVHTML5 客户端，其网络错误不会被其他客户端的 403/验证错误掩盖。
- 临时网络故障先在 Lavalink 重试一次，再回退到本地 `yt-dlp + ffmpeg`。
- 本地网络超时/断流最多重试两次；模糊不可用、403、无音频格式最多再确认一次；明确内容限制或环境问题不重复尝试。
- 一轮起播/恢复默认共享 45 秒预算。Lavalink 重试最多 8 秒，为本地连接/解析/起播保留 15 秒；预算不足时直接回退。
- 恢复尽量从失败进度前约 3 秒继续。确认输出后解除起播超时，持续推进约 30 秒后重置重试预算；暂停不算持续推进。
- 重试等待和换源搜索可以取消，停止/跳过/替换后旧任务不能复活。
- 本地断流只有在源未正常结束、下游缓冲耗尽且持续无新数据时判定；正常提前转码结束不算断流。
- 清理子进程先 SIGTERM，卡住两秒后 SIGKILL；无人频道抑制故障通知。

参数说明见 [播放与恢复参数](configuration.md#播放与恢复参数)。Lavalink YAML 的 HTTP 超时为连接 5 秒、连接池等待 3 秒、读取 8 秒，与 Bot 节点重连参数不同。

### Radio 冷却与换源

播放路径耗尽的视频默认冷却 10 分钟，反复失败延长至最多 1 小时；明确删除/私有/地区限制冷却 24 小时。缓存最多 1000 项，重启后清空。

Lavalink 单独失败但本地成功不会封锁整首歌；服务离线、环境和进程问题不计入视频冷却。用户主动点同一链接仍可重试。

只有 Radio 会尝试最多两个同曲上传版本，共享恢复预算。匹配歌名、可识别的歌手、时长及现场/普通版本，排除翻唱、伴奏、混音和已失败视频；信息不足则继续下一首。手动 URL 不会自动替换。

## YouTube 解析或中途 403

- 保持 `yt-dlp` 和配套 `yt-dlp-ejs` 更新，只有 Node 运行时仍不够。
- 检查 Lavalink OAuth、快照插件、`yt-cipher` 和 poToken provider 是否可用。
- 本地 yt-dlp 使用独立 `YTDLP_YOUTUBE_COOKIE_FILES`，不能复用 Bilibili Cookie 或 Lavalink OAuth。
- 元数据或 `-g` 能返回 URL 不等于音频可以完整下载。

```bash
python3 -m pip install -U 'yt-dlp[default]'
python3 -m pip show yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider
```

在已有临时目录中，用合适时长的公开视频验证完整下载：

```bash
yt-dlp --js-runtimes node --force-ipv4 --socket-timeout 20 \
  --retries 2 --fragment-retries 2 --no-playlist \
  -f 'bestaudio[ext=webm]/bestaudio' \
  -o '/tmp/%(id)s.%(ext)s' 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

也可通过 Lavalink `GET /youtube/stream/{videoId}` 验证整体可用性，不要带 `withClient=TV`，因为 TV 没有元数据能力。收到 200 或部分音频仍不足以确认完整播放；快照接口可能返回未知内容长度，使 Node fetch 在关闭时报 `terminated`，应结合音频帧时长或持续播放验证。

间歇性网络不可达时记录失败 CDN 的域名/IP、地址族及 DNS/路由状态。只有确认 IPv6 没有可用路由后，才考虑 IPv4-only 设置。

## Bilibili 失败

播放链路：yt-dlp 携带 Cookie 解析 → Lavalink HTTP 播放临时直链 → 失败时回退本地 yt-dlp/ffmpeg。回退使用原始页面 URL、Cookie、Referer 和 User-Agent，过期直链会刷新。

遇到 403、412 或登录验证时，配置自己的 Netscape Cookie：

```env
YTDLP_BILIBILI_COOKIE_FILES=/path/to/bilibili-cookies.txt
```

旧 `YTDLP_COOKIE_FILES` 仅作 Bilibili 兼容回退。验证解析时把 `<video-id>` 替换成实际 BV/AV：

```bash
yt-dlp --cookies '/path/to/bilibili-cookies.txt' \
  --referer 'https://www.bilibili.com' --dump-json --no-download \
  'https://www.bilibili.com/video/<video-id>/'
```

日志中的 `using direct audio URL via Lavalink` 表示直链播放；`falling back to local yt-dlp` 表示已切换本地。

## 语音控制不响应

- 确认第二 Bot 已加入服务器，Token 与主 Bot 不同，`VOICE_LISTENER_ENABLED=true`。
- 确认与音乐 Bot 同频道，监听 Bot 未自我耳聋且有查看/连接权限。
- 检查服务器 STT 是否关闭、成员是否主动退出。
- 用 `/voice-control test` 检查唤醒词和命令解析，用 `/voice-control diagnostics` 查看 STT、Opus 解码及并发限制。
- AI 平衡模式额外需要有效 AI 配置，严格模式不调用 AI。

完整步骤与访问策略见 [语音控制指南](voice-control.md)。
