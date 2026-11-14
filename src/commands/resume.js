import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { inspectVoiceContext, requireMusicAccess } from '../utils/commandSafety.js';
import { savePlaybackState } from '../utils/playbackState.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('继续播放');

export async function execute(interaction) {
  // Not requireBotInVoice: a song paused across a restart has no connection yet.
  if (!(await requireMusicAccess(interaction, { requireVoice: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guild.id;
  const serverQueue = musicQueue.peek(guildId);

  if (!serverQueue || !serverQueue.pausedAt) {
    return interaction.editReply('❌ 当前没有暂停的歌曲！');
  }

  const voiceChannel = inspectVoiceContext(interaction, { requireBotInVoice: false });
  if (!voiceChannel.ok) {
    return interaction.editReply(voiceChannel.message);
  }

  // Restore the connection for a preserved pause, then resume playback.
  if (!serverQueue.connection) {
    try {
      serverQueue.connection = await MusicPlayer.joinVoice(
        voiceChannel.voiceChannel,
        guildId,
        interaction.guild.voiceAdapterCreator,
      );
      serverQueue.pausedByEmptyChannel = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      if (serverQueue.currentSong) {
        await MusicPlayer.ensurePlaybackOutput(guildId, 'resume-after-restore', { force: true });
      }
    } catch (error) {
      return interaction.editReply(`❌ 恢复语音连接失败：${MusicPlayer.safeErrorMessage(error)}`);
    }
  }

  if (await MusicPlayer.resume(guildId)) {
    await refreshNowPlayingPanel(guildId, interaction.channel, serverQueue);
    await interaction.editReply('▶️ 已继续播放');
  } else {
    await interaction.editReply('❌ 继续播放失败！');
  }
}
