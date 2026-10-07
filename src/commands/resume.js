import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('继续播放');

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.pausedAt) {
    return interaction.editReply('❌ 当前没有暂停的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.editReply('❌ 你需要和我在同一个语音频道！');
  }

  if (await MusicPlayer.resume(interaction.guild.id)) {
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    await interaction.editReply('▶️ 已继续播放');
  } else {
    await interaction.editReply('❌ 继续播放失败！');
  }
}
