import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('暂停当前播放');

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.reply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  if (MusicPlayer.pause(interaction.guild.id)) {
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    await interaction.reply('⏸️ 已暂停播放');
  } else {
    await interaction.reply('❌ 暂停失败！');
  }
}
