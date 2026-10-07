import { SlashCommandBuilder } from 'discord.js';
import { requireGuild } from '../utils/commandSafety.js';
import { getVoiceControlManager } from '../utils/voiceControlRuntime.js';
import { grantVoiceConsent, revokeVoiceConsent, voiceConsentStatus } from '../utils/voiceConsent.js';

export const data = new SlashCommandBuilder()
  .setName('voice-consent')
  .setDescription('退出或重新加入全员云 STT')
  .addSubcommand(subcommand => subcommand
    .setName('grant')
    .setDescription('重新加入全员云 STT'))
  .addSubcommand(subcommand => subcommand
    .setName('revoke')
    .setDescription('退出全员云 STT，并停止进行中处理'))
  .addSubcommand(subcommand => subcommand
    .setName('status')
    .setDescription('查看服务器策略和你的实际可用状态'));

export async function execute(interaction) {
  if (!(await requireGuild(interaction))) return;
  const guildId = interaction.guildId || interaction.guild.id;
  const userId = interaction.user.id;
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: 64 });

  if (subcommand === 'grant') {
    const result = grantVoiceConsent(guildId, userId);
    if (!result.ok && result.reason === 'server-disabled') {
      return interaction.editReply({
        content: '❌ 本服务器云 STT 已关闭。请管理员使用 `/voice-control enable` 或 `/voice-control stt-policy mode:everyone` 开启。',
      });
    }
    const manager = getVoiceControlManager();
    if (manager) await manager.syncGuild(guildId).catch(error => {
      console.warn('[VoiceConsent] listener sync failed:', error.message);
    });
    return interaction.editReply({
      content: result.changed
        ? '✅ 你已重新加入全员 STT。可随时使用 `/voice-consent revoke` 再次退出。'
        : 'ℹ️ 你已经在全员 STT 范围内。可随时使用 `/voice-consent revoke` 退出。',
    });
  }

  if (subcommand === 'revoke') {
    const result = revokeVoiceConsent(guildId, userId);
    const manager = getVoiceControlManager();
    manager?.revokeUserConsent(guildId, userId);
    if (manager) await manager.syncGuild(guildId).catch(error => {
      console.warn('[VoiceConsent] listener sync failed:', error.message);
    });
    return interaction.editReply({
      content: result.changed
        ? '✅ 你已退出云 STT，进行中的语音处理已停止。可使用 `/voice-consent grant` 重新加入。'
        : 'ℹ️ 你已经退出云 STT，当前不会处理你的新语音。',
    });
  }

  const status = voiceConsentStatus(guildId, userId);
  const modeLabel = status.sttAccessMode === 'everyone' ? '全员允许（成员可退出）' : '完全关闭';
  return interaction.editReply({
    content: [
      `服务器云 STT：${modeLabel}`,
      `你的 STT 状态：${status.effectiveAllowed ? '允许处理和执行全部语音命令' : status.optedOut ? '已主动退出' : '服务器已关闭'}`,
      '语音命令权限：所有同频道真人',
      `已退出用户：${status.optedOutUserCount} 人`,
      '说明：唤醒词由云 STT 识别，因此同频道真人的讲话片段会在确认唤醒词之前发送。',
    ].join('\n'),
  });
}
