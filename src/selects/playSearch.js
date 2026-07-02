import { addSongsToPlayback } from '../utils/playback.js';

const SESSION_TTL_MS = 3 * 60 * 1000;

export const customId = 'play_search';

async function expireSearch(interaction, sessionId) {
  if (sessionId) {
    interaction.client.searchSessions?.delete(sessionId);
  }
  return interaction.update({
    content: '❌ 这个搜索结果已经失效，请重新使用 /play 搜索。',
    embeds: [],
    components: [],
  });
}

export async function execute(interaction) {
  const sessionId = interaction.customId.split(':').slice(1).join(':');
  const session = interaction.client.searchSessions?.get(sessionId);

  if (!session) {
    return expireSearch(interaction, sessionId);
  }

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    return expireSearch(interaction, sessionId);
  }

  if (interaction.user.id !== session.userId) {
    return interaction.reply({ content: '❌ 只有发起这次搜索的人可以选择歌曲。', flags: 64 });
  }

  const selectedIndex = Number(interaction.values[0]);
  const song = session.results[selectedIndex];
  if (!song) {
    return interaction.reply({ content: '❌ 选择的歌曲不存在，请重新搜索。', flags: 64 });
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== session.voiceChannelId) {
    return interaction.reply({ content: '❌ 你需要留在发起搜索时的语音频道。', flags: 64 });
  }

  interaction.client.searchSessions.delete(sessionId);
  await interaction.deferUpdate();
  await interaction.editReply({ content: `✅ 已选择：**${song.title}**\n正在添加到播放队列...`, embeds: [], components: [] });
  await addSongsToPlayback(interaction, [song], { editReply: true });
}
