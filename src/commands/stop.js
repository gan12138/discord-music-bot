import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('停止播放并清空队列');

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.connection) {
    return interaction.reply('❌ 当前没有播放任何内容！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  MusicPlayer.stop(interaction.guild.id);
  await interaction.reply('⏹️ 已停止播放并清空队列');
}
