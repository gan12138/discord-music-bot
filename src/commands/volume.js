import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

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
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.editReply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.editReply('❌ 你需要和我在同一个语音频道！');
  }

  const volume = interaction.options.getInteger('level');
  if (!await MusicPlayer.setVolume(interaction.guild.id, volume)) {
    return interaction.editReply('❌ 音量设置失败，当前播放器状态不同步。');
  }
  await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);

  await interaction.editReply(`🔊 音量已设置为 ${volume}%`);
}
