import { musicQueue, MusicPlayer } from '../utils/player.js';
import { describeStyle, ensureRadioQueue, invalidateRadioGeneration, refreshRadioSeed } from '../utils/radio.js';
import { buildNowPlayingPayload, isPanelCurrent, refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { GuildSettings } from '../models/database.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { getVoiceControlManager } from '../utils/voiceControlRuntime.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

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
  const queue = musicQueue.peek(guildId);
  await MusicPlayer.waitForAdvance(guildId, timeoutMs, queue?.advanceSignal || 0);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  if (!interaction.guildId) return interaction.editReply('❌ 这个面板只能在服务器中使用。');
  const [, action, panelId] = interaction.customId.split(':');
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue) {
    return interaction.editReply('📭 队列为空。');
  }

  if (!serverQueue.currentSong && !['queue', 'voice'].includes(action)) {
    return interaction.editReply('❌ 当前没有正在播放的歌曲。');
  }

  if (action === 'voice') {
    if (!(await requireMusicAccess(interaction, {
      manageGuildOnly: true,
    }))) return;
  } else if (action !== 'queue' && !(await requireMusicAccess(interaction, {
    requireVoice: true,
    requireBotInVoice: true,
  }))) return;

  const voiceChannel = interaction.member.voice.channel;
  if (panelId && !isPanelCurrent(serverQueue, panelId)) {
    return interaction.editReply('⚠️ 此按钮来自旧播放面板，已失效。请使用最新的播放面板。');
  }

  if (action === 'voice') {
    const voiceSettings = GuildSettings.get(interaction.guild.id).voiceControl;
    if (!voiceSettings.enabled) {
      return interaction.editReply('❌ 语音控制当前未开启，请管理员先执行 `/voice-control enable`。');
    }
    const manager = getVoiceControlManager();
    if (!manager?.diagnostics(interaction.guild.id)?.listenerReady) {
      return interaction.editReply('❌ 语音监听 Bot 当前未在线或未完成配置。');
    }

    const diagnostics = manager.diagnostics(interaction.guild.id);
    const shouldJoin = diagnostics.guildConnected !== true;
    GuildSettings.update(interaction.guild.id, {
      voiceControl: {
        listenerAutoJoin: shouldJoin,
      },
    });

    await manager.syncGuild(interaction.guild.id).catch(error => {
      console.warn('[VoiceControl] panel listener sync failed:', error.message);
    });
    const after = manager.diagnostics(interaction.guild.id);
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);

    if (shouldJoin) {
      const content = after.guildConnected
        ? '✅ 语音子 Bot 已加入当前语音频道，并会跟随主音乐 Bot。云 STT 和个人授权设置保持不变。'
        : '⚠️ 已开启语音子 Bot 自动加入，但它暂时还没有连接成功，请稍后再试或检查权限。';
      return serverQueue.notificationMode === 'private'
        ? interaction.editReply({ content, ...buildNowPlayingPayload(serverQueue, serverQueue.currentSong) })
        : interaction.editReply(content);
    }
    const content = '✅ 语音子 Bot 已离开语音频道。云 STT 和个人授权设置保持不变。';
    return serverQueue.notificationMode === 'private'
      ? interaction.editReply({ content, ...buildNowPlayingPayload(serverQueue, serverQueue.currentSong) })
      : interaction.editReply(content);
  }

  const respondWithPanel = async (content, { includeStaleNote = true } = {}) => {
    const note = includeStaleNote ? '' : '';
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
      if (!await MusicPlayer.resume(interaction.guild.id)) {
        return interaction.editReply('❌ 继续播放失败，当前播放器状态不同步。');
      }
      return respondWithPanel('▶️ 已继续播放。');
    }
    if (!await MusicPlayer.pause(interaction.guild.id)) {
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
    const advanceSignal = serverQueue.advanceSignal || 0;
    const result = await MusicPlayer.skip(interaction.guild.id);
    if (result.ok) {
      await MusicPlayer.waitForAdvance(interaction.guild.id, 3000, advanceSignal);
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
    const stopped = await MusicPlayer.stop(interaction.guild.id);
    if (!stopped) return interaction.editReply('❌ 停止失败，当前播放器状态不同步。');
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.editReply('⏹️ 已停止播放并清空队列。');
  }

  if (action === 'loop') {
    const nextMode = serverQueue.loop === 'off' ? 'single' : serverQueue.loop === 'single' ? 'queue' : 'off';
    MusicPlayer.setLoop(interaction.guild.id, nextMode);
    const label = nextMode === 'off' ? '关闭' : nextMode === 'single' ? '单曲循环' : '队列循环';
    return respondWithPanel(`🔁 循环模式已切换为：${label}`);
  }

  if (action === 'radio') {
    invalidateRadioGeneration(serverQueue, 'panel-radio-toggle');
    serverQueue.radio.enabled = !serverQueue.radio.enabled;
    serverQueue.radioQueue = [];
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
