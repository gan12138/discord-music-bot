import { Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { freezePlaybackProgress, savePlaybackState } from '../utils/playbackState.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { canRestoreVoiceChannel, isManualPlaybackPaused, releaseRestoredVoiceConnection } from './ready.js';

export const name = Events.VoiceStateUpdate;
export const once = false;
const BOT_DISCONNECT_RECOVERY_DELAY_MS = 3_000;

export async function execute(oldState, newState) {
  const guildId = newState.guild.id;
  const serverQueue = musicQueue.peek(guildId);
  if (!serverQueue) return;
  // Observe suppression when the event arrives, not after a backend transition
  // releases its lock (when the synthetic disconnect flag may be cleared).
  if (oldState.member?.id === newState.guild.members.me?.id && oldState.channelId && !newState.channelId
    && (serverQueue.backendTransitioning || Date.now() < (serverQueue.suppressVoiceRecoveryUntil || 0))) return;
  const generation = serverQueue.lifecycleGeneration;
  const isCurrent = () => musicQueue.peek(guildId) === serverQueue
    && serverQueue.lifecycleGeneration === generation
    && !serverQueue.disposed && !serverQueue.clearingQueue;

  // Restore awaits join/output, so it must run outside the guild lock (that is
  // what wedged /play). Decide with the same checks the in-lock path used, so
  // invalid cases (moved bot, revoked permissions, left humans) still fail.
  const restoreCandidate = !serverQueue.connection && serverQueue.pausedByEmptyChannel
    && serverQueue.voiceChannelId && oldState.channelId !== newState.channelId
    && newState.channelId === serverQueue.voiceChannelId
    && newState.member && !newState.member.user?.bot
    && !(oldState.member?.id === newState.guild.members.me?.id);
  if (restoreCandidate) {
    return restoreWhenHumansReturn(oldState, newState, serverQueue).catch(error => {
      console.error('[VoiceState] restore failed:', error.message);
    });
  }

  return MusicPlayer.runTransition(guildId, async () => {
    if (!isCurrent()) return;
    return handleVoiceStateUpdate(oldState, newState, serverQueue);
  }, { createQueue: false }).catch(error => {
    console.error('[VoiceState] transition failed:', error.message);
  });
}

export async function restoreWhenHumansReturn(oldState, newState, serverQueue = musicQueue.peek(newState.guild.id)) {
  const guild = newState.guild;
  const guildId = guild.id;
  if (!serverQueue) return false;
  const generation = serverQueue.lifecycleGeneration;
  const targetChannelId = serverQueue.voiceChannelId;
  const isCurrent = () => musicQueue.peek(guildId) === serverQueue
    && serverQueue.lifecycleGeneration === generation && !serverQueue.disposed && !serverQueue.clearingQueue
    && serverQueue.voiceChannelId === targetChannelId;

  // Decide inside the lock using cached state only, then fetch/join/wait for
  // output outside it: those awaits may take seconds and must never block
  // /play for this guild. Claiming the slot here makes concurrent voice events
  // single-flight, so two events cannot each join a connection.
  const decide = () => {
    const reasons = {
      notCurrent: !isCurrent(),
      alreadyRestoring: Boolean(serverQueue.restoreInFlight),
      hasConnection: Boolean(serverQueue.connection),
      notDeferred: !serverQueue.pausedByEmptyChannel,
      noTarget: !targetChannelId,
      sameChannel: oldState.channelId === newState.channelId,
      wrongChannel: newState.channelId !== targetChannelId,
      noMember: !newState.member,
      botMember: Boolean(newState.member?.user?.bot),
    };
    if (Object.values(reasons).some(Boolean)) {
      if (process.env.VOICE_DEBUG === '1') console.error('[VoiceState] restore rejected', JSON.stringify(reasons));
      return null;
    }
    serverQueue.guildRef = guild;
    const claim = Symbol('voice-restore');
    serverQueue.restoreInFlight = claim;
    return { claim, cachedChannel: guild.channels.cache.get(targetChannelId) || null };
  };

  const finish = async connection => {
    // Release only our own claim; a newer restore may already own the slot.
    await MusicPlayer.runTransition(guildId, async () => {
      if (serverQueue.restoreInFlight === claim) serverQueue.restoreInFlight = null;
      return true;
    }, { createQueue: false });
    if (connection) await releaseRestoredVoiceConnection(serverQueue, connection);
  };
  // Reuse the caller's transition when the event handler already holds the
  // guild lock; re-entering would deadlock.
  const target = MusicPlayer.inTransition(guildId)
    ? decide()
    : await MusicPlayer.runTransition(guildId, async () => decide(), { createQueue: false });

  if (!target) { if (process.env.VOICE_DEBUG === '1') console.error('[restore] no-target'); return false; }
  const { claim } = target;

  const voiceChannel = target.cachedChannel
    || await guild.channels.fetch(targetChannelId).catch(() => null);
  const why = {
    notCurrent: !isCurrent(),
    cannotRestore: !canRestoreVoiceChannel(guild, serverQueue, voiceChannel, { requireHumans: true }),
    paused: isManualPlaybackPaused(serverQueue),
    noChannel: !voiceChannel,
  };
  if (why.notCurrent || why.cannotRestore || why.paused || why.noChannel) {
    if (process.env.VOICE_DEBUG === '1') console.error('[restore] target-invalid', JSON.stringify(why));
    await finish();
    return false;
  }
  if (!serverQueue.currentSong && serverQueue.songs.length === 0
    && serverQueue.radioQueue.length === 0 && !serverQueue.radio?.enabled) {
    await finish();
    return false;
  }

  const validTarget = () => isCurrent()
    && canRestoreVoiceChannel(guild, serverQueue, voiceChannel, { requireHumans: true })
    && !isManualPlaybackPaused(serverQueue);

  let connection;
  try {
    connection = await MusicPlayer.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator);
  } catch (error) {
    console.error('[VoiceState] restore join failed:', error.message);
    await finish();
    return false;
  }
  if (!validTarget()) {
    await finish(connection);
    return false;
  }

  const commit = async () => {
    const existing = serverQueue.connection;
    if (!validTarget()) return false;
    if (existing && existing !== connection && existing.state?.status !== 'destroyed') return true;
    serverQueue.voiceChannelRef = voiceChannel;
    serverQueue.connection = connection;
    serverQueue.pausedByEmptyChannel = false;
    MusicPlayer.clearIdleLeaveTimer(serverQueue);
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return true;
  };
  const committed = await MusicPlayer.runTransition(guildId, async () => {
    // Another restore may have won the slot while we awaited the join.
    if (serverQueue.restoreInFlight !== claim) return false;
    return commit();
  }, { createQueue: false });
  if (!committed) {
    await finish(connection);
    return false;
  }
  if (serverQueue.restoreInFlight === claim) serverQueue.restoreInFlight = null;

  if (serverQueue.currentSong) {
    await MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned', { force: true });
    if (isCurrent()) await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue);
  } else {
    await MusicPlayer.playSong(guildId, serverQueue.textChannel || null);
  }
  return true;
}

async function handleVoiceStateUpdate(oldState, newState, serverQueue) {
  const guildId = newState.guild.id;
  const botMember = newState.guild.members.me;
  if (!botMember) return;

  const isBotVoiceUpdate = oldState.member?.id === botMember.id;

  // Bot 被踢出语音频道
  if (isBotVoiceUpdate && oldState.channelId && !newState.channelId) {
    if (serverQueue.backendTransitioning || Date.now() < (serverQueue.suppressVoiceRecoveryUntil || 0)) return;
    if (serverQueue.is247) {
      const backend = MusicPlayer.activeBackend(serverQueue);
      if (serverQueue.currentSong) freezePlaybackProgress(serverQueue);
      serverQueue.connection = null;
      serverQueue.player = null;
      serverQueue.playing = false;
      serverQueue.advancing = false;
      serverQueue.audioResource = null;
      serverQueue.activeBackend = backend;
      if (backend === 'lavalink') {
        serverQueue.backendUnavailable = true;
        serverQueue.playbackBlocked = true;
        serverQueue.lavalinkInterrupted = true;
      }
      serverQueue.pendingRecovery = {
        guildId,
        playbackId: serverQueue.playbackId,
        songId: serverQueue.currentSong?.queueItemId || null,
        reason: 'Bot 离开语音频道',
        at: Date.now(),
      };
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + BOT_DISCONNECT_RECOVERY_DELAY_MS;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      setTimeout(() => {
        const queue = musicQueue.peek(guildId);
        if (queue !== serverQueue || !queue.is247 || queue.connection) return;
        MusicPlayer.recoverVoiceConnection(guildId, 'bot-disconnected').catch(error => {
          console.error('[VoiceState] 24/7 reconnect failed:', MusicPlayer.safeErrorMessage(error));
        });
      }, BOT_DISCONNECT_RECOVERY_DELAY_MS).unref?.();
      return;
    }

    MusicPlayer.clearQueueAndLeave(guildId, 'bot-disconnected', { notify: false }).catch(error => {
      console.error('[VoiceState] failed to clear queue after bot disconnect:', error.message);
    });
    return;
  }

  // Bot 被手动移动到其他语音频道：管理员操作优先，更新 24/7 目标频道但不强制回原频道。
  if (isBotVoiceUpdate && oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    if (serverQueue.is247) {
      serverQueue.voiceChannelId = newState.channelId;
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + 15_000;
      savePlaybackState(guildId, serverQueue, { immediate: true });
    }
    return;
  }

  // Backend switches suppress only the Bot's own synthetic voice events. Human
  // joins/leaves must still update idle/24/7 state during a backend switch.
  if (isBotVoiceUpdate) return;

  if (!serverQueue.connection) return;

  const botChannel = botMember.voice.channel;
  if (!botChannel || (oldState.channelId !== botChannel.id && newState.channelId !== botChannel.id)) return;

  const humanCount = botChannel.members.filter(m => !m.user.bot).size;

  // 24/7 空频道让当前歌曲播完，但阻止后续队列和 Radio 推进。
  if (humanCount === 0) {
    if (serverQueue.is247) {
      if (!serverQueue.pausedByEmptyChannel) {
        serverQueue.pausedByEmptyChannel = true;
        savePlaybackState(guildId, serverQueue);
      }
    } else {
      MusicPlayer.scheduleIdleLeave(guildId, 'empty-channel');
    }
    return;
  }

  // 有人回来：只恢复原定频道，权限/目标变化不能触发自动播放。
  if (!canRestoreVoiceChannel(newState.guild, serverQueue, botChannel, { requireHumans: true })) return;
  if (!serverQueue.is247) MusicPlayer.markActivity(guildId);

  if (serverQueue.pausedByEmptyChannel) {
    serverQueue.pausedByEmptyChannel = false;
    savePlaybackState(guildId, serverQueue);

    if (!isManualPlaybackPaused(serverQueue) && !MusicPlayer.isPlaybackActuallyActive(serverQueue) && serverQueue.connection) {
      if (serverQueue.currentSong) {
        await MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned', { force: true });
        if (musicQueue.peek(guildId) === serverQueue && !serverQueue.disposed) {
          await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue);
        }
      } else if (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled) {
        await MusicPlayer.playSong(guildId, serverQueue.textChannel);
      }
      return;
    }
  }

  if (!isManualPlaybackPaused(serverQueue) && serverQueue.currentSong && serverQueue.playing) {
    await MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned');
    if (musicQueue.peek(guildId) === serverQueue && !serverQueue.disposed) {
      await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue);
    }
  }
}
