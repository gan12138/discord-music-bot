import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { YouTube } from '../utils/youtube.js';

export const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('搜索YouTube视频')
  .addStringOption(option =>
    option.setName('query')
      .setDescription('搜索关键词')
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option.setName('limit')
      .setDescription('显示结果数量 (1-10)')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('query');
  const limit = interaction.options.getInteger('limit') || 5;

  try {
    const results = await YouTube.search(query, limit);

    if (results.length === 0) {
      return interaction.editReply('❌ 未找到任何结果！');
    }

    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle(`🔍 搜索结果: ${query}`)
      .setDescription(
        results.map((video, index) =>
          `**${index + 1}.** ${video.title}\n` +
          `   时长: ${video.duration} | 观看: ${video.views?.toLocaleString() || 'N/A'}`
        ).join('\n\n')
      )
      .setFooter({ text: '使用 /play 命令播放歌曲' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Search command error:', error);
    return interaction.editReply('❌ 搜索时出现错误！');
  }
}
