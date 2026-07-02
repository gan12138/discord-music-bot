import { commitPlaylistPlan, takePendingPlan, discardPendingPlan, buildResultMessage } from '../utils/aiPlaylistPlan.js';

export const customId = 'aiplaylist';

export async function execute(interaction) {
  await interaction.deferUpdate();
  const [, action, token] = interaction.customId.split(':');
  const userId = interaction.user.id;

  if (action === 'cancel') {
    if (token) discardPendingPlan(token);
    return interaction.editReply({ content: '❌ 已取消，歌单未改动。', components: [] });
  }

  if (action !== 'confirm') {
    return interaction.editReply({ content: '❌ 无效的操作。', components: [] });
  }

  const taken = takePendingPlan(token, userId);
  if (!taken.ok) {
    const message = taken.reason === 'wrong-user'
      ? '❌ 只有发起该操作的用户可以确认。'
      : '❌ 这个确认已失效（超过 5 分钟或已处理），请重新执行 /playlist ai。';
    return interaction.editReply({ content: message, components: [] });
  }

  try {
    const summary = commitPlaylistPlan(taken.plan);
    await interaction.editReply({ content: buildResultMessage(taken.plan, summary), components: [] });
  } catch (error) {
    console.error('[AI Playlist] confirm commit failed:', error);
    await interaction.editReply({ content: '❌ 执行失败，请稍后再试。', components: [] });
  }
}
