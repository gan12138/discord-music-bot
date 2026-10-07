# 更新记录

## 2.0.0 — 2026-10-07

### 新增

- 可选的独立语音监听 Bot，支持普通话、粤语、唤醒词及严格/AI 平衡理解。
- 语音点歌、暂停、继续、上一首、下一首；管理员配置和成员 STT 退出入口。
- `/settings dj-role`，统一的 DJ/管理服务器权限与同语音频道检查。
- 播放面板中的监听 Bot 加入/离开按钮，以及语音配置状态。
- 隔离运行的 Node 测试套件，覆盖播放恢复、数据、权限、面板及语音处理。

### 播放与数据改进

- YouTube/Bilibili 的 Lavalink 载入和播放中错误可回退到本地 `yt-dlp + ffmpeg`。
- 临时网络错误先在 Lavalink 重试一次；起播/恢复默认共享 45 秒预算，并可被停止、跳过和替换取消。
- 播放事件按 ID 去重，旧结束事件无法重复推进队列；断线恢复保留进度与待播队列。
- 本地断流检测结合源进程结束状态和下游缓冲，清理子进程支持超时强制终止。
- Radio 任务失效、失败视频冷却、更严格筛选，以及最多两个保守匹配的同曲替代。
- 24/7 无人频道保留后续队列、停止生成推荐并抑制故障通知，有人返回后继续。
- 数据写入失败重试与结构修复，AI 歌单预览按修订号、用户和服务器校验。
- 固定包含 TV 客户端修复的 YouTube 插件快照，支持私有 OAuth、远程解密和 poToken 刷新。

### 配置与发布

- Node.js 最低要求提升到 `22.12.0`，依赖由 `npm ci` 安装。
- 更新锁文件中的 `undici` 安全补丁，依赖审计通过。
- AI 服务必须显式配置公共 HTTPS `AI_BASE_URL`，源码不再包含个人中转地址。
- YouTube/Bilibili 使用各自的 Cookie 配置；旧 `YTDLP_COOKIE_FILES` 仅兼容 Bilibili。
- 配置模板不包含实际凭据；环境文件、Cookie、运行数据及备份、日志、录音不进入发布版本。
- systemd 模板使用独立服务账号和受保护的环境文件；新增 Lavalink 环境模板。
- 命令部署拒绝无效服务器 ID，避免校验失败后继续发送部署请求。

### 从 1.0.0 升级

1. 在部署环境私下备份配置和 `data/musicbot.json`，不要把备份加入 Git。
2. 升级到 Node.js 22.12+，更新代码后运行 `npm ci`。
3. 参考 `.env.example` 补齐变量。AI 用户需设置 `AI_BASE_URL`；原先用于 YouTube 的通用 Cookie 路径需移到 `YTDLP_YOUTUBE_COOKIE_FILES`。
4. 为 Bot 和 Lavalink 配置相同的唯一 `LAVALINK_PASSWORD`，OAuth Token 只放在私有 Lavalink 环境文件。
5. systemd 安装参照 `systemd/README.md`，核对安装目录、服务账号、Node 路径和本机辅助服务。
6. 新增三个命令需要重新部署。优先设置 `DISCORD_GUILD_ID`；全局部署需显式设置 `ALLOW_GLOBAL_COMMAND_DEPLOY=true`。
7. `/247` 开关、`/notify`、`/version` 等设置操作要求管理服务器权限。旧播放面板失效时使用 `/panel` 获取新面板。
8. 语音监听默认不登录；配置第二 Bot/STT 并显式开启后，同频道真人默认可使用，成员可用 `/voice-consent revoke` 退出。讲话片段会在确认唤醒词前送到 STT 服务。
9. 运行 `npm run check` 和 `npm test`，在安排好的部署窗口重启服务并验收 YouTube/Bilibili 控制、双向切歌和回退期间的停止/跳过。

运行状态仍使用原有 JSON 数据文件，新版会补齐缺少的设置字段。回滚应用版本前应保留升级前的私有数据备份。
