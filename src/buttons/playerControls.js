import { musicQueue, MusicPlayer } from '../utils/player.js';
import { describeStyle, ensureRadioQueue, refreshRadioSeed } from '../utils/radio.js';
import { buildNowPlayingPayload, isPanelCurrent, refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { savePlaybackState } from '../utils/playbackState.js';

export const customId = 'player';

function queueSummary(serverQueue) {
  const manual = serverQueue.songs.slice(0, 5).map((song, index) => `${index + 1}. ${song.title}`);
  const radio = serverQueue.radioQueue.slice(0, 5).map((song, index) => `${index + 1}. ${song.title}`);
  return [
    serverQueue.currentSong ? `正在播放：${serverQueue.currentSong.title}` : '当前没有播放',
    '',
    `手动队列（${serverQueue.songs.length}）：`,
    manual.length ? manual.join('\n') : '空',
    '',
    `自动续播（${serverQueue.radioQueue.length}）：`,
    radio.length ? radio.join('\n') : '空',
    '',
    `Radio：${serverQueue.radio.enabled ? `开启｜${describeStyle(serverQueue.radio.currentStyle)}` : '关闭'}`,
  ].join('\n');
}

function radioGeneratedMessage(generatedCount, serverQueue) {
  if (generatedCount > 0) {
    return `📻 Radio 已开启，已生成 ${generatedCount} 首推荐，将在手动队列结束后自动续播。`;
  }
  return `📻 Radio 已开启，但暂时没有生成到推荐。当前播放如果是长视频或非音乐内容，将不会作为推荐种子；已按当前风格「${describeStyle(serverQueue.radio.currentStyle)}」尝试生成。`;
}

async function waitForSongChange(guildId, timeoutMs = 3000) {
  await MusicPlayer.waitForAdvance(guildId, timeoutMs);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const [, action, panelId] = interaction.customId.split(':');
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue) {
    return interaction.editReply('📭 队列为空。');
  }

  if (!serverQueue.currentSong && action !== 'queue') {
    return interaction.editReply('❌ 当前没有正在播放的歌曲。');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (action !== 'queue' && (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id)) {
    return interaction.editReply('❌ 你需要和我在同一个语音频道！');
  }

  const stalePanelNote = panelId && !isPanelCurrent(serverQueue, panelId) && action !== 'queue'
    ? '\n⚠️ 你使用的是旧面板，操作已对当前播放生效。'
    : '';

  const respondWithPanel = async (content, { includeStaleNote = true } = {}) => {
    const note = includeStaleNote && serverQueue.notificationMode !== 'private' ? stalePanelNote : '';
    if (serverQueue.notificationMode === 'panel') {
      await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    }
    if (serverQueue.notificationMode === 'private' && serverQueue.currentSong) {
      return interaction.editReply({
        content: `${content}${note}`,
        ...buildNowPlayingPayload(serverQueue, serverQueue.currentSong),
      });
    }
    return interaction.editReply(`${content}${note}`);
  };

  if (action === 'pause') {
    if (serverQueue.pausedAt) {
      if (!MusicPlayer.resume(interaction.guild.id)) {
        return interaction.editReply('❌ 继续播放失败，当前播放器状态不同步。');
      }
      return respondWithPanel('▶️ 已继续播放。');
    }
    if (!MusicPlayer.pause(interaction.guild.id)) {
      return interaction.editReply('❌ 暂停失败，当前播放器状态不同步。');
    }
    return respondWithPanel('⏸️ 已暂停播放。');
  }

  if (action === 'previous') {
    const result = await MusicPlayer.previous(interaction.guild.id);
    if (!result.ok) {
      return interaction.editReply(result.reason === 'no-history' ? '❌ 没有上一首。' : '❌ 当前没有正在播放的歌曲。');
    }
    return respondWithPanel(`⏮️ 已切换到上一首：${result.song.title}`);
  }

  if (action === 'next' || action === 'skip') {
    const result = await MusicPlayer.skip(interaction.guild.id);
    if (result.ok) {
      await waitForSongChange(interaction.guild.id);
      return respondWithPanel(`⏭️ 已切换到下一首：${result.song.title}`);
    }
    if (result.reason === 'no-radio-recommendation') {
      return respondWithPanel('📻 Radio 暂时没有找到下一首，当前歌曲会继续播放。请稍后再试或调整 /radio style。');
    }
    if (result.reason === 'no-next-song') {
      return respondWithPanel('📭 队列里没有下一首。');
    }
    if (result.reason === 'no-player') {
      return interaction.editReply('❌ 跳过失败，当前播放器状态不同步。');
    }
    return interaction.editReply('❌ 跳过失败。');
  }

  if (action === 'stop') {
    MusicPlayer.stop(interaction.guild.id);
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.editReply(`⏹️ 已停止播放并清空队列。${stalePanelNote}`);
  }

  if (action === 'loop') {
    const nextMode = serverQueue.loop === 'off' ? 'single' : serverQueue.loop === 'single' ? 'queue' : 'off';
    MusicPlayer.setLoop(interaction.guild.id, nextMode);
    const label = nextMode === 'off' ? '关闭' : nextMode === 'single' ? '单曲循环' : '队列循环';
    return respondWithPanel(`🔁 循环模式已切换为：${label}`);
  }

  if (action === 'radio') {
    serverQueue.radio.enabled = !serverQueue.radio.enabled;
    if (serverQueue.radio.enabled) {
      MusicPlayer.clearIdleLeaveTimer(serverQueue);
      serverQueue.queueEnded = false;
      refreshRadioSeed(serverQueue);
      savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
      let generatedCount = 0;
      if (serverQueue.radioQueue.length < 2) {
        generatedCount = await ensureRadioQueue(serverQueue, 5);
      }
      if (MusicPlayer.isManualPlaybackActive(serverQueue)) {
        savePlaybackState(interaction.guild.id, serverQueue);
        return respondWithPanel(radioGeneratedMessage(generatedCount, serverQueue));
      }
      if (!serverQueue.playing && serverQueue.radioQueue.length > 0) {
        if (!serverQueue.connection) {
          serverQueue.connection = await MusicPlayer.joinVoice(
            voiceChannel,
            interaction.guild.id,
            interaction.guild.voiceAdapterCreator
          );
        }
        await MusicPlayer.playSong(interaction.guild.id, interaction.channel);
        savePlaybackState(interaction.guild.id, serverQueue);
        return respondWithPanel('📻 Radio 已开启，已开始自动续播。');
      }
      if (serverQueue.radioQueue.length === 0 && generatedCount === 0) {
        savePlaybackState(interaction.guild.id, serverQueue);
        return respondWithPanel('📻 Radio 已开启，但暂时没有找到可播放推荐。请尝试调整 /radio style 或使用 /version any 放宽版本偏好。');
      }
    }
    savePlaybackState(interaction.guild.id, serverQueue);
    return respondWithPanel(`📻 Radio 已${serverQueue.radio.enabled ? '开启' : '关闭'}。`);
  }

  if (action === 'queue') {
    return interaction.editReply(queueSummary(serverQueue));
  }

  return interaction.editReply('❌ 未知控制按钮。');
}
