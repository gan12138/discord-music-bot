import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('停止播放并清空队列');

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue) {
    return interaction.editReply('❌ 当前没有播放任何内容！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.editReply('❌ 你需要和我在同一个语音频道！');
  }

  if (!await MusicPlayer.stop(interaction.guild.id)) {
    return interaction.editReply('❌ 停止失败，当前播放器状态不同步。');
  }
  await interaction.editReply('⏹️ 已停止播放并清空队列');
}
