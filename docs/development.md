# 开发与验证

[返回首页](../README.md) · [配置指南](configuration.md) · [故障排查](troubleshooting.md)

## 项目结构

```text
src/index.js               运行入口
src/deploy-commands.js     Slash 命令部署入口
src/commands/*.js          命令，自动加载
src/events/*.js            事件，自动加载
src/utils/player.js        队列、后端切换和播放恢复
src/utils/playback.js      共用入队逻辑
src/utils/playbackState.js 播放状态持久化
test/                     隔离的 Node 测试
docs/                     使用、配置和排查文档
scripts/install.sh        交互式安装入口
scripts/install.py        安装、私有配置与失败恢复
lavalink/application.yml   Lavalink 配置
```

项目为 Node.js ESM。命令导出 `data`、`execute`，事件导出 `name`、`once`、`execute`。

## npm 脚本

| 命令 | 用途 |
|------|------|
| `npm ci` | 按锁文件安装依赖 |
| `npm start` | 登录并启动 Bot |
| `npm run dev` | Node watch 开发模式 |
| `npm run deploy` | 更新真实 Discord 命令 |
| `npm run check` | 项目 JavaScript 语法检查 |
| `npm test` | 隔离的播放、数据、权限和语音测试 |
| `npm run check:voice-stt` | 调用已配置的服务探测短期 STT Token |

语法和单元测试不需要登录 Discord：

```bash
npm run check
npm test
python3 -B -m unittest discover -s test -p 'installer_test.py' -v
```

没有项目定义的 lint、format 或 typecheck 脚本。`npm start`、命令部署、STT 探测涉及真实服务，不能当作纯离线验证。

## 播放改动验收

- YouTube、Bilibili 各自的暂停、继续、跳过。
- YouTube → Bilibili、Bilibili → YouTube 双向切歌。
- Lavalink 回退本地期间的停止/跳过，以及下一首重新使用 Lavalink。
- `trackError → trackEnd/queueEnd`、`trackStuck → queueEnd` 和旧本地 `Idle` 只推进一次。
- 后端切换期间不重复恢复，正常回退最多一次离开/重新加入。

控制按实际 `activeBackend` 路由，本地回退必须使用真实 Discord VoiceConnection。保留 `.env` 加载先于 ffmpeg 解析的顺序，以及入口的 `File` 兼容 shim。

维护完整架构说明见 [AGENTS.md](../AGENTS.md)，服务部署见 [systemd 指南](../systemd/README.md)。
