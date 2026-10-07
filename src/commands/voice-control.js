import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { GuildSettings, VoiceControlDefaults } from '../models/database.js';
import {
  parseVoiceCommand,
  voiceLanguageLabel,
  voiceUnderstandingLabel,
} from '../utils/voiceCommandParser.js';
import { getVoiceControlManager } from '../utils/voiceControlRuntime.js';
import { musicQueue } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { parseAIVoiceIntent } from '../utils/voiceIntent.js';
import { hasManageGuild, requireGuild } from '../utils/commandSafety.js';
import { setCloudSttEnabled, setVoiceSttAccessMode } from '../utils/voiceConsent.js';
const LANGUAGE_CHOICES = [
  { name: '普通话 + 粤语', value: 'mixed' },
  { name: '普通话', value: 'mandarin' },
  { name: '粤语', value: 'cantonese' },
];
const UNDERSTANDING_CHOICES = [
  { name: 'AI 平衡模式', value: 'balanced' },
  { name: '严格模式', value: 'strict' },
];
const STT_POLICY_CHOICES = [
  { name: '完全关闭', value: 'off' },
  { name: '全员允许（成员可退出）', value: 'everyone' },
];

function sttPolicyLabel(mode) {
  if (mode === 'everyone') return '全员允许（成员可退出）';
  return '完全关闭';
}

export const data = new SlashCommandBuilder()
  .setName('voice-control')
  .setDescription('管理语音控制监听 Bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand => subcommand.setName('enable').setDescription('开启语音控制'))
  .addSubcommand(subcommand => subcommand.setName('disable').setDescription('关闭语音控制'))
  .addSubcommand(subcommand => subcommand.setName('status').setDescription('查看语音控制配置'))
  .addSubcommand(subcommand => subcommand
    .setName('language')
    .setDescription('设置普通话、粤语或混合语音命令')
    .addStringOption(option => option.setName('value').setDescription('语音命令语言').setRequired(true).addChoices(...LANGUAGE_CHOICES)))
  .addSubcommand(subcommand => subcommand
    .setName('understanding')
    .setDescription('设置严格规则或 AI 平衡语音理解')
    .addStringOption(option => option.setName('mode').setDescription('语音理解模式').setRequired(true).addChoices(...UNDERSTANDING_CHOICES)))
  .addSubcommand(subcommand => subcommand
    .setName('test')
    .setDescription('测试文本是否会被解析为语音命令')
    .addStringOption(option => option.setName('text').setDescription('模拟转写文本').setRequired(true).setMaxLength(300)))
  .addSubcommand(subcommand => subcommand.setName('diagnostics').setDescription('查看监听和 STT 诊断信息'))
  .addSubcommand(subcommand => subcommand
    .setName('cloud-stt')
    .setDescription('开启全员 STT 或完全关闭 STT')
    .addBooleanOption(option => option
      .setName('enabled')
      .setDescription('是否允许云 STT')
      .setRequired(true)))
  .addSubcommand(subcommand => subcommand
    .setName('stt-policy')
    .setDescription('设置云 STT 访问策略')
    .addStringOption(option => option
      .setName('mode')
      .setDescription('关闭或全员允许')
      .setRequired(true)
      .addChoices(...STT_POLICY_CHOICES)))
  .addSubcommandGroup(group => group
    .setName('wakeword')
    .setDescription('管理唤醒词')
    .addSubcommand(subcommand => subcommand.setName('add').setDescription('添加唤醒词')
      .addStringOption(option => option.setName('value').setDescription('唤醒词').setRequired(true).setMaxLength(40)))
    .addSubcommand(subcommand => subcommand.setName('remove').setDescription('移除唤醒词')
      .addStringOption(option => option.setName('value').setDescription('唤醒词').setRequired(true).setMaxLength(40)))
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('用逗号分隔列表替换唤醒词')
      .addStringOption(option => option.setName('values').setDescription('例如 音乐助手,小音箱').setRequired(true).setMaxLength(300)))
    .addSubcommand(subcommand => subcommand.setName('list').setDescription('列出唤醒词'))
    .addSubcommand(subcommand => subcommand.setName('reset').setDescription('恢复默认唤醒词')))
  .addSubcommandGroup(group => group
    .setName('audit-channel')
    .setDescription('管理审计频道')
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('设置只记录命令结果的频道')
      .addChannelOption(option => option.setName('channel').setDescription('审计频道').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(subcommand => subcommand.setName('clear').setDescription('清除审计频道')));

function updateVoiceControl(guildId, patch) {
  return GuildSettings.update(guildId, { voiceControl: patch }).voiceControl;
}

function splitWakeWords(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))].slice(0, 10);
}

async function syncManager(guildId) {
  await getVoiceControlManager()?.syncGuild(guildId).catch(error => {
    console.warn('[VoiceControl] listener sync failed:', error.message);
  });
}

async function refreshPanel(guildId) {
  const serverQueue = musicQueue.peek(guildId);
  if (!serverQueue) return;
  await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue).catch(error => {
    console.warn('[VoiceControl] panel refresh failed:', error.message);
  });
}

function statusEmbed(settings, diagnostics) {
  const voice = settings.voiceControl;
  return new EmbedBuilder()
    .setColor(voice.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle('语音控制状态')
    .addFields(
      { name: '功能', value: voice.enabled ? '开启' : '关闭', inline: true },
      { name: '监听 Bot', value: diagnostics.listenerReady ? `在线 (${diagnostics.listenerUser})` : '未在线', inline: true },
      { name: '当前连接', value: diagnostics.guildConnected ? `<#${diagnostics.guildChannelId}>` : '未连接', inline: true },
      { name: '自动加入', value: voice.listenerAutoJoin ? '开启' : '关闭', inline: true },
      { name: '唤醒词', value: voice.wakeWords.map(word => `\`${word}\``).join('、') || '无', inline: false },
      { name: '语言', value: voiceLanguageLabel(voice.language), inline: true },
      { name: '语音理解', value: voiceUnderstandingLabel(voice.understandingMode), inline: true },
      { name: '使用权限', value: '所有同频道真人', inline: true },
      { name: '云 STT 策略', value: sttPolicyLabel(voice.sttAccessMode), inline: false },
      { name: '已退出用户', value: `${voice.sttOptOutUserIds?.length || 0} 人`, inline: true },
      { name: '允许命令', value: voice.enabledCommands.join(', ') || '无', inline: true },
      { name: '审计频道', value: voice.auditChannelId ? `<#${voice.auditChannelId}>` : '未设置', inline: true },
    );
}

export async function execute(interaction) {
  if (!(await requireGuild(interaction))) return;
  if (!hasManageGuild(interaction)) {
    return interaction.reply('❌ 只有拥有“管理服务器”权限的成员可以修改语音控制。');
  }
  const guildId = interaction.guildId;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const current = GuildSettings.get(guildId).voiceControl;
  const slowOperation = (!group && ['enable', 'disable', 'diagnostics', 'language', 'understanding', 'test', 'cloud-stt', 'stt-policy'].includes(subcommand))
    || (group === 'wakeword' && !['list'].includes(subcommand));
  if (slowOperation) await interaction.deferReply();
  const respond = payload => slowOperation ? interaction.editReply(payload) : interaction.reply(payload);

  if (!group && subcommand === 'enable') {
    updateVoiceControl(guildId, {
      enabled: true,
      listenerAutoJoin: true,
      permissionMode: 'everyone',
      allowedRoleIds: [],
      sttAccessMode: 'everyone',
      consentedUserIds: [],
      enabledCommands: [...VoiceControlDefaults.enabledCommands],
    });
    await syncManager(guildId);
    await refreshPanel(guildId);
    return respond('✅ 语音控制已开启：所有同频道真人都可使用 STT 和全部语音命令，监听 Bot 会自动跟随主音乐 Bot。');
  }
  if (!group && subcommand === 'disable') {
    updateVoiceControl(guildId, {
      enabled: false,
      listenerAutoJoin: false,
      sttAccessMode: 'off',
      consentedUserIds: [],
    });
    await syncManager(guildId);
    await refreshPanel(guildId);
    getVoiceControlManager()?.abortGuildRecordings(guildId);
    return respond('✅ 语音控制已关闭，监听连接已清理；成员的个人退出记录仍保留。');
  }
  if (!group && subcommand === 'status') {
    const diagnostics = getVoiceControlManager()?.diagnostics(guildId) || {};
    return respond({ embeds: [statusEmbed(GuildSettings.get(guildId), diagnostics)] });
  }
  if (!group && subcommand === 'language') {
    const language = interaction.options.getString('value', true).trim().toLowerCase();
    updateVoiceControl(guildId, { language });
    await refreshPanel(guildId);
    return respond(`✅ 语音命令语言已设置为 **${voiceLanguageLabel(language)}**。`);
  }
  if (!group && subcommand === 'understanding') {
    const understandingMode = interaction.options.getString('mode', true);
    updateVoiceControl(guildId, { understandingMode });
    await refreshPanel(guildId);
    return respond(`✅ 语音理解已设置为 **${voiceUnderstandingLabel(understandingMode)}**。`);
  }
  if (!group && subcommand === 'test') {
    const text = interaction.options.getString('text', true);
    const parsed = parseVoiceCommand({
      text,
      wakeWords: current.wakeWords,
      language: current.language,
      understandingMode: current.understandingMode,
    });
    let output;
    if (parsed.matched) {
      output = `规则匹配：\`${parsed.command}\`${parsed.query ? `，查询：\`${parsed.query}\`` : ''}${parsed.fuzzyWake ? '，使用模糊唤醒' : ''}`;
    } else if (current.understandingMode === 'balanced' && parsed.wakeWord) {
      const intent = await parseAIVoiceIntent({
        transcript: text,
        commandText: parsed.commandText || text,
        language: current.language,
        fuzzyWake: parsed.fuzzyWake,
        enabledCommands: current.enabledCommands,
      });
      const threshold = Math.max(0.5, Math.min(1, Number(process.env.VOICE_CONTROL_AI_CONFIDENCE) || 0.88));
      output = intent?.matched
        ? `AI 理解：\`${intent.command}\`${intent.query ? `，查询：\`${intent.query}\`` : ''}，置信度 \`${intent.confidence}\`，${intent.confidence >= threshold && current.enabledCommands.includes(intent.command) ? '会执行' : '低于阈值或命令已禁用，不执行'}`
        : `AI 未确认命令${intent ? `，置信度 \`${intent.confidence}\`` : '，AI 当前不可用'}`;
    } else {
      output = `未匹配，原因：\`${parsed.reason}\``;
    }
    return respond(`🧪 ${output}`);
  }
  if (!group && subcommand === 'diagnostics') {
    const manager = getVoiceControlManager();
    if (manager) await manager.probeStt();
    const value = manager?.diagnostics(guildId) || {
      tokenConfigured: Boolean(process.env.VOICE_LISTENER_TOKEN),
      sttConfigured: false,
      listenerReady: false,
    };
    const status = value.sttStatus || {};
    const time = timestamp => timestamp ? `<t:${Math.floor(timestamp / 1000)}:R>` : '无';
    return respond([
      `监听开关：${value.listenerEnabled ? '开启' : '关闭'}`,
      `监听 Token：${value.tokenConfigured ? '已配置' : '未配置'}`,
      `STT：${value.sttConfigured ? '已配置' : '未完整配置'}`,
      `云 STT：${sttPolicyLabel(value.sttAccessMode)}，已退出 ${value.optedOutUserCount || 0} 人`,
      `Provider：${value.sttProvider || 'unknown'}`,
      `模型：${value.sttModel || '未设置'}`,
      `AI 语音理解：${value.aiConfigured ? `已配置 (${value.aiModel})` : '未配置'}`,
      `AI 执行阈值：${value.aiConfidenceThreshold ?? '未知'}`,
      `输入：${value.sttAudioFormat || '未知'}`,
      `Opus 解码：${status.opusDecoderBackend || '尚未初始化'}`,
      `监听 Bot：${value.listenerReady ? `在线 (${value.listenerUser})` : '未在线'}`,
      `自动加入：${value.listenerAutoJoin ? '开启' : '关闭'}`,
      `本服务器连接：${value.guildConnected ? `<#${value.guildChannelId}>` : '未连接'}`,
      `活动录音：${value.activeRecordings || 0}`,
      `焦点用户：${value.focusUserId ? `<@${value.focusUserId}>` : '无'}${value.focusExpiresAt ? `，至 ${time(value.focusExpiresAt)}` : ''}`,
      `Gateway 探测：${status.lastProbeOk === true ? '成功' : status.lastProbeOk === false ? '失败' : '未执行'}${status.lastProbeDetail ? ` (${status.lastProbeDetail})` : ''}`,
      `最近音频：${time(status.lastAudioAt)}${status.lastAudioDurationMs == null ? '' : `，${status.lastAudioDurationMs}ms，${status.lastAudioBytes || 0} bytes / ${status.lastAudioChunks || 0} chunks`}`,
      `最近 Opus：${time(status.lastOpusAt)}，成功 ${status.lastOpusDecodedPackets || 0}/${status.lastOpusPackets || 0} 包，丢弃 ${status.lastOpusDroppedPackets || 0} 包，连续错误 ${status.lastOpusConsecutiveErrors || 0}${status.lastOpusError ? `，最近错误 ${status.lastOpusError}` : ''}`,
      `最近 STT 结果：${status.lastOutcome || '无'}${status.lastOutcomeDetail ? ` (${status.lastOutcomeDetail})` : ''}${status.lastOutcomeAt ? `，${time(status.lastOutcomeAt)}` : ''}`,
      `最近转写成功：${time(status.lastSuccessAt)}`,
      `最近唤醒：${time(status.lastWakeAt)}`,
      `最近命令：${status.lastCommand ? `\`${status.lastCommand}\`，${time(status.lastCommandAt)}` : '无'}`,
      `最近命令结果：${status.lastCommandResult || '无'}`,
      `最近静默忽略：${status.lastIgnoredReason || '无'}${status.lastIgnoredAt ? `，${time(status.lastIgnoredAt)}` : ''}`,
      `最近 AI 解析：${time(status.lastAiAt)}${status.lastAiConfidence == null ? '' : `，置信度 ${status.lastAiConfidence}`}`,
      `AI 命令：${status.aiCommands || 0}`,
      `AI 拒绝：${status.aiRejected || 0}`,
      `AI 不可用：${status.aiUnavailable || 0}`,
      `模糊唤醒：${status.fuzzyWakeCount || 0}`,
      `提示词泄漏拒绝：${status.promptLeakRejected || 0}`,
      `语音频率限制：${status.ignoredForRateLimit || 0}`,
      `AI 频率限制：${status.aiRateLimited || 0}`,
      `焦点忽略：${status.ignoredForFocus || 0}`,
      `服务器并发忽略：${status.ignoredForGuildConcurrency || 0}`,
      `全局并发忽略：${status.ignoredForGlobalConcurrency || 0}`,
      `待处理语音：入队 ${status.pendingQueued || 0}，已处理 ${status.pendingProcessed || 0}，丢弃 ${status.pendingDropped || 0}${status.lastPendingState ? `，最近 ${status.lastPendingState}` : ''}`,
      `忙碌忽略：${status.busyIgnored || 0}`,
      `连续失败：${status.consecutiveFailures || 0}`,
      `熔断：${status.circuitOpenUntil > Date.now() ? `至 ${time(status.circuitOpenUntil)}` : '否'}`,
      `最近错误：${status.lastError || '无'}`,
    ].join('\n'));
  }
  if (!group && subcommand === 'cloud-stt') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const updated = setCloudSttEnabled(guildId, enabled);
    getVoiceControlManager()?.abortGuildRecordings(guildId);
    await syncManager(guildId);
    return respond(updated.cloudSttEnabled
      ? '✅ 全员云 STT 已开启。所有同频道真人都可使用语音控制，主动退出的成员除外。'
      : '✅ 云 STT 已禁止，进行中的语音处理已清理；监听 Bot 是否留在频道由“自动加入”设置控制。');
  }
  if (!group && subcommand === 'stt-policy') {
    const mode = interaction.options.getString('mode', true);
    const result = setVoiceSttAccessMode(guildId, mode);
    if (!result.ok) return respond('❌ 无效的云 STT 策略。');
    if (mode === 'everyone') {
      updateVoiceControl(guildId, {
        enabled: true,
        listenerAutoJoin: true,
        permissionMode: 'everyone',
        allowedRoleIds: [],
        consentedUserIds: [],
        enabledCommands: [...VoiceControlDefaults.enabledCommands],
      });
    }
    getVoiceControlManager()?.abortGuildRecordings(guildId);
    await syncManager(guildId);
    await refreshPanel(guildId);
    return respond(`✅ 云 STT 策略已设置为 **${sttPolicyLabel(mode)}**。${mode === 'everyone' ? '所有同频道真人均可使用全部语音命令，主动退出的成员除外。' : ''}`);
  }

  if (group === 'wakeword') {
    let wakeWords = [...current.wakeWords];
    if (subcommand === 'add') wakeWords.push(interaction.options.getString('value', true).trim());
    if (subcommand === 'remove') {
      const value = interaction.options.getString('value', true).trim().toLowerCase();
      wakeWords = wakeWords.filter(word => word.toLowerCase() !== value);
      if (!wakeWords.length) return respond('❌ 至少保留一个唤醒词。');
    }
    if (subcommand === 'set') wakeWords = splitWakeWords(interaction.options.getString('values', true));
    if (subcommand === 'reset') wakeWords = [...VoiceControlDefaults.wakeWords];
    if (subcommand === 'list') return respond(`唤醒词：${wakeWords.map(word => `\`${word}\``).join('、')}`);
    if (!wakeWords.length) return respond('❌ 至少需要一个有效唤醒词。');
    const updated = updateVoiceControl(guildId, { wakeWords });
    await refreshPanel(guildId);
    return respond(`✅ 唤醒词：${updated.wakeWords.map(word => `\`${word}\``).join('、')}`);
  }

  if (group === 'audit-channel') {
    const auditChannelId = subcommand === 'clear' ? null : interaction.options.getChannel('channel', true).id;
    updateVoiceControl(guildId, { auditChannelId });
    return respond(auditChannelId ? `✅ 审计频道已设置为 <#${auditChannelId}>。` : '✅ 审计频道已清除。');
  }

}
