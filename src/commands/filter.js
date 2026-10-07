import { SlashCommandBuilder } from 'discord.js';
import { MusicPlayer, musicQueue } from '../utils/player.js';
import { AUDIO_FILTERS, filterLabel } from '../utils/filters.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('filter')
  .setDescription('设置音频滤镜')
  .addStringOption(option => {
    option
      .setName('mode')
      .setDescription('滤镜模式')
      .setRequired(true);

    for (const [value, filter] of Object.entries(AUDIO_FILTERS)) {
      option.addChoices({ name: filter.label, value });
    }
    return option;
  });

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  const mode = interaction.options.getString('mode');
  const serverQueue = musicQueue.peek(interaction.guild.id);
  if (!serverQueue?.currentSong) {
    return interaction.reply({ content: '❌ 当前没有正在播放的歌曲。', flags: 64 });
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply({ content: '❌ 你需要和我在同一个语音频道！', flags: 64 });
  }

  await interaction.deferReply();
  try {
    const ok = await MusicPlayer.setFilter(interaction.guild.id, mode);
    if (!ok) return interaction.editReply('❌ 未知滤镜模式。');
    return interaction.editReply(`✅ 音频滤镜已切换为：${filterLabel(mode)}。`);
  } catch (error) {
    console.error('[Filter] error:', error.message);
    return interaction.editReply('❌ 切换滤镜失败，请稍后再试。');
  }
}
