import { musicQueue, MusicPlayer } from './player.js';
import { buildNowPlayingPayload } from './playerPanel.js';
import { getMaxQueueSize, getQueueCapacity, savePlaybackState } from './playbackState.js';

const PLAY_TIMING = process.env.PLAY_TIMING === '1';

function timingLog(startedAt, step) {
  if (PLAY_TIMING && startedAt) console.log(`[play timing] ${step}: ${Date.now() - startedAt}ms`);
}

export async function enqueueSongs({
  guild,
  voiceChannel,
  textChannel,
  requester,
  songs,
  waitForStart = false,
  signal = null,
  validateOperation = null,
}) {
  const startedAt = PLAY_TIMING ? Date.now() : null;
  if (!voiceChannel) {
    throw new Error('你需要先加入语音频道');
  }
  if (!MusicPlayer.operationIsValid({ signal, validateOperation })) {
    return { ok: false, reason: 'stale', serverQueue: null, addedSongs: [], shouldStartPlayback: false, startedPlayback: false };
  }

  const permissions = voiceChannel.permissionsFor(guild.members.me);
  if (!permissions?.has?.('ViewChannel') || !permissions.has('Connect') || !permissions.has('Speak')) {
    throw new Error('主音乐 Bot 没有权限加入或在该语音频道说话');
  }

  const queueSongs = Array.isArray(songs) ? songs : [];
  const operationOptions = { signal, validateOperation };
  return MusicPlayer.runTransition(guild.id, async () => {
    const serverQueue = musicQueue.get(guild.id);
    // The operation may have been revoked while this call waited for the
    // guild lock (voice opt-out, STT off, stop). Recheck before any mutation.
    if (!MusicPlayer.operationIsValid(operationOptions)) {
      return {
        ok: false,
        reason: 'stale',
        operationId: null,
        serverQueue,
        addedSongs: [],
        shouldStartPlayback: false,
        startedPlayback: false,
      };
    }
    const botChannelId = guild.members.me?.voice?.channelId || serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId;
    if (botChannelId && botChannelId !== voiceChannel.id) {
      throw new Error('你需要和我在同一个语音频道');
    }
    const operationId = MusicPlayer.operationId?.('enqueue') || `enqueue:${Date.now()}`;
    const inputSongs = queueSongs;
    const capacity = getQueueCapacity(serverQueue);
    if (inputSongs.length > capacity) {
      return {
        ok: false,
        reason: 'queue-full',
        serverQueue,
        addedSongs: [],
        rejectedSongs: inputSongs,
        requestedCount: inputSongs.length,
        capacity,
        maxQueueSize: getMaxQueueSize(),
        shouldStartPlayback: false,
        startedPlayback: false,
      };
    }

    MusicPlayer.clearIdleLeaveTimer(serverQueue);
    serverQueue.queueEnded = false;
    if (voiceChannel.members.some(member => !member.user.bot)) {
      serverQueue.pausedByEmptyChannel = false;
    }
    if (textChannel) {
      serverQueue.textChannel = textChannel;
      serverQueue.textChannelId = textChannel.id;
    }

    const queuedSongs = inputSongs.map(song => MusicPlayer.ensureQueueItemId({
      ...song,
      requestedBy: requester?.toString?.() || String(requester?.id || requester || 'voice-control'),
      requestedById: requester?.id || null,
      source: 'manual',
    }, operationId));
    const addedSongs = [...queuedSongs];

    const actuallyPlaying = MusicPlayer.isPlaybackActuallyActive(serverQueue);
    if (serverQueue.playing && !actuallyPlaying) {
      console.warn(`[Playback] Detected stale playing=true for guild ${guild.id}, resetting from actual backend state`);
      serverQueue.playing = false;
      serverQueue.advancing = false;
      serverQueue.activeBackend = null;
      serverQueue.startingBackend = null;
    }

    // 当前自动续播正在起播时，手动歌曲只入队，不抢占正在进行的 transition。
    const shouldStartPlayback = !actuallyPlaying
      && !serverQueue.advancing
      && !serverQueue.lavalinkStarting
      && !serverQueue.backendTransitioning
      && !serverQueue.startingBackend
      && !serverQueue.startReservation;

    MusicPlayer.prepareManualPlayback(serverQueue);
    MusicPlayer.addQueueItems(serverQueue, queuedSongs, operationId);
    savePlaybackState(guild.id, serverQueue);

    if (!serverQueue.connection) {
      serverQueue.startReservation = shouldStartPlayback ? operationId : serverQueue.startReservation;
      try {
        serverQueue.connection = await MusicPlayer.joinVoice(
          voiceChannel,
          guild.id,
          guild.voiceAdapterCreator,
          { signal },
        );
        timingLog(startedAt, 'joinVoice completed');
      } catch (error) {
        if (MusicPlayer.isLavalinkInfrastructureError(error)) {
          MusicPlayer.markBackendUnavailable(guild.id, serverQueue, error, { pendingSong: queuedSongs[0] });
          if (serverQueue.startReservation === operationId) serverQueue.startReservation = null;
          savePlaybackState(guild.id, serverQueue, { immediate: true });
          return {
            ok: true,
            reason: 'backend-unavailable',
            operationId,
            serverQueue,
            addedSongs,
            addedItemIds: addedSongs.map(song => song.queueItemId),
            shouldStartPlayback: true,
            startedPlayback: false,
            backendUnavailable: true,
          };
        }
        MusicPlayer.removeQueueItemsById(serverQueue, queuedSongs.map(song => song.queueItemId));
        if (serverQueue.startReservation === operationId) serverQueue.startReservation = null;
        savePlaybackState(guild.id, serverQueue, { immediate: true });
        throw error;
      }
    }

    // Revocation may have happened while joinVoice/playSong startup was in
    // flight. Roll back exactly what this operation added instead of leaving
    // a song or a fresh voice connection behind.
    if (!MusicPlayer.operationIsValid(operationOptions)) {
      if (serverQueue.startReservation === operationId) serverQueue.startReservation = null;
      const addedIds = new Set(queuedSongs.map(song => song.queueItemId));
      MusicPlayer.removeQueueItemsById(serverQueue, [...addedIds]);
      // Do not cut a song that is already audible, but never leave this
      // command's half-started track as the current song.
      if (!MusicPlayer.isPlaybackActuallyActive(serverQueue)
        && serverQueue.currentSong && addedIds.has(serverQueue.currentSong.queueItemId)) {
        MusicPlayer.clearFinishedCurrentSong(serverQueue, { remember: false });
      }
      savePlaybackState(guild.id, serverQueue, { immediate: true });
      if (!serverQueue.currentSong && serverQueue.songs.length === 0
        && serverQueue.radioQueue.length === 0 && !serverQueue.is247) {
        await MusicPlayer.clearQueueAndLeave(guild.id, 'voice-command-cancelled', { notify: false });
      }
      return {
        ok: false,
        reason: 'stale',
        operationId,
        serverQueue,
        addedSongs: [],
        shouldStartPlayback: false,
        startedPlayback: false,
      };
    }

    if (shouldStartPlayback && !serverQueue.backendUnavailable) {
      try {
        const currentBotChannelId = guild.members.me?.voice?.channelId
          || serverQueue.voiceChannelId
          || serverQueue.connection?.joinConfig?.channelId;
        if (currentBotChannelId && currentBotChannelId !== voiceChannel.id) {
          MusicPlayer.removeQueueItemsById(serverQueue, queuedSongs.map(song => song.queueItemId));
          throw new Error('你需要和我在同一个语音频道');
        }
        const result = await MusicPlayer.playSong(guild.id, textChannel || serverQueue.textChannel, null, null, operationOptions);
        if (result?.reason === 'backend-unavailable') {
          return {
            ok: true,
            reason: 'backend-unavailable',
            operationId,
            serverQueue,
            addedSongs,
            addedItemIds: addedSongs.map(song => song.queueItemId),
            shouldStartPlayback: true,
            startedPlayback: false,
            backendUnavailable: true,
          };
        }
        timingLog(startedAt, 'playSong completed');
      } catch (error) {
        MusicPlayer.removeQueueItemsById(serverQueue, queuedSongs.map(song => song.queueItemId));
        throw error;
      } finally {
        if (serverQueue.startReservation === operationId) serverQueue.startReservation = null;
      }
    }

    const startedPlayback = shouldStartPlayback && !serverQueue.backendUnavailable
      ? (waitForStart
        ? await MusicPlayer.waitForPlaybackStart(guild.id, addedSongs[0])
        : MusicPlayer.isPlaybackActuallyActive(serverQueue))
      : false;

    return {
      ok: true,
      operationId,
      serverQueue,
      addedSongs,
      addedItemIds: addedSongs.map(song => song.queueItemId),
      shouldStartPlayback,
      startedPlayback,
    };
  });
}

export async function addSongsToPlayback(interaction, songs, { editReply = true, respond = true, successNote = '' } = {}) {
  const startedAt = PLAY_TIMING ? Date.now() : null;
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    const message = '❌ 你需要先加入语音频道！';
    return editReply ? interaction.editReply(message) : interaction.reply({ content: message, flags: 64 });
  }
  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions?.has?.('ViewChannel') || !permissions.has('Connect') || !permissions.has('Speak')) {
    const message = '❌ 我没有权限加入或在该语音频道说话！';
    return editReply ? interaction.editReply(message) : interaction.reply({ content: message, flags: 64 });
  }

  const playback = await enqueueSongs({
    guild: interaction.guild,
    voiceChannel,
    textChannel: interaction.channel,
    requester: interaction.user,
    songs,
    waitForStart: true,
  });

  if (!playback.ok) {
    const message = playback.reason === 'queue-full'
      ? `❌ 队列已满（上限 ${playback.maxQueueSize} 首），本次 ${playback.requestedCount} 首歌曲均未加入；当前还可加入 ${playback.capacity} 首。`
      : '❌ 歌曲未能加入播放队列。';
    return editReply ? interaction.editReply({ content: message, allowedMentions: { parse: [] } })
      : interaction.reply({ content: message, flags: 64, allowedMentions: { parse: [] } });
  }

  const { serverQueue, addedSongs, shouldStartPlayback, startedPlayback } = playback;

  const currentSong = serverQueue.currentSong || addedSongs[0];
  const response = serverQueue.notificationMode === 'private' ? {
    content: addedSongs.length === 1
      ? (shouldStartPlayback ? (startedPlayback ? '🎵 已添加并开始播放。' : '⚠️ 已添加，但播放器尚未确认起播。') : '📝 已添加到队列。')
      : (shouldStartPlayback ? (startedPlayback ? `🎵 已添加 ${addedSongs.length} 首歌并开始播放。` : `⚠️ 已添加 ${addedSongs.length} 首歌，但播放器尚未确认起播。`) : `📝 已添加 ${addedSongs.length} 首歌到队列。`),
    ...buildNowPlayingPayload(serverQueue, currentSong),
    allowedMentions: { parse: [] },
  } : {
    content: addedSongs.length === 1
      ? (shouldStartPlayback ? (startedPlayback ? '🎵 已添加并开始播放。' : '⚠️ 已添加，但播放器尚未确认起播。') : '📝 已添加到队列。')
      : (shouldStartPlayback ? (startedPlayback ? `🎵 已添加 ${addedSongs.length} 首歌并开始播放。` : `⚠️ 已添加 ${addedSongs.length} 首歌，但播放器尚未确认起播。`) : `📝 已添加 ${addedSongs.length} 首歌到队列。`),
    allowedMentions: { parse: [] },
  };
  if (successNote) response.content += `\n${successNote}`;
  if (!respond) {
    // The caller already acknowledged the interaction.
  } else if (editReply) {
    await interaction.editReply(response);
  } else if (interaction.replied || interaction.deferred) {
    await interaction.editReply(response);
  } else {
    await interaction.reply(response);
  }
  timingLog(startedAt, 'playback response sent');

}
