import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('调整音量')
  .addIntegerOption(option =>
    option.setName('level')
      .setDescription('音量大小 (0-100)')
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true)
  );

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.reply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  const volume = interaction.options.getInteger('level');
  MusicPlayer.setVolume(interaction.guild.id, volume);
  await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);

  await interaction.reply(`🔊 音量已设置为 ${volume}%`);
}
