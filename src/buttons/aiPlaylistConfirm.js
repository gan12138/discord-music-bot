import { commitPlaylistPlan, takePendingPlan, discardPendingPlan, buildResultMessage } from '../utils/aiPlaylistPlan.js';
import { protectInteraction, safeEditReply } from '../utils/commandSafety.js';

export const customId = 'aiplaylist';

export async function execute(interaction) {
  protectInteraction(interaction);
  await interaction.deferUpdate();
  const [, action, token] = interaction.customId.split(':');
  const userId = interaction.user.id;

  if (action === 'cancel') {
    const discarded = token
      ? discardPendingPlan(token, userId, interaction.guildId)
      : { ok: false };
    if (!discarded.ok && discarded.reason === 'wrong-user') {
      return safeEditReply(interaction, { content: '❌ 只有发起该操作的用户可以取消。', components: [] });
    }
    if (!discarded.ok && discarded.reason === 'wrong-guild') {
      return safeEditReply(interaction, { content: '❌ 这个确认不属于当前服务器。', components: [] });
    }
    return safeEditReply(interaction, { content: '❌ 已取消，歌单未改动。', components: [] });
  }

  if (action !== 'confirm') {
    return safeEditReply(interaction, { content: '❌ 无效的操作。', components: [] });
  }

  const taken = takePendingPlan(token, userId, interaction.guildId);
  if (!taken.ok) {
    const message = taken.reason === 'wrong-user'
      ? '❌ 只有发起该操作的用户可以确认。'
      : taken.reason === 'wrong-guild'
        ? '❌ 这个确认不属于当前服务器。'
      : '❌ 这个确认已失效（超过 5 分钟或已处理），请重新执行 /playlist ai。';
    return safeEditReply(interaction, { content: message, components: [] });
  }

  try {
    const summary = commitPlaylistPlan(taken.plan);
    await safeEditReply(interaction, { content: buildResultMessage(taken.plan, summary), components: [] });
  } catch (error) {
    console.error('[AI Playlist] confirm commit failed:', error);
    await safeEditReply(interaction, { content: '❌ 执行失败，请稍后再试。', components: [] });
  }
}
