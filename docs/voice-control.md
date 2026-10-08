# 语音控制

[返回首页](../README.md) · [配置指南](configuration.md) · [故障排查](troubleshooting.md)

语音控制使用第二个 Discord Bot 接收音频，主音乐 Bot 继续负责播放。支持普通话、粤语、唤醒词和可选 AI 理解。

## 开启步骤

1. 创建第二个 Bot，加入与音乐 Bot 相同的服务器。
2. 给它目标语音频道的查看和连接权限。
3. 配置监听 Token 和 STT（语音转写）服务。
4. 显式设置 `VOICE_LISTENER_ENABLED=true`，在部署窗口重启音乐 Bot。
5. 音乐 Bot 加入语音频道后，监听 Bot 会自动跟随，以自我静音、非自我耳聋方式接收音频。

### Vercel AI Gateway

`xai/grok-stt` 使用短期 Token 和 WebSocket 流式转写，输入为 `24 kHz / PCM16 / mono`：

```env
VOICE_LISTENER_ENABLED=true
VOICE_LISTENER_TOKEN=
VOICE_STT_PROVIDER=vercel-ai-gateway
VOICE_STT_GATEWAY_API_KEY=
VOICE_STT_MODEL=xai/grok-stt
VOICE_STT_SAMPLE_RATE=24000
VOICE_STT_TIMEOUT_MS=15000
```

填入真实 Token 和 Gateway Key 后，可单独探测 STT Token，不登录监听 Bot、不上传成员语音：

```bash
npm run check:voice-stt
```

如使用自己配置的兼容 Gateway，可设置 `VOICE_STT_GATEWAY_BASE_URL`（公共 HTTPS 地址）。只有显式设置此地址时，Gateway 才可回退使用 `VOICE_STT_API_KEY`，避免把兼容服务 Key 发给默认服务。转写 WebSocket 地址按 Token 响应和代码 allowlist 校验。

### OpenAI-compatible STT

也支持 `/audio/transcriptions` 兼容服务：

```env
VOICE_LISTENER_ENABLED=true
VOICE_LISTENER_TOKEN=
VOICE_STT_PROVIDER=openai-compatible
VOICE_STT_BASE_URL=https://api.openai.com/v1
VOICE_STT_API_KEY=
VOICE_STT_MODEL=whisper-1
VOICE_STT_SAMPLE_RATE=48000
```

## 说出命令

默认唤醒词为“音乐助手”和“语音助手”，要求位于句首附近。可直接说出完整指令，也可先唤醒，再在短窗口内说指令。

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

管理员可选择：

- **严格模式**（默认）：精确唤醒词和固定命令，不调用 AI。
- **AI 平衡模式**：精确标准命令直接匹配，长唤醒词的少量转写误差和未理解指令交给 AI 确认。需要配置 [AI 服务](configuration.md#ai-点歌与-radio)。

AI 只有在置信度达到阈值、证据能在原话中验证且命令仍有效时才执行。普通句子中间出现唤醒词、歌词、过短唤醒或不确定结果不会直接触发。

## 管理与成员命令

`/voice-control` 和播放面板的监听 Bot 加入/离开按钮需要管理服务器权限。

| 命令 | 用途 |
|------|------|
| `/voice-control enable`、`disable` | 开启或关闭语音控制 |
| `/voice-control status` | 查看配置及监听连接 |
| `/voice-control stt-policy` | 选择全员允许或完全关闭 |
| `/voice-control cloud-stt` | 开启全员 STT 或关闭 STT |
| `/voice-control language` | 普通话、粤语或混合模式 |
| `/voice-control understanding` | 严格或 AI 平衡理解 |
| `/voice-control wakeword` | 添加、移除、替换、列出、重置唤醒词，最多 10 个 |
| `/voice-control audit-channel` | 设置或清除命令结果频道 |
| `/voice-control test` | 用文本测试解析结果 |
| `/voice-control diagnostics` | 查看录音、解码、STT、焦点和错误诊断 |
| `/voice-consent revoke` | 成员退出 STT 并停止进行中的处理 |
| `/voice-consent grant` | 成员重新加入 |
| `/voice-consent status` | 查看自己的有效状态 |

播放面板显示 STT 策略、语言、理解模式和唤醒词。加入/离开按钮仅切换监听 Bot 的自动跟随，不改变 STT 策略或成员的退出记录。

## 访问策略与音频处理

- 监听 Bot 默认不登录，只有显式开启且配置完成后才工作。
- 服务器默认允许同频道真人使用全部语音命令，不需要角色或点播者身份；成员可以主动退出，管理员可以完全关闭。
- **唤醒词由云 STT 识别，因此讲话片段会在确认唤醒词之前发送给配置的 STT 服务。**
- 主音乐 Bot、监听 Bot 及其他 Bot 的独立音轨不会送入 STT。音箱声音若被成员麦克风回录，则混入该成员音轨，建议开启回声消除或使用耳机。
- 普通聊天转写不写入审计频道；命令反馈不显示原始转写，并禁用 mention 解析。
- 成员退出、关闭策略或使配置失效时，进行中的语音工作会被取消，迟到结果不会执行。

最终转写确认唤醒词后，监听器锁定说话者、终止其他候选用户的录音/转写并临时降低音乐音量。命令完成或 8 秒无后续指令时恢复监听和原音量。

每服务器和全局默认最多同时处理 4 个候选用户。超额说话者被忽略；成功唤醒者独占短窗口。只有至少 4 个字的唤醒词用于 STT 提示，partial transcript 不执行命令，避免噪声误触发。损坏的单个 Opus 包可丢弃，连续错误过多时终止该语音段。

## 参数参考

| 变量 | 默认值 / 说明 |
|------|------|
| `VOICE_LISTENER_ENABLED` | 只有 `true` 开启登录，模板默认 `false` |
| `VOICE_LISTENER_TOKEN` | 第二个 Bot 的 Token，不可与主 Bot 相同 |
| `VOICE_STT_PROVIDER` | `vercel-ai-gateway` 或 `openai-compatible` |
| `VOICE_STT_GATEWAY_API_KEY` | Gateway Key |
| `VOICE_STT_GATEWAY_BASE_URL` | 自定义公共 HTTPS Gateway；空值使用默认服务 |
| `VOICE_STT_BASE_URL`、`VOICE_STT_API_KEY` | OpenAI-compatible 服务地址及 Key |
| `VOICE_STT_MODEL` | Gateway 推荐 `xai/grok-stt`，兼容服务可用 `whisper-1` |
| `VOICE_STT_SAMPLE_RATE` | Gateway `24000`，兼容服务配置示例为 `48000` |
| `VOICE_STT_TIMEOUT_MS` | 单次转写超时，`15000` 毫秒 |
| `VOICE_CONTROL_MAX_GUILD_JOBS`、`VOICE_CONTROL_MAX_GLOBAL_JOBS` | 各为 `4` |
| `VOICE_CONTROL_DUCK_VOLUME` | 唤醒后临时音量，`15`，不覆盖保存音量 |
| `VOICE_CONTROL_AI_CONFIDENCE` | AI 执行阈值，`0.88` |
| `VOICE_CONTROL_AI_TIMEOUT_MS` | AI 分类超时，`8000` 毫秒 |
| `VOICE_CONTROL_MAX_AI_JOBS` | AI 分类并发上限，`2` |
| `VOICE_CONTROL_MAX_AI_PER_USER_MINUTE`、`VOICE_CONTROL_MAX_AI_PER_GUILD_MINUTE` | AI 分类每分钟上限，分别 `4`、`12` |
| `VOICE_CONTROL_MAX_USER_SEGMENTS_PER_MINUTE`、`VOICE_CONTROL_MAX_GUILD_SEGMENTS_PER_MINUTE` | 上传语音段每分钟上限，分别 `12`、`60` |
| `VOICE_CONTROL_SEARCH_DEADLINE_MS` | 点歌搜索期限，`15000` 毫秒 |
| `VOICE_CONTROL_COMMAND_DEADLINE_MS` | 单条命令期限，`30000` 毫秒 |
| `VOICE_CONTROL_FOCUS_DEADLINE_MS` | 单次唤醒焦点最长期限，`45000` 毫秒 |
| `VOICE_CONTROL_DEBUG` | 设为 `1` 输出诊断，生产环境保持 `0` |

模板见 [`.env.example`](../.env.example)。解析器可安全单独验证：

```bash
node --test --import ./test/setup.js test/voiceCommandParser.test.js
```
