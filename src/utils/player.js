import { createAudioPlayer, createAudioResource, AudioPlayerStatus, joinVoiceChannel, VoiceConnectionStatus, entersState, StreamType, NoSubscriberBehavior } from '@discordjs/voice';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { PassThrough } from 'stream';
import { resolveFfmpegPath } from './ffmpeg.js';
import { ensureRadioQueue, invalidateRadioGeneration, maybeApplyAutodetect, findRadioAlternatives } from './radio.js';
import { classifyPlaybackError, playbackErrorText, withPlaybackSignal } from './playbackErrors.js';
import { playbackAvailability } from './playbackAvailability.js';
import { buildAudioFilter, normalizeFilterMode } from './filters.js';
import { Bilibili } from './bilibili.js';
import { GuildSettings } from '../models/database.js';
import {
  applyLavalinkFilter,
  createOrGetLavalinkPlayer,
  destroyLavalinkPlayer,
  getLavalinkPlayer,
  isLavalinkEnabled,
  isLavalinkSupportedUrl,
  isLavalinkPlayerReady,
  lavalinkConnectionShim,
  NoLavalinkNodeError,
} from './lavalink.js';
import { ensurePanelRevision, publishNowPlaying } from './playerPanel.js';
import { BILIBILI_USER_AGENT, cookieArgs } from './shared.js';
import {
  deletePlaybackState,
  freezePlaybackProgress,
  getPlaybackProgressSeconds,
  getPlaybackResumeSeconds,
  getMaxQueueSize,
  markPlaybackPaused,
  markPlaybackResumed,
  markPlaybackStarted,
  savePlaybackState,
} from './playbackState.js';

const VOICE_DEBUG = process.env.VOICE_DEBUG === '1';
const PLAYER_DEBUG = process.env.PLAYER_DEBUG === '1';
const PLAY_TIMING = process.env.PLAY_TIMING === '1';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LAVALINK_CONSECUTIVE_FAILURES = 3;
const RETRY_BACKOFF_MS = 1500;
const RETRY_REWIND_SECONDS = 3;
const PLAYBACK_RECOVERY_TIMEOUT_MS = Math.max(10_000, Math.min(120_000, Number(process.env.PLAYBACK_RECOVERY_TIMEOUT_MS) || 45_000));
const LAVALINK_TRACK_RETRY_DELAY_MS = Math.max(0, Math.min(5000, Number(process.env.LAVALINK_TRACK_RETRY_DELAY_MS ?? 1000) || 0));
const LAVALINK_TRACK_RETRY_TIMEOUT_MS = Math.max(3000, Math.min(30_000, Number(process.env.LAVALINK_TRACK_RETRY_TIMEOUT_MS) || 8000));
const LOCAL_FALLBACK_RESERVE_MS = Math.max(5000, Math.min(60_000, Number(process.env.LOCAL_FALLBACK_RESERVE_MS) || 15_000));
const MIN_LAVALINK_RETRY_MS = 3000;
const PLAYBACK_STABLE_MS = 30_000;
const RADIO_GENERATION_WAIT_MS = 15_000;
const AUDIO_BUFFER_MB = Number(process.env.AUDIO_BUFFER_MB) || 8;
const AUDIO_STREAM_BUFFER_BYTES = AUDIO_BUFFER_MB * 1024 * 1024;
const AUDIO_PREBUFFER_BYTES = 256 * 1024;
const AUDIO_PREBUFFER_TIMEOUT_MS = Number(process.env.AUDIO_PREBUFFER_MS ?? 1500);
const STALL_WATCHDOG_MS = 15_000; // 15 秒无播放活动则强制推进队列
const LOCAL_START_TIMEOUT_MS = Math.max(5_000, Number(process.env.LOCAL_START_TIMEOUT_MS) || 15_000);
// 本地播放断流检测：播放中持续 LOCAL_STREAM_STALL_MS 无音频数据则判定平台限速/断流
const LOCAL_STREAM_STALL_MS = Math.max(5_000, Number(process.env.LOCAL_STREAM_STALL_MS) || 20_000);
const LOCAL_STREAM_STALL_CHECK_MS = 5_000;
const CHILD_PROCESS_KILL_GRACE_MS = 2_000;
const LAVALINK_FINISH_CONFIRM_MS = 1_500;
const VOICE_RECOVERY_MAX_BACKOFF_MS = 60_000;
const VOICE_TRANSITION_SETTLE_MS = 3_000;
const MAX_TIMER_MS = 2_147_000_000;
const VOICE_JOIN_BLOCKED_CODE = 'VOICE_JOIN_BLOCKED';
const DISCORD_CONTENT_MAX_LENGTH = 2000;
const guildOperationContext = new AsyncLocalStorage();

function debugLog(...args) {
  if (PLAYER_DEBUG) console.log(...args);
}

function timingLog(startedAt, step) {
  if (PLAY_TIMING && startedAt) console.log(`[play timing] ${step}: ${Date.now() - startedAt}ms`);
}

function hasHumanListener(serverQueue) {
  const voiceChannel = serverQueue?.voiceChannelRef?.id === serverQueue?.voiceChannelId
    ? serverQueue.voiceChannelRef
    : serverQueue?.guildRef?.channels?.cache?.get(serverQueue?.voiceChannelId);
  if (!voiceChannel?.members) return true;
  return voiceChannel.members.some(member => !member.user.bot);
}

function sendPlaybackNotice(serverQueue, channel, payload) {
  if (!hasHumanListener(serverQueue)) return Promise.resolve(null);
  return sendToChannel(channel, payload);
}

function sendToChannel(channel, payload) {
  if (!channel?.send) return Promise.resolve(null);
  const safePayload = typeof payload === 'string'
    ? { content: discordContent(payload), allowedMentions: { parse: [] } }
    : {
      ...payload,
      ...(payload?.content ? { content: discordContent(payload.content) } : {}),
      allowedMentions: {
        ...(payload?.allowedMentions || {}),
        parse: [],
      },
    };
  return Promise.resolve(channel.send(safePayload)).catch(error => {
    console.warn('[Discord] failed to send message:', safeErrorMessage(error));
  });
}

function safeErrorMessage(error, fallback = '未知错误') {
  let message = error?.message || error || fallback;
  message = String(message);
  const secrets = [
    process.env.DISCORD_TOKEN,
    process.env.LAVALINK_PASSWORD,
    process.env.VOICE_LISTENER_TOKEN,
  ].filter(value => typeof value === 'string' && value.length > 0);
  for (const secret of new Set(secrets)) message = message.split(secret).join('[redacted]');
  return message
    .replace(/(authorization|password|passwd|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/(?:cookies?|cookie-file|YTDLP_COOKIE_FILES)[^\n]*/gi, 'cookie configuration redacted');
}

function discordContent(value) {
  const content = safeErrorMessage(value);
  if (content.length <= DISCORD_CONTENT_MAX_LENGTH) return content;
  return `${content.slice(0, DISCORD_CONTENT_MAX_LENGTH - 3)}...`;
}

function isLavalinkInfrastructureError(error) {
  if (error instanceof NoLavalinkNodeError) return true;
  if (error?.code === 'NO_LAVALINK_NODE' || error?.category === 'NO_LAVALINK_NODE') return true;
  const message = safeErrorMessage(error);
  return /no available node|no lavalink node|node (?:is )?(?:not )?(?:connected|ready|available)|lavalink.*(?:not ready|unavailable|disconnected)/i.test(message);
}

function isLavalinkVoiceStateError(error) {
  if (!isLavalinkInfrastructureError(error)) return false;
  return /player did not receive connected Discord voice data|player voice state is not ready/i.test(safeErrorMessage(error));
}

function communicationDisabledUntil(member) {
  const timestamp = Number(
    member?.communicationDisabledUntilTimestamp
    || member?.communicationDisabledUntil?.getTime?.()
    || 0,
  );
  return timestamp > Date.now() ? timestamp : 0;
}

function voiceJoinBlockedError(member) {
  const retryAt = communicationDisabledUntil(member);
  if (!retryAt) return null;
  const error = new Error(`机器人当前被服务器超时禁言至 ${new Date(retryAt).toISOString()}，无法加入语音频道`);
  error.code = VOICE_JOIN_BLOCKED_CODE;
  error.retryAt = retryAt;
  return error;
}

function queueItemId(song = null) {
  return song?.queueItemId || song?.itemId || randomUUID();
}

function operationId(prefix = 'playback') {
  return `${prefix}:${randomUUID()}`;
}

function ensureQueueItemId(song, operation = null) {
  if (!song || typeof song !== 'object') return song;
  if (!song.queueItemId) song.queueItemId = queueItemId(song);
  if (operation && !song.enqueueOperationId) song.enqueueOperationId = operation;
  return song;
}

function describePlaybackErrorForUser(errorInfo) {
  if (!errorInfo?.message) return '播放流中断，可能是网络波动或音源临时不可用';
  const message = String(errorInfo.message).replace(/^\[[^\]]+\]\s*/, '');
  const signalMatch = /signal\s+(SIG[A-Z0-9]+)/i.exec(message);
  if (signalMatch) {
    return `本地转码进程崩溃 (${signalMatch[1]})，请稍后重试或换一个音源`;
  }
  return playbackErrorText(errorInfo.category ? errorInfo : message, errorInfo.source);
}

function summarizeProcessOutput(output = '') {
  const text = safeErrorMessage(String(output).trim().replace(/\s+/g, ' '));
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPlayableSongUrl(url) {
  const text = String(url || '');
  return (
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]{11}/.test(text) ||
    /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[a-zA-Z0-9]+|av\d+)/i.test(text) ||
    /^https?:\/\/b23\.tv\/[a-zA-Z0-9]+/i.test(text)
  );
}

function isBilibiliSongUrl(url) {
  const text = String(url || '');
  return (
    /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[a-zA-Z0-9]+|av\d+)/i.test(text) ||
    /^https?:\/\/b23\.tv\/[a-zA-Z0-9]+/i.test(text)
  );
}

function isYouTubeSongUrl(url) {
  return /^(?:https?:\/\/)?(?:(?:www\.|m\.)?youtube\.com\/watch\?[^#\s]*\bv=|youtu\.be\/)[a-zA-Z0-9_-]{11}/i.test(String(url || ''));
}

function freshAudioUrl(song) {
  if (!song?.audioUrl) return null;
  const expiresAt = Number(song.audioUrlExpiresAt) || 0;
  return expiresAt > Date.now() + 30_000 ? song.audioUrl : null;
}

function ytdlpHeaderArgs(url) {
  return isBilibiliSongUrl(url)
    ? ['--referer', 'https://www.bilibili.com', '--user-agent', BILIBILI_USER_AGENT]
    : [];
}

class MusicQueue {
  constructor() {
    this.queue = new Map();
  }

  get(guildId) {
    if (!this.queue.has(guildId)) {
      const settings = GuildSettings.get(guildId);
      this.queue.set(guildId, {
        guildId,
        songs: [],
        radioQueue: [],
        currentSong: null,
        history: [],
        player: null,
        activeBackend: null,
         connection: null,
         disposed: false,
         volume: settings.defaultVolume,
        transientVolume: null,
        volumeOperation: Promise.resolve(),
        loop: 'off',
        textChannel: null,
        playing: false,
        ffmpegProcess: null,
        ytdlpProcess: null,
        audioResource: null,
        playbackError: false,
        lastPlaybackError: null,
        playbackRetryCount: 0,
        playbackRecovery: null,
        playbackAttemptController: null,
        playbackDeadlineTimer: null,
        playbackAttemptDeadline: null,
        playbackAttemptStartedAt: null,
        playbackStableTimer: null,
        pendingPlaybackRecovery: null,
        streamDiagnostics: null,
        lavalinkFailureCount: 0,
        lavalinkStarting: false,
        lavalinkStartKey: null,
        lavalinkLastStart: null,
         radioFailureCount: 0,
        suppressRadioUntilManualPlay: false,
        suppressRadioUntilManualQueueEnds: false,
        advancing: false,
        playbackGeneration: 0,
        playbackId: 0,
        terminalHandledPlaybackId: null,
         lavalinkConfirmedPlaybackId: null,
         lavalinkStartTimer: null,
         lavalinkFinishTimer: null,
         lavalinkPendingFinish: null,
         lavalinkInterrupted: false,
        skipRequested: false,
         reconnectingVoice: false,
         voiceReconnectAttempts: 0,
         voiceRecoveryNotified: false,
        seekOffsetSeconds: 0,
        startedAt: null,
        pausedAt: null,
        pausedByEmptyChannel: false,
        is247: false,
         voiceChannelId: null,
         guildRef: null,
         voiceChannelRef: null,
         textChannelId: null,
        filters: { active: 'none' },
         versionPreference: settings.versionPreference,
         notificationMode: settings.notificationMode,
        nowPlayingMessageId: null,
        nowPlayingChannelId: null,
         idleLeaveTimer: null,
         idleReason: null,
         queueEnded: false,
         clearingQueue: false,
         lifecycleGeneration: randomUUID(),
         transitionTail: Promise.resolve(),
         transitionSequence: 0,
         backendTransitioning: false,
         startingBackend: null,
         backendUnavailable: false,
         playbackBlocked: false,
         pendingRecovery: null,
          recoveryTimer: null,
          recoveryAttempts: 0,
          voiceRecoveryTimer: null,
         localStartTimer: null,
         forceLocal: false,
         forceYtdlpPipe: false,
          localFallbackTried: false,
          lavalinkVoiceFallback: false,
          suppressVoiceRecoveryUntil: 0,
          radio: {
          enabled: false,
          autodetect: false,
          currentStyle: {},
          pendingStyle: null,
          seedSong: null,
          isGenerating: false,
          lastGeneratedAt: null,
         },
         panelRevision: 0,
         panelRevisionKey: null,
         panelPlaybackToken: null,
         panelPublishSequence: 0,
         panelPublishTail: Promise.resolve(),
          advanceSignal: 0,
          playbackLifecycleGeneration: 0,
       });
    }
    return this.queue.get(guildId);
  }

  peek(guildId) {
    return this.queue.get(guildId) || null;
  }

  has(guildId) {
    return this.queue.has(guildId);
  }

  delete(guildId) {
    this.queue.delete(guildId);
  }

  entries() {
    return this.queue.entries();
  }

  values() {
    return this.queue.values();
  }
}

export const musicQueue = new MusicQueue();

const advanceWaiters = new Map();
const stallTimers = new Map();

export class MusicPlayer {
  static isLavalinkInfrastructureError(error) {
    return isLavalinkInfrastructureError(error);
  }

  static safeErrorMessage(error, fallback = '未知错误') {
    return safeErrorMessage(error, fallback);
  }

  static runTransition(guildId, operation, { createQueue = true } = {}) {
    const context = guildOperationContext.getStore();
    if (context?.guildId === guildId && context.active) return Promise.resolve().then(operation);

    const serverQueue = createQueue ? musicQueue.get(guildId) : musicQueue.peek(guildId);
    if (!serverQueue) return Promise.resolve().then(operation);

    const sequence = (Number(serverQueue.transitionSequence) || 0) + 1;
    serverQueue.transitionSequence = sequence;
    const scope = { guildId, sequence, queue: serverQueue, active: false };
    const run = Promise.resolve(serverQueue.transitionTail)
      .catch(() => {})
      .then(() => guildOperationContext.run(scope, async () => {
        scope.active = true;
        try {
          return await operation();
        } finally {
          // Detached async work inherits the scope but must acquire a fresh
          // slot after its owning operation finishes.
          scope.active = false;
        }
      }));
    // Only completion releases the slot. A timeout cannot cancel arbitrary
    // mutation, so force-releasing here would break guild mutual exclusion.
    serverQueue.transitionTail = run.catch(() => {});
    return run;
  }

  static inTransition(guildId) {
    const context = guildOperationContext.getStore();
    return context?.guildId === guildId && context.active;
  }

  // Recheck after acquiring the guild lock, not only before queueing work.
  static operationIsValid({ signal, validateOperation } = {}) {
    return !signal?.aborted && (!validateOperation || validateOperation() === true);
  }

  static bindStartupCancellation(serverQueue, playbackId, { signal } = {}) {
    if (!signal) return () => {};
    const abort = () => {
      if (this.isCurrentPlayback(serverQueue, playbackId)) {
        serverQueue.playbackAttemptController?.abort(signal.reason);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // The command owns startup only. Finishing a command must not cancel the
    // successfully started song when its command controller is disposed.
    return () => signal.removeEventListener('abort', abort);
  }

  static preservePausedPlayback(guildId, serverQueue) {
    const playbackId = serverQueue.playbackId;
    const player = serverQueue.player;
    if (!player || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
    // Already paused (resource rebuild kept the state): nothing to do.
    if (player.state.status === AudioPlayerStatus.Paused) {
      markPlaybackPaused(serverQueue);
      this.setSongPausedState(serverQueue, true);
      serverQueue.playing = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    this.applyPauseWhenPlaying(player, serverQueue, guildId, playbackId);
    return true;
  }

  // A paused song rebuilt through seek/filter must not start playing just
  // because the new resource arrived later than the prebuffer window.
  // @discordjs/voice only accepts pause() while Playing, so hold the pause
  // intent until the player reports Playing, then apply it exactly once.
  static applyPauseWhenPlaying(localPlayer, serverQueue, guildId, playbackId) {
    if (!localPlayer?.on) return false;
    const tryPause = () => {
      if (!this.isCurrentPlayback(serverQueue, playbackId)) {
        localPlayer.off('stateChange', onState);
        return false;
      }
      if (localPlayer.state.status !== AudioPlayerStatus.Playing) return false;
      localPlayer.off('stateChange', onState);
      if (localPlayer.pause(true) === false) return false;
      markPlaybackPaused(serverQueue);
      this.setSongPausedState(serverQueue, true);
      serverQueue.playing = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    };
    const onState = (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing) tryPause();
    };
    localPlayer.on('stateChange', onState);
    return tryPause();
  }

  static queueItemId(song = null) {
    return queueItemId(song);
  }

  static operationId(prefix = 'playback') {
    return operationId(prefix);
  }

  static ensureQueueItemId(song, operation = null) {
    return ensureQueueItemId(song, operation);
  }

  static setSongPausedState(serverQueue, paused) {
    if (serverQueue?.currentSong) serverQueue.currentSong.playbackPaused = Boolean(paused);
    const session = serverQueue?.playbackRecovery;
    if (!session) return;
    if (paused && !session.pausedAt) {
      session.pausedAt = Date.now();
      if (serverQueue.playbackDeadlineTimer) {
        session.pausedDeadlineRemaining = Math.max(1, (serverQueue.playbackAttemptDeadline ?? session.deadline) - Date.now());
        clearTimeout(serverQueue.playbackDeadlineTimer);
        serverQueue.playbackDeadlineTimer = null;
      }
    } else if (!paused && session.pausedAt) {
      const pauseMs = Date.now() - session.pausedAt;
      session.deadline += pauseMs;
      if (serverQueue.playbackAttemptDeadline != null) serverQueue.playbackAttemptDeadline += pauseMs;
      session.pausedAt = null;
      if (session.pausedDeadlineRemaining && serverQueue.playbackDeadlineExpire) {
        serverQueue.playbackDeadlineTimer = setTimeout(serverQueue.playbackDeadlineExpire, session.pausedDeadlineRemaining);
        serverQueue.playbackDeadlineTimer.unref?.();
        session.pausedDeadlineRemaining = null;
      }
    }
  }

  static removeQueueItemsById(serverQueue, itemIds = []) {
    const ids = new Set(itemIds.filter(Boolean));
    if (!ids.size) return 0;
    const before = serverQueue.songs.length + serverQueue.radioQueue.length;
    serverQueue.songs = serverQueue.songs.filter(song => !ids.has(song?.queueItemId));
    serverQueue.radioQueue = serverQueue.radioQueue.filter(song => !ids.has(song?.queueItemId));
    return before - serverQueue.songs.length - serverQueue.radioQueue.length;
  }

  static addQueueItems(serverQueue, songs = [], operation = null) {
    const capacity = Math.max(0, getMaxQueueSize() - serverQueue.songs.length);
    const accepted = songs.slice(0, capacity);
    for (const song of accepted) ensureQueueItemId(song, operation);
    serverQueue.songs.push(...accepted);
    return accepted;
  }

  static enforceQueueLimits(serverQueue) {
    const limit = getMaxQueueSize();
    if (serverQueue.songs.length > limit) serverQueue.songs.splice(limit);
    if (serverQueue.radioQueue.length > limit) serverQueue.radioQueue.splice(limit);
    return serverQueue;
  }

  static effectiveVolume(serverQueue) {
    const transient = Number(serverQueue?.transientVolume?.volume);
    if (Number.isFinite(transient)) return Math.max(0, transient);
    return Math.max(0, Number(serverQueue?.volume) || 0);
  }

  static queueVolumeOperation(serverQueue, operation) {
    serverQueue.volumeOperation = Promise.resolve(serverQueue.volumeOperation)
      .catch(() => {})
      .then(operation);
    return serverQueue.volumeOperation;
  }

  static async applyOutputVolume(guildId, serverQueue) {
    const volume = this.effectiveVolume(serverQueue);
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player) return false;
      await player.setVolume(volume, true);
      if (!serverQueue.transientVolume) serverQueue.pendingVolumeRestore = false;
      return true;
    }
    if (!serverQueue.audioResource?.volume) return false;
    serverQueue.audioResource.volume.setVolume(volume / 100);
    if (!serverQueue.transientVolume) serverQueue.pendingVolumeRestore = false;
    return true;
  }

  static scheduleVolumeRestore(guildId, serverQueue) {
    if (serverQueue.volumeRestoreTimer || !serverQueue.pendingVolumeRestore) return;
    const timer = setTimeout(async () => {
      serverQueue.volumeRestoreTimer = null;
      if (musicQueue.peek(guildId) !== serverQueue || !serverQueue.pendingVolumeRestore || serverQueue.transientVolume) return;
      if (!serverQueue.currentSong) {
        serverQueue.pendingVolumeRestore = false;
        return;
      }
      try {
        const restored = await this.queueVolumeOperation(serverQueue, () => this.applyOutputVolume(guildId, serverQueue));
        if (!restored) this.scheduleVolumeRestore(guildId, serverQueue);
      } catch {
        this.scheduleVolumeRestore(guildId, serverQueue);
      }
    }, 5_000);
    timer.unref?.();
    serverQueue.volumeRestoreTimer = timer;
  }

  static shouldUseLavalink(song = null) {
    if (!isLavalinkEnabled()) return false;
    if (!song) return true;
    if (isBilibiliSongUrl(song.url)) return true;
    return isLavalinkSupportedUrl(song.url || song.audioUrl);
  }

  static shouldFallbackLavalinkToLocal(song, localFallbackTried = false) {
    return Boolean(
      song?.url
      && !localFallbackTried
      && (isYouTubeSongUrl(song.url) || isBilibiliSongUrl(song.url)),
    );
  }

  static cancelPlaybackWork(serverQueue) {
    if (!serverQueue) return;
    clearTimeout(serverQueue.playbackDeadlineTimer);
    clearTimeout(serverQueue.playbackStableTimer);
    const pending = serverQueue.pendingPlaybackRecovery;
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    serverQueue.pendingPlaybackRecovery = null;
    serverQueue.playbackDeadlineTimer = null;
    serverQueue.playbackAttemptDeadline = null;
    serverQueue.playbackAttemptStartedAt = null;
    serverQueue.playbackDeadlineExpire = null;
    serverQueue.playbackStableTimer = null;
    serverQueue.playbackAttemptController?.abort();
    serverQueue.playbackAttemptController = null;
    serverQueue.backendTransitioning = false;
  }

  static interruptPlaybackRecovery(guildId) {
    const queue = musicQueue.peek(guildId);
    if (!queue || (!queue.pendingPlaybackRecovery && !queue.playbackDeadlineExpire)) return false;
    this.invalidateCurrentPlayback(guildId, queue, { freeze: true });
    this.cleanupLocalProcesses(queue);
    queue.player?.stop(true);
    queue.skipRequested = true;
    queue.playbackError = false;
    queue.lastPlaybackError = null;
    queue.playbackRecovery = null;
    queue.playing = false;
    queue.startingBackend = null;
    this.resetLavalinkStart(queue);
    return true;
  }

  static recoverySession(serverQueue) {
    const song = serverQueue.currentSong;
    ensureQueueItemId(song);
    if (!serverQueue.playbackRecovery || serverQueue.playbackRecovery.itemId !== song?.queueItemId) {
      serverQueue.playbackRecovery = {
        itemId: song?.queueItemId,
        originalSong: song,
        startedAt: Date.now(),
        deadline: Date.now() + PLAYBACK_RECOVERY_TIMEOUT_MS,
        lavalinkRetries: 0,
        alternatives: null,
        alternativeAttempts: 0,
        visited: new Set([song?.url]),
        exhausted: new Set(),
      };
    }
    return serverQueue.playbackRecovery;
  }

  static beginPlaybackAttempt(guildId, serverQueue, song, options = {}) {
    this.cancelPlaybackWork(serverQueue);
    ensureQueueItemId(song);
    serverQueue.playbackRecovery = options.recoverySession || null;
    const session = this.recoverySession(serverQueue);
    const controller = new AbortController();
    serverQueue.playbackAttemptController = controller;
    serverQueue.playbackError = false;
    const playbackId = serverQueue.playbackId;
    const startedAt = Date.now();
    const retryTimeoutMs = options.lavalinkRetryTimeoutMs == null ? null
      : Math.min(options.lavalinkRetryTimeoutMs, this.lavalinkRetryTimeout(serverQueue, song, session));
    serverQueue.playbackAttemptStartedAt = startedAt;
    serverQueue.playbackAttemptDeadline = retryTimeoutMs == null ? session.deadline
      : Math.min(session.deadline, startedAt + Math.max(0, retryTimeoutMs));
    const expire = () => {
      if (!this.isCurrentPlayback(serverQueue, playbackId) || controller.signal.aborted) return;
      if (retryTimeoutMs != null && Date.now() < session.deadline) {
        const error = new Error('Lavalink 重试音源读取超时，未确认音频输出');
        error.code = 'LAVALINK_RETRY_START_TIMEOUT';
        // Abort outside the guild lock first: a hanging REST call must release
        // its transition before the timeout can route to local fallback.
        controller.abort(error);
        console.warn(`[PlaybackRecovery] guild=${guildId} playbackId=${playbackId} action=fallback reason=retry-start-timeout remainingMs=${Math.max(0, session.deadline - Date.now())}`);
        guildOperationContext.exit(() => this.handleLavalinkFailure(guildId, playbackId, error.message, 'retry-start-timeout').catch(recoveryError => {
          console.error('[Lavalink] retry-timeout recovery failed:', safeErrorMessage(recoveryError));
        }));
        return;
      }
      const error = new Error('Playback recovery deadline exceeded');
      controller.abort(error);
      this.recordPlaybackError(guildId, serverQueue, playbackId, 'recovery-deadline', error.message);
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
      this.cleanupLocalProcesses(serverQueue);
      serverQueue.player?.stop(true);
      getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(() => {});
      serverQueue.playing = false;
      // A timer created inside a transition must not inherit its reentrant lock.
      guildOperationContext.exit(() => this.advance(guildId, serverQueue).catch(error => {
        console.error('[PlaybackRecovery] deadline advance failed:', safeErrorMessage(error));
      }));
    };
    serverQueue.playbackDeadlineTimer = setTimeout(expire, Math.max(1, serverQueue.playbackAttemptDeadline - Date.now()));
    serverQueue.playbackDeadlineExpire = expire;
    serverQueue.playbackDeadlineTimer.unref?.();
    return controller.signal;
  }

  static confirmPlaybackOutput(guildId, serverQueue, playbackId, backend) {
    if (!this.isCurrentPlayback(serverQueue, playbackId) || serverQueue.playbackAttemptController?.signal.aborted) return;
    if (serverQueue.streamDiagnostics?.outputConfirmed) return;
    if (serverQueue.streamDiagnostics) serverQueue.streamDiagnostics.outputConfirmed = true;
    const session = serverQueue.playbackRecovery;
    if (session) session.outputConfirmedAt = Date.now();
    console.log(`[PlaybackRecovery] guild=${guildId} playbackId=${playbackId} outcome=output-confirmed backend=${backend} attemptElapsedMs=${Date.now() - (serverQueue.playbackAttemptStartedAt ?? Date.now())} elapsedMs=${session ? Date.now() - session.startedAt : 0}`);
    clearTimeout(serverQueue.playbackDeadlineTimer);
    serverQueue.playbackDeadlineTimer = null;
    serverQueue.playbackAttemptDeadline = null;
    serverQueue.playbackDeadlineExpire = null;
    clearTimeout(serverQueue.playbackStableTimer);
    // trackStart is not proof that audio has been read. Keep the retry budget
    // across early track errors; only sustained playback clears it.
    const checkStable = () => {
      if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
      const progressed = backend === 'local'
        ? Number(serverQueue.audioResource?.playbackDuration) >= PLAYBACK_STABLE_MS - 1000
        : Number(getLavalinkPlayer(guildId)?.lastPosition) / 1000 - (Number(serverQueue.seekOffsetSeconds) || 0) >= 25;
      if (!serverQueue.playing || serverQueue.pausedAt || !progressed) {
        serverQueue.playbackStableTimer = setTimeout(checkStable, 5000);
        serverQueue.playbackStableTimer.unref?.();
        return;
      }
      playbackAvailability.success(serverQueue.currentSong, backend);
      const session = serverQueue.playbackRecovery;
      if (session) console.log(`[PlaybackRecovery] guild=${guildId} playbackId=${playbackId} outcome=stable backend=${backend} lavalinkRetries=${session.lavalinkRetries} alternatives=${session.alternativeAttempts} confirmedStartMs=${session.outputConfirmedAt - session.startedAt} stableElapsedMs=${Date.now() - session.startedAt}`);
      serverQueue.playbackRecovery = null;
      serverQueue.playbackRetryCount = 0;
      serverQueue.lavalinkFailureCount = 0;
      serverQueue.radioFailureCount = 0;
      serverQueue.playbackStableTimer = null;
    };
    serverQueue.playbackStableTimer = setTimeout(checkStable, PLAYBACK_STABLE_MS);
    serverQueue.playbackStableTimer.unref?.();
  }

  static schedulePlaybackWork(guildId, serverQueue, { delayMs = 0, prepare = async () => null, execute }) {
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
    this.cleanupLocalProcesses(serverQueue);
    serverQueue.player?.stop(true);
    serverQueue.playing = false;
    serverQueue.startingBackend = null;
    this.resetLavalinkStart(serverQueue);
    const playbackId = serverQueue.playbackId;
    const controller = new AbortController();
    const pending = { controller, timer: null };
    const session = this.recoverySession(serverQueue);
    const current = () => this.isCurrentPlayback(serverQueue, playbackId)
      && serverQueue.pendingPlaybackRecovery === pending && !controller.signal.aborted
      && !serverQueue.queueEnded && !serverQueue.clearingQueue;
    serverQueue.pendingPlaybackRecovery = pending;
    // Only the short state mutation/play call runs in the guild lock. Sleep and
    // metadata search run outside it, so user controls can cancel them.
    guildOperationContext.exit(() => {
      pending.timer = setTimeout(async () => {
        if (!current()) return;
        let prepared = null;
        const remaining = Math.max(1, session.deadline - Date.now());
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
        try {
          prepared = await withPlaybackSignal(() => prepare(signal), signal);
        } catch (error) {
          if (!signal.aborted) console.warn('[PlaybackRecovery] preparation failed:', safeErrorMessage(error));
        }
        if (!current()) return;
        await this.runTransition(guildId, async () => {
          if (!current()) return;
          serverQueue.pendingPlaybackRecovery = null;
          if (serverQueue.pausedByEmptyChannel) {
            serverQueue.playbackError = true;
            return this.advance(guildId, serverQueue);
          }
          if (Date.now() >= session.deadline) {
            serverQueue.playbackError = true;
            serverQueue.lastPlaybackError ||= { category: 'recovery-deadline', message: 'Playback recovery deadline exceeded' };
            return this.advance(guildId, serverQueue);
          }
          return execute(prepared, session);
        }, { createQueue: false }).catch(error => {
          console.error('[PlaybackRecovery] scheduled work failed:', safeErrorMessage(error));
        });
      }, Math.min(delayMs, Math.max(0, session.deadline - Date.now())));
      pending.timer.unref?.();
    });
    return { ok: true, recovering: true };
  }

  static lavalinkRetryTimeout(serverQueue, song, session, delayMs = 0) {
    const reserveMs = this.shouldFallbackLavalinkToLocal(song, serverQueue.localFallbackTried) ? LOCAL_FALLBACK_RESERVE_MS : 0;
    return Math.max(0, Math.min(LAVALINK_TRACK_RETRY_TIMEOUT_MS, session.deadline - Date.now() - delayMs - reserveMs));
  }

  static retryLavalinkTrack(guildId, serverQueue, song, message, progressSeconds, suppressNowPlaying = true) {
    const classification = classifyPlaybackError(message, 'lavalink');
    const session = this.recoverySession(serverQueue);
    playbackAvailability.failure(song, 'lavalink', classification.category);
    if (!classification.transient || session.lavalinkRetries >= 1 || Date.now() >= session.deadline) return false;
    const delayMs = LAVALINK_TRACK_RETRY_DELAY_MS + Math.floor(Math.random() * 200);
    const retryTimeoutMs = this.lavalinkRetryTimeout(serverQueue, song, session, delayMs);
    if (retryTimeoutMs < MIN_LAVALINK_RETRY_MS) {
      console.log(`[PlaybackRecovery] guild=${guildId} playbackId=${serverQueue.playbackId} action=fallback reason=insufficient-retry-budget category=${classification.category} primaryClient=${classification.primaryClient || 'none'} remainingMs=${Math.max(0, session.deadline - Date.now())}`);
      return false;
    }
    session.lavalinkRetries += 1;
    console.log(`[PlaybackRecovery] guild=${guildId} playbackId=${serverQueue.playbackId} backend=lavalink category=${classification.category} primaryClient=${classification.primaryClient || 'none'} retry=1/1 remainingMs=${Math.max(0, session.deadline - Date.now())} retryTimeoutMs=${retryTimeoutMs}`);
    getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(() => {});
    this.schedulePlaybackWork(guildId, serverQueue, {
      delayMs,
      execute: () => {
        // Recheck after the delay/lock wait so it cannot eat the fallback reserve.
        const timeoutMs = Math.min(retryTimeoutMs, this.lavalinkRetryTimeout(serverQueue, song, session));
        if (timeoutMs < MIN_LAVALINK_RETRY_MS) {
          console.log(`[PlaybackRecovery] guild=${guildId} playbackId=${serverQueue.playbackId} action=fallback reason=insufficient-retry-budget remainingMs=${Math.max(0, session.deadline - Date.now())}`);
          if (this.shouldFallbackLavalinkToLocal(song, serverQueue.localFallbackTried)) {
            return this.fallbackLavalinkToLocal(guildId, serverQueue, song, song.source, { message, progressSeconds, suppressNowPlaying });
          }
          serverQueue.playbackError = true;
          return this.advance(guildId, serverQueue);
        }
        return this.playSongLavalink(guildId, serverQueue.textChannel, song, song.source, {
          recoverySession: session,
          preserveRetryCount: true,
          lavalinkRetryTimeoutMs: timeoutMs,
          seekSeconds: Math.max(0, progressSeconds - RETRY_REWIND_SECONDS),
          suppressNowPlaying,
        });
      },
    });
    return true;
  }

  static tryRadioAlternative(guildId, serverQueue, session, policy) {
    if (!session || serverQueue.currentSong?.source !== 'radio' || !serverQueue.radio?.enabled
      || serverQueue.songs.length > 0 || session.alternativeAttempts >= 2
      || Date.now() >= session.deadline || session.alternatives?.length === 0
      || ['backend-unavailable', 'environment', 'process-crash', 'recovery-deadline'].includes(policy.category)) return false;
    const failedSong = serverQueue.currentSong;
    const generation = serverQueue.radioGeneration;
    this.schedulePlaybackWork(guildId, serverQueue, {
      prepare: async signal => session.alternatives ?? await findRadioAlternatives(session.originalSong, serverQueue.versionPreference, {
        signal,
        excludedUrls: [...session.visited],
      }),
      execute: async alternatives => {
        session.alternatives = alternatives || [];
        if (serverQueue.radioGeneration !== generation || !serverQueue.radio.enabled || serverQueue.songs.length) {
          session.alternatives = [];
        }
        const candidate = session.alternatives.find(item => !playbackAvailability.isCoolingDown(item) && !session.visited.has(item.url));
        session.alternatives = candidate
          ? session.alternatives.slice(session.alternatives.indexOf(candidate) + 1) : [];
        if (!candidate) {
          serverQueue.playbackError = true;
          return this.advance(guildId, serverQueue);
        }
        session.alternativeAttempts += 1;
        session.visited.add(candidate.url);
        // The logical queue item is unchanged; consume its reservation once.
        this.commitReservedSong(serverQueue, failedSong);
        const replacement = {
          ...candidate,
          queueItemId: failedSong.queueItemId,
          source: 'radio',
          requestedBy: failedSong.requestedBy,
          requestedById: failedSong.requestedById,
        };
        console.log(`[PlaybackRecovery] action=radio-alternative attempt=${session.alternativeAttempts}/2`);
        sendPlaybackNotice(serverQueue, serverQueue.textChannel, `🔁 **${session.originalSong.title}** 的当前视频音源不可用，正在尝试同曲的其他上传版本。`);
        // A replacement is a fresh video: run the normal backend chain and keep
        // the same overall time/alternative budget across it.
        session.lavalinkRetries = 0;
        serverQueue.forceLocal = false;
        serverQueue.forceYtdlpPipe = false;
        serverQueue.localFallbackTried = false;
        return this.playSong(guildId, serverQueue.textChannel, replacement, 'radio', {
          recoverySession: session,
          suppressNowPlaying: false,
        });
      },
    });
    return true;
  }

  static async fallbackLavalinkToLocal(guildId, serverQueue, song, source, {
    message = 'Lavalink 播放失败',
    progressSeconds = 0,
    suppressNowPlaying = true,
  } = {}) {
    const platform = isBilibiliSongUrl(song?.url) ? 'Bilibili' : 'YouTube';
    const recoverySession = this.recoverySession(serverQueue);
    if (Date.now() >= recoverySession.deadline) return this.advance(guildId, serverQueue);
    const classification = classifyPlaybackError(message, 'lavalink');
    console.warn(`[${platform}] Lavalink failed, falling back to local yt-dlp: guild=${guildId} playbackId=${serverQueue.playbackId} category=${classification.category} primaryClient=${classification.primaryClient || 'none'} lavalinkRetries=${recoverySession.lavalinkRetries} remainingMs=${Math.max(0, recoverySession.deadline - Date.now())} detail=${safeErrorMessage(message).split('\n')[0].slice(0, 240)}`);
    sendPlaybackNotice(serverQueue, serverQueue.textChannel, `🔁 **${song?.title || '当前歌曲'}** 的 Lavalink ${playbackErrorText(message)}，正在切换备用播放器（语音连接会短暂重连）…`);
    if (platform === 'Bilibili') song.audioUrlExpiresAt = 0;
    serverQueue.playing = false;
    serverQueue.playbackError = false;
    serverQueue.lastPlaybackError = null;
    serverQueue.localFallbackTried = true;
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    this.resetLavalinkStart(serverQueue);
    getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(() => {});
    return this.playSong(guildId, serverQueue.textChannel, song, source || song.source || 'manual', {
      forceLocal: true,
      recoverySession,
      forceYtdlpPipe: true,
      localFallbackTried: true,
      seekSeconds: Math.max(0, Number(progressSeconds) - RETRY_REWIND_SECONDS),
      suppressNowPlaying,
    });
  }

  static async refreshBilibiliAudioUrl(song, signal = null) {
    signal?.throwIfAborted();
    if (!isBilibiliSongUrl(song?.url) || freshAudioUrl(song)) return song;
    try {
      const refreshed = await Bilibili.getVideoInfo(song.url, { signal });
      signal?.throwIfAborted();
      if (refreshed?.audioUrl) {
        song.audioUrl = refreshed.audioUrl;
        song.audioUrlExpiresAt = refreshed.audioUrlExpiresAt;
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      console.warn('[Bilibili] failed to refresh direct audio URL:', error.message);
    }
    return song;
  }

  static activeBackend(serverQueue) {
    if (serverQueue?.activeBackend === 'local') return 'local';
    if (serverQueue?.activeBackend === 'lavalink') {
      const player = getLavalinkPlayer(serverQueue.guildId);
      if (isLavalinkPlayerReady(player, player?.node, serverQueue?.voiceChannelId)) return 'lavalink';
      const localStatus = serverQueue?.player?.state?.status;
      if (serverQueue?.audioResource || serverQueue?.ffmpegProcess || serverQueue?.ytdlpProcess
        || [AudioPlayerStatus.Playing, AudioPlayerStatus.Paused, AudioPlayerStatus.Buffering].includes(localStatus)) return 'local';
      return null;
    }
    const localStatus = serverQueue?.player?.state?.status;
    const localAvailable = Boolean(serverQueue?.audioResource || serverQueue?.ffmpegProcess || serverQueue?.ytdlpProcess || [
      AudioPlayerStatus.Playing,
      AudioPlayerStatus.Paused,
      AudioPlayerStatus.Buffering,
    ].includes(localStatus));
    const lavalinkPlayer = serverQueue ? getLavalinkPlayer(serverQueue.guildId) : null;
    const lavalinkAvailable = Boolean(
      isLavalinkPlayerReady(lavalinkPlayer, lavalinkPlayer?.node, serverQueue?.voiceChannelId)
      && (serverQueue?.connection?.type === 'lavalink' || serverQueue?.activeBackend === 'lavalink'),
    );

    if (localAvailable) return 'local';
    if (lavalinkAvailable) return 'lavalink';
    if (serverQueue?.connection?.type === 'lavalink') {
      return null;
    }
    if (serverQueue?.connection) return 'local';
    return null;
  }

  static isPlaybackActuallyActive(serverQueue) {
    if (!serverQueue) return false;
    const backend = this.activeBackend(serverQueue);
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(serverQueue.guildId);
      return Boolean(
        isLavalinkPlayerReady(player, player?.node, serverQueue.voiceChannelId)
        && (player.playing || player.paused)
        && player.queue?.current
        && this.lavalinkPlaybackId(player.queue.current) === serverQueue.playbackId,
      );
    }
    const status = serverQueue.player?.state?.status;
    return Boolean(serverQueue.audioResource && [
      AudioPlayerStatus.Playing,
      AudioPlayerStatus.Paused,
      AudioPlayerStatus.Buffering,
    ].includes(status));
  }

  static recoverySeekSeconds(serverQueue, song, requestedSeekSeconds) {
    return getPlaybackResumeSeconds({
      ...serverQueue,
      currentSong: song,
      seekOffsetSeconds: Math.max(0, Number(requestedSeekSeconds) || 0),
      startedAt: null,
      pausedAt: null,
    });
  }

  static async advancePastExpiredRecovery(guildId, serverQueue, textChannel) {
    this.clearFinishedCurrentSong(serverQueue, { remember: true });
    serverQueue.queueEnded = false;
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return this.playSong(guildId, textChannel || serverQueue.textChannel);
  }

  static clearFinishedCurrentSong(serverQueue, { remember = false } = {}) {
    this.cancelPlaybackWork(serverQueue);
    serverQueue.playbackRecovery = null;
    if (remember && serverQueue.currentSong) this.rememberSong(serverQueue, serverQueue.currentSong);
    serverQueue.currentSong = null;
    serverQueue.playing = false;
    serverQueue.activeBackend = null;
    serverQueue.startingBackend = null;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
    serverQueue.forceLocal = false;
    serverQueue.forceYtdlpPipe = false;
    serverQueue.localFallbackTried = false;
    ensurePanelRevision(serverQueue, null);
  }

  static reserveNextManualSong(serverQueue) {
    const existing = serverQueue.reservedNext;
    if (existing?.source === 'manual' && existing.song) return existing;
    const song = serverQueue.songs[0];
    if (!song) return null;
    ensureQueueItemId(song);
    const reservation = { itemId: song.queueItemId, song, source: 'manual' };
    serverQueue.reservedNext = reservation;
    return reservation;
  }

  static commitReservedSong(serverQueue, song) {
    const itemId = song?.queueItemId;
    const reservation = serverQueue.reservedNext;
    if (!reservation || !itemId || reservation.itemId !== itemId) return false;
    this.removeQueueItemsById(serverQueue, [itemId]);
    serverQueue.reservedNext = null;
    return true;
  }

  static releaseReservedSong(serverQueue, song = null) {
    if (!serverQueue.reservedNext) return false;
    if (song?.queueItemId && serverQueue.reservedNext.itemId !== song.queueItemId) return false;
    serverQueue.reservedNext = null;
    return true;
  }

  static markBackendUnavailable(guildId, serverQueue, error, { pendingSong = null, invalidate = true } = {}) {
    const currentPlaybackId = serverQueue.playbackId;
    if (invalidate && (pendingSong || serverQueue.currentSong)) {
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: Boolean(serverQueue.currentSong) });
    }
    serverQueue.backendUnavailable = true;
    serverQueue.playbackBlocked = true;
    serverQueue.pendingRecovery = {
      guildId,
      playbackId: serverQueue.playbackId,
      songId: pendingSong?.queueItemId || serverQueue.currentSong?.queueItemId || null,
      reason: safeErrorMessage(error, 'Lavalink 节点暂不可用'),
      at: Date.now(),
    };
    serverQueue.playing = false;
    if (serverQueue.activeBackend === 'lavalink' || serverQueue.connection?.type === 'lavalink') {
      serverQueue.activeBackend = null;
      serverQueue.connection = null;
      serverQueue.lavalinkPlayer = null;
    }
    serverQueue.startingBackend = null;
    this.disarmStallWatchdog(guildId);
    this.clearLavalinkStartTimer(serverQueue);
    savePlaybackState(guildId, serverQueue, { immediate: true });
    this.scheduleLavalinkRecovery(guildId, serverQueue);
    return currentPlaybackId !== serverQueue.playbackId;
  }

  static clearBackendUnavailable(serverQueue) {
    serverQueue.backendUnavailable = false;
    serverQueue.playbackBlocked = false;
    serverQueue.pendingRecovery = null;
    serverQueue.recoveryAttempts = 0;
    serverQueue.lavalinkFailureCount = 0;
    serverQueue.voiceReconnectAttempts = 0;
    serverQueue.voiceRecoveryNotified = false;
    if (serverQueue.recoveryTimer) {
      clearTimeout(serverQueue.recoveryTimer);
      serverQueue.recoveryTimer = null;
    }
  }

  static cancelRecoveryTimers(serverQueue) {
    if (!serverQueue) return;
    this.cancelPlaybackWork(serverQueue);
    if (serverQueue.recoveryTimer) clearTimeout(serverQueue.recoveryTimer);
    if (serverQueue.voiceRecoveryTimer) clearTimeout(serverQueue.voiceRecoveryTimer);
    serverQueue.recoveryTimer = null;
    serverQueue.voiceRecoveryTimer = null;
  }

  static scheduleVoiceRecovery(guildId, serverQueue, reason, delayMs) {
    if (!serverQueue || serverQueue.voiceRecoveryTimer) return false;
    const lifecycleGeneration = serverQueue.lifecycleGeneration;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1_000, Number(delayMs) || 0));
    serverQueue.voiceRecoveryTimer = setTimeout(() => {
      serverQueue.voiceRecoveryTimer = null;
      if (musicQueue.peek(guildId) !== serverQueue
        || serverQueue.lifecycleGeneration !== lifecycleGeneration
        || !serverQueue.is247
        || serverQueue.connection) return;
      this.recoverVoiceConnection(guildId, reason).catch(() => {});
    }, delay);
    serverQueue.voiceRecoveryTimer.unref?.();
    return true;
  }

  static scheduleLavalinkRecovery(guildId, serverQueue, delayMs = null) {
    if (!serverQueue?.backendUnavailable || serverQueue.recoveryTimer) return false;
    const lifecycleGeneration = serverQueue.lifecycleGeneration;
    const attempts = Number(serverQueue.recoveryAttempts) || 0;
    const delay = delayMs == null
      ? serverQueue.lavalinkVoiceFallback
        ? VOICE_RECOVERY_MAX_BACKOFF_MS
        : Math.min(VOICE_RECOVERY_MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempts, 6)))
      : Math.max(0, Number(delayMs) || 0);
    serverQueue.recoveryTimer = setTimeout(() => {
      serverQueue.recoveryTimer = null;
      if (musicQueue.peek(guildId) !== serverQueue
        || serverQueue.lifecycleGeneration !== lifecycleGeneration
        || !serverQueue.backendUnavailable) return;
      serverQueue.recoveryAttempts = (Number(serverQueue.recoveryAttempts) || 0) + 1;
      this.recoverBackendUnavailable(guildId, serverQueue).then(ok => {
        if (ok) this.clearBackendUnavailable(serverQueue);
        else if (serverQueue.backendUnavailable) this.scheduleLavalinkRecovery(guildId, serverQueue);
      }).catch(error => {
        if (serverQueue.backendUnavailable) this.scheduleLavalinkRecovery(guildId, serverQueue);
        console.warn(`[Lavalink] recovery attempt failed guild=${guildId}:`, safeErrorMessage(error));
      });
    }, delay);
    serverQueue.recoveryTimer.unref?.();
    return true;
  }

  static async ensureLocalVoiceConnection(guildId, serverQueue, textChannel = null, signal = null) {
    signal?.throwIfAborted();
    if (serverQueue.connection?.type !== 'lavalink') return;

    const guild = textChannel?.guild || serverQueue.textChannel?.guild || serverQueue.guildRef;
    const voiceChannelId = serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId;
    if (!guild || !voiceChannelId) {
      throw new Error('本地播放需要真实语音连接，但缺少语音频道信息');
    }

    const voiceChannel = guild.channels.cache.get(voiceChannelId)
      || await guild.channels.fetch(voiceChannelId).catch(() => null);
    signal?.throwIfAborted();
    if (!voiceChannel) {
      throw new Error('本地播放需要真实语音连接，但找不到语音频道');
    }

    serverQueue.backendTransitioning = true;
    serverQueue.suppressVoiceRecoveryUntil = Date.now() + 15_000;
    try {
      await destroyLavalinkPlayer(guildId, 'switch-to-local-playback');
      signal?.throwIfAborted();
      const connection = await this.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator, { forceLocal: true, signal });
      signal?.throwIfAborted();
      serverQueue.connection = connection;
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + VOICE_TRANSITION_SETTLE_MS;
    } finally {
      if (!signal?.aborted) serverQueue.backendTransitioning = false;
    }
  }

  static async ensureLavalinkVoiceConnection(guildId, serverQueue) {
    if (!serverQueue.connection || serverQueue.connection.type === 'lavalink') return false;
    serverQueue.backendTransitioning = true;
    serverQueue.suppressVoiceRecoveryUntil = Date.now() + 15_000;
    try {
      this.cleanupLocalProcesses(serverQueue);
      try {
        serverQueue.player?.stop(true);
      } catch {
        // The old local resource is already invalidated by its playback ID.
      }
      try {
        serverQueue.connection.destroy();
      } catch (error) {
        console.warn('[Voice] failed to destroy local connection before Lavalink:', error.message);
      }
      serverQueue.connection = null;
      serverQueue.player = null;
      serverQueue.audioResource = null;
    } finally {
      serverQueue.backendTransitioning = false;
    }
    return true;
  }

  static unpipeAudio(serverQueue) {
    try {
      if (serverQueue.ytdlpProcess?.stdout && serverQueue.ffmpegProcess?.stdin) {
        serverQueue.ytdlpProcess.stdout.unpipe(serverQueue.ffmpegProcess.stdin);
      }
    } catch (error) {
      console.error('[Player] unpipe error:', error.message);
    }
    serverQueue.audioResource = null;
  }

  static terminateChildProcess(process) {
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    try {
      process.kill();
    } catch {
      return;
    }
    const killTimer = setTimeout(() => {
      if (process.exitCode !== null || process.signalCode !== null) return;
      try {
        process.kill('SIGKILL');
      } catch {
        // The process may have exited between the state check and kill().
      }
    }, CHILD_PROCESS_KILL_GRACE_MS);
    killTimer.unref?.();
  }

  static cleanupLocalProcesses(serverQueue) {
    this.clearStreamStallWatchdog(serverQueue);
    if (serverQueue.ffmpegProcess) {
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ffmpegProcess);
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ytdlpProcess);
      serverQueue.ytdlpProcess = null;
    }
  }

  static async getNextSong(guildId, serverQueue) {
    // 24/7 空频道时让当前歌曲播完，但不再推进任何待播内容。
    if (serverQueue.pausedByEmptyChannel || serverQueue.playbackBlocked) return null;

    // 手动队列优先
    if (serverQueue.songs.length > 0) {
      const reservation = this.reserveNextManualSong(serverQueue);
      return reservation ? { song: reservation.song, source: reservation.source, reservation } : null;
    }

    if (serverQueue.suppressRadioUntilManualQueueEnds) {
      // 手动队列已空（songs.shift() 后到达这里），清除抑制标志，允许 radio 接力
      serverQueue.suppressRadioUntilManualQueueEnds = false;
    }

    if (serverQueue.suppressRadioUntilManualPlay) return null;

    if (serverQueue.radio?.pendingStyle) {
      serverQueue.radio.currentStyle = { ...serverQueue.radio.pendingStyle };
      serverQueue.radio.pendingStyle = null;
      serverQueue.radio.seedSong = null;
      serverQueue.radioQueue = [];
    } else {
      await maybeApplyAutodetect(serverQueue);
    }

    if (serverQueue.radio?.enabled) {
      this.pruneUnavailableRadio(serverQueue);
      if (serverQueue.radioQueue.length === 0) {
        await ensureRadioQueue(serverQueue, 5);
        this.enforceQueueLimits(serverQueue);
      }
      this.pruneUnavailableRadio(serverQueue);

      const existingReservation = serverQueue.reservedNext?.source === 'radio'
        ? serverQueue.reservedNext
        : null;
      const song = existingReservation?.song || serverQueue.radioQueue[0];
      if (song) {
        ensureQueueItemId(song);
        serverQueue.reservedNext = existingReservation || { itemId: song.queueItemId, song, source: 'radio' };
        if (serverQueue.radioQueue[0] !== song) {
          const index = serverQueue.radioQueue.findIndex(item => item?.queueItemId === song.queueItemId);
          if (index >= 0) [serverQueue.radioQueue[0], serverQueue.radioQueue[index]] = [serverQueue.radioQueue[index], serverQueue.radioQueue[0]];
        }
      }
      if (serverQueue.radioQueue.length < 3) {
        ensureRadioQueue(serverQueue, 5).catch(error => {
          console.error('[Radio] background generation failed:', error.message);
        });
      }

      return song ? { song, source: 'radio' } : null;
    }

    return null;
  }

  static async resolveNextSongForSkip(guildId, serverQueue) {
    const next = await this.getNextSong(guildId, serverQueue);
    if (next?.song) return { ok: true, ...next };

    if (serverQueue.radio?.enabled && !serverQueue.pausedByEmptyChannel && !serverQueue.suppressRadioUntilManualPlay) {
      const generatedCount = await ensureRadioQueue(serverQueue, 5);
      this.enforceQueueLimits(serverQueue);
      this.pruneUnavailableRadio(serverQueue);
      if (generatedCount > 0 || serverQueue.radioQueue.length > 0) {
        const radioSong = serverQueue.radioQueue[0];
        if (radioSong) {
          ensureQueueItemId(radioSong);
          serverQueue.reservedNext = { itemId: radioSong.queueItemId, song: radioSong, source: 'radio' };
        }
        if (serverQueue.radioQueue.length < 3) {
          ensureRadioQueue(serverQueue, 5).catch(error => {
            console.error('[Radio] background generation failed:', error.message);
          });
        }
        if (radioSong) return { ok: true, song: radioSong, source: 'radio' };
      }
      return { ok: false, reason: 'no-radio-recommendation' };
    }

    return { ok: false, reason: 'no-next-song' };
  }

  static async ensureRadioReadyForAutoplay(serverQueue) {
    if (!serverQueue.radio?.enabled || serverQueue.pausedByEmptyChannel) return 0;
    const generated = await ensureRadioQueue(serverQueue, 5);
    this.enforceQueueLimits(serverQueue);
    if (serverQueue.radioQueue.length > 0) return generated;
    if (serverQueue.radio.isGenerating && serverQueue.radio._generatingPromise) {
      await Promise.race([
        serverQueue.radio._generatingPromise,
        sleep(RADIO_GENERATION_WAIT_MS),
      ]);
    }
    return serverQueue.radioQueue.length;
  }

  static pruneUnavailableRadio(serverQueue) {
    serverQueue.radioQueue = serverQueue.radioQueue.filter(song => !playbackAvailability.isCoolingDown(song));
    if (serverQueue.reservedNext?.source === 'radio' && playbackAvailability.isCoolingDown(serverQueue.reservedNext.song)) {
      serverQueue.reservedNext = null;
    }
  }

  static maybePrefillRadioQueue(guildId, serverQueue, reason = 'playback') {
    if (!serverQueue?.radio?.enabled) return false;
    if (serverQueue.pausedByEmptyChannel || serverQueue.radioQueue.length >= 2) return false;
    ensureRadioQueue(serverQueue, 5)
      .then(count => {
        if (count > 0) {
          console.log(`[Radio] prefetched ${count} songs after ${reason}`);
          savePlaybackState(guildId, serverQueue);
        }
      })
      .catch(error => {
        console.error('[Radio] prefill failed:', error.message);
      });
    return true;
  }

  static isCurrentPlayback(serverQueue, playbackId) {
    return Boolean(
      serverQueue
      && musicQueue.peek(serverQueue.guildId) === serverQueue
      && serverQueue.playbackId === playbackId,
    );
  }

  static invalidateCurrentPlayback(guildId, serverQueue, { freeze = false } = {}) {
    if (!serverQueue) return null;
    this.cancelPlaybackWork(serverQueue);
    serverQueue.playbackId = (Number(serverQueue.playbackId) || 0) + 1;
    this.nextPlaybackGeneration(serverQueue);
    serverQueue.playbackLifecycleGeneration = (Number(serverQueue.playbackLifecycleGeneration) || 0) + 1;
    this.clearLavalinkStartTimer(serverQueue);
    this.clearLavalinkFinishTimer(serverQueue);
    this.clearLocalStartTimer(serverQueue);
    serverQueue.pendingNowPlaying = null;
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    serverQueue.advanceSignal = (Number(serverQueue.advanceSignal) || 0) + 1;
    if (freeze && serverQueue.currentSong) freezePlaybackProgress(serverQueue);
    return serverQueue.playbackId;
  }

  static notifyAdvance(guildId, serverQueue) {
    if (!serverQueue || musicQueue.peek(guildId) !== serverQueue) return;
    serverQueue.advanceSignal = (Number(serverQueue.advanceSignal) || 0) + 1;
    const waiters = advanceWaiters.get(guildId);
    if (!waiters) return;
    advanceWaiters.delete(guildId);
    for (const waiter of waiters) waiter.resolve({ signal: serverQueue.advanceSignal });
  }

  // 起播前预缓冲：等下游缓冲累积到阈值或超时后再 resolve，
  // 让开头/断流恢复时有足够余量，避免 missed frame 导致的卡顿+赶进度。
  static waitForPrebuffer(stream) {
    if (AUDIO_PREBUFFER_TIMEOUT_MS <= 0) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stream.removeListener('readable', onReadable);
        clearTimeout(timer);
        resolve();
      };
      const onReadable = () => {
        if (stream.readableLength >= AUDIO_PREBUFFER_BYTES) finish();
      };
      const timer = setTimeout(finish, AUDIO_PREBUFFER_TIMEOUT_MS);
      stream.on('readable', onReadable);
      onReadable();
    });
  }

  static rememberSong(serverQueue, song) {
    if (!song) return;
    serverQueue.history.push(song);
    if (serverQueue.history.length > 100) {
      serverQueue.history.splice(0, serverQueue.history.length - 100);
    }
  }

  static recordPlaybackError(guildId, serverQueue, playbackId, source, message, error = null) {
    if (!this.isCurrentPlayback(serverQueue, playbackId) || serverQueue.skipRequested || serverQueue.playbackError) return false;
    const errorMessage = safeErrorMessage(error?.message || message || '未知播放错误');
    const estimatedProgressSeconds = getPlaybackProgressSeconds(serverQueue);
    const progressSeconds = source === 'lavalink' ? this.lavalinkProgressSeconds(serverQueue) : estimatedProgressSeconds;
    const classification = classifyPlaybackError({ message: errorMessage, code: error?.code }, source);
    serverQueue.playbackError = true;
    serverQueue.lastPlaybackError = {
      source,
      message: errorMessage,
      category: classification.category,
      songTitle: serverQueue.currentSong?.title || '未知歌曲',
      songUrl: serverQueue.currentSong?.url || '',
      playbackId,
      progressSeconds,
      occurredAt: Date.now(),
    };
    console.error(`[PlaybackError] source=${source} guild=${guildId} playbackId=${playbackId} category=${classification.category} primaryClient=${classification.primaryClient || 'none'} outputConfirmed=${Boolean(serverQueue.streamDiagnostics?.outputConfirmed)} progress=${progressSeconds}s estimatedProgress=${estimatedProgressSeconds}s title="${serverQueue.lastPlaybackError.songTitle}"`);
    console.error('[PlaybackError] message=', errorMessage);
    return true;
  }

  static lavalinkPlaybackId(track) {
    const value = track?.userData?.musicBotPlaybackId
      ?? track?.userData?.playbackId
      ?? track?.pluginInfo?.userData?.musicBotPlaybackId;
    const playbackId = Number(value);
    return Number.isFinite(playbackId) && playbackId > 0 ? playbackId : null;
  }

  static claimTerminal(serverQueue, playbackId, event) {
    if (!serverQueue || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
    if (serverQueue.terminalHandledPlaybackId === playbackId) return false;
    if (serverQueue.lavalinkPendingFinish?.playbackId === playbackId) {
      this.clearLavalinkFinishTimer(serverQueue);
    }
    serverQueue.terminalHandledPlaybackId = playbackId;
    this.clearLavalinkStartTimer(serverQueue);
    debugLog(`[Playback] terminal claimed id=${playbackId} event=${event}`);
    return true;
  }

  static clearLavalinkStartTimer(serverQueue) {
    if (!serverQueue?.lavalinkStartTimer) return;
    clearTimeout(serverQueue.lavalinkStartTimer);
    serverQueue.lavalinkStartTimer = null;
  }

  static clearLavalinkFinishTimer(serverQueue) {
    if (!serverQueue) return;
    if (serverQueue.lavalinkFinishTimer) clearTimeout(serverQueue.lavalinkFinishTimer);
    serverQueue.lavalinkFinishTimer = null;
    serverQueue.lavalinkPendingFinish = null;
  }

  static deferLavalinkFinish(guildId, serverQueue, playbackId, event) {
    if (!serverQueue || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
    if (serverQueue.terminalHandledPlaybackId === playbackId) return false;
    if (serverQueue.lavalinkPendingFinish?.playbackId === playbackId) return true;

    this.clearLavalinkFinishTimer(serverQueue);
    serverQueue.lavalinkPendingFinish = { playbackId, event };
    serverQueue.lavalinkFinishTimer = setTimeout(() => {
      this.runTransition(guildId, async () => {
        const queue = musicQueue.peek(guildId);
        if (queue !== serverQueue || queue.lavalinkPendingFinish?.playbackId !== playbackId) return;
        this.clearLavalinkFinishTimer(queue);
        if (!this.claimTerminal(queue, playbackId, event)) return;
        queue.lavalinkFailureCount = 0;
        queue.radioFailureCount = 0;
        this.resetLavalinkStart(queue);
        queue.playing = false;
        await this.advance(guildId, queue);
      }, { createQueue: false }).catch(error => {
        console.error('[Lavalink] delayed finish advance failed:', safeErrorMessage(error));
      });
    }, LAVALINK_FINISH_CONFIRM_MS);
    serverQueue.lavalinkFinishTimer.unref?.();
    return true;
  }

  static clearLocalStartTimer(serverQueue) {
    if (!serverQueue?.localStartTimer) return;
    clearTimeout(serverQueue.localStartTimer);
    serverQueue.localStartTimer = null;
  }

  static clearStreamStallWatchdog(serverQueue) {
    if (!serverQueue?.streamStallTimer) return;
    clearInterval(serverQueue.streamStallTimer);
    serverQueue.streamStallTimer = null;
  }

  // 断流看门狗：播放中源进程仍存活、下游缓冲已耗尽且长时间无新数据（平台限速/断连）
  // 时按播放错误处理，走现有重试/跳歌链路并向用户反馈，而不是静默卡死。
  static armStreamStallWatchdog(guildId, serverQueue, playbackId) {
    this.clearStreamStallWatchdog(serverQueue);
    const timer = setInterval(() => {
      if (!this.isCurrentPlayback(serverQueue, playbackId)
        || serverQueue.activeBackend !== 'local'
        || serverQueue.queueEnded
        || serverQueue.clearingQueue) {
        this.clearStreamStallWatchdog(serverQueue);
        return;
      }
      const diagnostics = serverQueue.streamDiagnostics;
      if (!diagnostics || diagnostics.playbackId !== playbackId) return;
      // 暂停/未播放时重置基线，避免把正常暂停误判为断流
      if (!serverQueue.playing
        || serverQueue.pausedAt
        || serverQueue.player?.state?.status !== AudioPlayerStatus.Playing) {
        diagnostics.lastBytesAt = Date.now();
        return;
      }
      // ffmpeg 正常读完整首歌后不会再有新数据，缓冲区里的音频仍会继续播放，
      // 此时不是断流；播完后走 AudioPlayerStatus.Idle 正常推进队列。
      if (diagnostics.sourceEnded) {
        this.clearStreamStallWatchdog(serverQueue);
        return;
      }
      // 下游缓冲仍有音频待播，播放不可能卡住。
      if (Number(diagnostics.audioStream?.readableLength) > 0) {
        diagnostics.lastBytesAt = Date.now();
        return;
      }
      if (Date.now() - (Number(diagnostics.lastBytesAt) || 0) < LOCAL_STREAM_STALL_MS) return;

      this.clearStreamStallWatchdog(serverQueue);
      const message = `音频流超过 ${Math.round(LOCAL_STREAM_STALL_MS / 1000)} 秒无数据（平台可能限速或断流）`;
      console.warn(`[Local] stream stall guild=${guildId} playbackId=${playbackId} bytes=${diagnostics.bytesStreamed}`);
      if (!this.recordPlaybackError(guildId, serverQueue, playbackId, 'stream-stall', message)) return;
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
      this.cleanupLocalProcesses(serverQueue);
      try {
        serverQueue.player?.stop(true);
      } catch {
        // The resource may already be idle after a stream stall.
      }
      this.advance(guildId, serverQueue).catch(error => {
        console.error('[Local] stream-stall recovery failed:', safeErrorMessage(error));
      });
    }, LOCAL_STREAM_STALL_CHECK_MS);
    timer.unref?.();
    serverQueue.streamStallTimer = timer;
  }

  static armLocalStartTimer(guildId, serverQueue, playbackId) {
    this.clearLocalStartTimer(serverQueue);
    serverQueue.localStartTimer = setTimeout(() => {
      serverQueue.localStartTimer = null;
      if (!this.isCurrentPlayback(serverQueue, playbackId) || serverQueue.activeBackend !== 'local') return;
      const status = serverQueue.player?.state?.status;
      if (status === AudioPlayerStatus.Playing) return;
      const message = '本地播放器起播超时，未在规定时间内开始播放';
      console.warn(`[Local] start timeout guild=${guildId} playbackId=${playbackId} status=${status || 'unknown'}`);
      this.recordPlaybackError(guildId, serverQueue, playbackId, 'local-start-timeout', message);
      if (this.claimTerminal(serverQueue, playbackId, 'local-start-timeout')) {
        serverQueue.playing = false;
        this.advance(guildId, serverQueue).catch(error => {
          console.error('[Local] start-timeout recovery failed:', safeErrorMessage(error));
        });
      }
    }, LOCAL_START_TIMEOUT_MS);
    serverQueue.localStartTimer.unref?.();
  }

  static armLavalinkStartTimer(guildId, serverQueue, playbackId) {
    this.clearLavalinkStartTimer(serverQueue);
    serverQueue.lavalinkStartTimer = setTimeout(() => {
      if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
      if (serverQueue.lavalinkConfirmedPlaybackId === playbackId) return;
      const message = 'Lavalink 在 10 秒内没有确认音轨开始播放';
      console.warn(`[Lavalink] start timeout guild=${guildId} playbackId=${playbackId}`);
      this.handleLavalinkFailure(guildId, playbackId, message, 'start-timeout').catch(error => {
        console.error('[Lavalink] start-timeout recovery failed:', error.message);
      });
    }, 10_000);
  }

  static async handleLavalinkFailure(guildId, playbackId, message, event = 'track-error') {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.handleLavalinkFailure(guildId, playbackId, message, event));
    }
    const serverQueue = musicQueue.peek(guildId);
    if (serverQueue?.lavalinkPendingFinish?.playbackId === playbackId) {
      this.clearLavalinkFinishTimer(serverQueue);
    }
    if (!serverQueue || !this.claimTerminal(serverQueue, playbackId, event)) return false;

    const song = serverQueue.currentSong;
    const source = song?.source || 'manual';
    const player = getLavalinkPlayer(guildId);
    const progressSeconds = this.lavalinkProgressSeconds(serverQueue, player);
    const recorded = this.recordPlaybackError(guildId, serverQueue, playbackId, 'lavalink', message);
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
    serverQueue.playing = false;

    if (event === 'start-timeout' || event === 'socket-closed' || isLavalinkInfrastructureError(new Error(message))) {
      this.markBackendUnavailable(guildId, serverQueue, new Error(message), {
        pendingSong: song,
        invalidate: false,
      });
      return false;
    }

    if (this.retryLavalinkTrack(guildId, serverQueue, song, message, progressSeconds)) return true;

    if (this.shouldFallbackLavalinkToLocal(song, serverQueue.localFallbackTried)) {
      return this.fallbackLavalinkToLocal(guildId, serverQueue, song, source, {
        message: `${event}: ${message}`,
        progressSeconds,
      });
    }

    if (!recorded) return false;
    serverQueue.lavalinkFailureCount = (serverQueue.lavalinkFailureCount || 0) + 1;
    if (this.shouldStopAfterLavalinkFailures(guildId, serverQueue, message)) return false;
    if (song?.source !== 'radio') serverQueue.suppressRadioUntilManualPlay = true;
    await player?.stopPlaying(true, false).catch(() => {});
    return this.advance(guildId, serverQueue);
  }

  static resetLavalinkStart(serverQueue, startKey = null) {
    if (!serverQueue) return;
    if (!startKey || serverQueue.lavalinkStartKey === startKey) {
      serverQueue.lavalinkStarting = false;
      serverQueue.lavalinkStartKey = null;
    }
  }

  static lavalinkProgressSeconds(serverQueue, player = getLavalinkPlayer(serverQueue.guildId)) {
    const diagnostics = serverQueue.streamDiagnostics;
    if (diagnostics?.outputConfirmed) {
      const positionMs = Number(player?.lastPosition ?? diagnostics.confirmedPositionMs);
      if (Number.isFinite(positionMs)) return Math.max(0, positionMs / 1000);
    }
    return Math.max(0, Number(diagnostics?.startPositionSeconds ?? serverQueue.seekOffsetSeconds) || 0);
  }

  static nextPlaybackGeneration(serverQueue) {
    serverQueue.playbackGeneration = (Number(serverQueue.playbackGeneration) || 0) + 1;
    return serverQueue.playbackGeneration;
  }

  static isCurrentGeneration(serverQueue, generation) {
    return (Number(serverQueue.playbackGeneration) || 0) === generation;
  }

  static isManualPlaybackActive(serverQueue) {
    return serverQueue.currentSong?.source === 'manual' || serverQueue.songs.some(song => (song.source || 'manual') === 'manual');
  }

  static hasPendingPlayback(serverQueue) {
    return Boolean(serverQueue)
      && (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled);
  }

  static prepareManualPlayback(serverQueue) {
    invalidateRadioGeneration(serverQueue, 'manual-playback');
    serverQueue.radioQueue = [];
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    serverQueue.suppressRadioUntilManualQueueEnds = true;
    serverQueue.queueEnded = false;
  }

  static async stopCurrentTrackOnly(guildId, serverQueue) {
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
    this.cleanupProcesses(serverQueue);
    serverQueue.skipRequested = true;
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    this.resetLavalinkStart(serverQueue);
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (player) await player.stopPlaying(true, false).catch(() => {});
      return;
    }
    try {
    serverQueue.player?.stop(true);
    } catch {
      // Ignore stop failures while replacing the current track.
    }
    getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(() => {});
  }

  static stopRadioAfterFailures(guildId, serverQueue, reason) {
    invalidateRadioGeneration(serverQueue, 'radio-failures');
    serverQueue.radio.enabled = false;
    serverQueue.radioQueue = [];
    serverQueue.radio.pendingStyle = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = true;
    sendPlaybackNotice(serverQueue, serverQueue.textChannel, `⚠️ Radio 连续播放失败，已自动关闭以避免面板继续跳歌。\n原因：${reason}`);
    savePlaybackState(guildId, serverQueue, { immediate: true });
  }

  static async advance(guildId, serverQueue) {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.advance(guildId, serverQueue));
    }
    if (serverQueue.queueEnded || serverQueue.clearingQueue) {
      debugLog('[Player] advance ignored because queue is ended/clearing');
      return;
    }
    if (serverQueue.pendingPlaybackRecovery) return { ok: true, recovering: true };
    if (serverQueue.playbackBlocked) {
      this.scheduleLavalinkRecovery(guildId, serverQueue);
      return { ok: false, reason: 'backend-unavailable' };
    }

    if (serverQueue.advancing) {
      return this.waitForAdvance(guildId, 3000);
    }

    serverQueue.advancing = true;
    try {
      const hadPlaybackError = serverQueue.playbackError;
      const playbackErrorInfo = hadPlaybackError ? serverQueue.lastPlaybackError : null;

      if (serverQueue.pausedByEmptyChannel) {
        this.clearFinishedCurrentSong(serverQueue, { remember: !hadPlaybackError });
        serverQueue.playbackError = false;
        serverQueue.lastPlaybackError = null;
        serverQueue.playbackRetryCount = 0;
        serverQueue.skipRequested = false;
        serverQueue.queueEnded = true;
        this.cleanupProcesses(serverQueue);
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return;
      }

      const recoverySession = playbackErrorInfo && serverQueue.currentSong ? this.recoverySession(serverQueue) : null;
      const retryPolicy = classifyPlaybackError(playbackErrorInfo?.message, playbackErrorInfo?.source);
      if (playbackErrorInfo?.source === 'lavalink') retryPolicy.localRetries = 0;
      if (playbackErrorInfo && serverQueue.currentSong
        && serverQueue.playbackRetryCount < retryPolicy.localRetries
        && Date.now() < recoverySession.deadline) {
        serverQueue.playbackError = false;
        serverQueue.playbackRetryCount += 1;
        const retrySeekSeconds = Math.max(0, (playbackErrorInfo.progressSeconds || getPlaybackProgressSeconds(serverQueue)) - RETRY_REWIND_SECONDS);
        const song = serverQueue.currentSong;
        console.warn(`[PlaybackRetry] attempt=${serverQueue.playbackRetryCount}/${retryPolicy.localRetries} seek=${retrySeekSeconds}s title="${song.title}"`);
        return this.schedulePlaybackWork(guildId, serverQueue, {
          delayMs: RETRY_BACKOFF_MS,
          execute: () => this.playSong(guildId, serverQueue.textChannel, song, song.source || 'manual', {
            seekSeconds: retrySeekSeconds,
            suppressNowPlaying: true,
            preserveRetryCount: true,
            recoverySession,
            forceLocal: serverQueue.forceLocal,
            forceYtdlpPipe: true,
            localFallbackTried: serverQueue.localFallbackTried,
          }),
        });
      }

      if (serverQueue.playbackError) {
        if (playbackErrorInfo && serverQueue.currentSong) {
          if (!recoverySession.exhausted.has(serverQueue.currentSong.url)) {
            recoverySession.exhausted.add(serverQueue.currentSong.url);
            playbackAvailability.failure(serverQueue.currentSong, serverQueue.forceLocal ? 'local' : (serverQueue.activeBackend || playbackErrorInfo.source), retryPolicy.category, { exhausted: true });
          }
          if (this.tryRadioAlternative(guildId, serverQueue, recoverySession, retryPolicy)) return { ok: true, recovering: true };
        }
        if (playbackErrorInfo && serverQueue.currentSong) {
          const reason = describePlaybackErrorForUser(playbackErrorInfo);
          console.warn(`[PlaybackSkipAfterError] title="${serverQueue.currentSong.title}" reason="${reason}"`);
          sendPlaybackNotice(serverQueue, serverQueue.textChannel, `⚠️ 当前歌曲播放失败，已跳到下一首：**${serverQueue.currentSong.title}**\n原因：${reason}`);
          if (serverQueue.currentSong.source !== 'radio') {
            serverQueue.suppressRadioUntilManualPlay = true;
          }
        }
        if (serverQueue.currentSong) {
          this.removeQueueItemsById(serverQueue, [serverQueue.currentSong.queueItemId]);
          this.releaseReservedSong(serverQueue, serverQueue.currentSong);
        }
        serverQueue.playbackError = false;
      } else if (serverQueue.loop === 'single' && serverQueue.currentSong && !serverQueue.skipRequested) {
        return await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual');
      } else if (serverQueue.currentSong) {
        playbackAvailability.success(serverQueue.currentSong, serverQueue.activeBackend);
        this.rememberSong(serverQueue, serverQueue.currentSong);
      }

      if (serverQueue.currentSong?.source === 'manual' && serverQueue.songs.length === 0) {
        serverQueue.suppressRadioUntilManualQueueEnds = false;
      }

      if (serverQueue.loop === 'queue' && serverQueue.currentSong?.source === 'manual' && !serverQueue.skipRequested && !hadPlaybackError) {
        if (serverQueue.songs.length < getMaxQueueSize()) serverQueue.songs.push(serverQueue.currentSong);
      }

      serverQueue.skipRequested = false;
      serverQueue.lastPlaybackError = null;
      serverQueue.playbackRetryCount = 0;
      serverQueue.playbackRecovery = null;

      // A candidate that failed after retries must not remain reserved as the next song.
      // 用循环代替递归，避免 advancing 锁导致跳过不可播放歌曲时卡死
      const MAX_SKIP = 20;
      const historyLengthBeforeAdvance = serverQueue.history.length;
      const currentSongBeforeAdvance = serverQueue.currentSong;
      for (let attempt = 0; attempt < MAX_SKIP; attempt++) {
        const next = await this.getNextSong(guildId, serverQueue);
        if (!next?.song) {
          return await this.playSong(guildId, serverQueue.textChannel, null, null);
        }
        if (!isPlayableSongUrl(next.song.url)) {
          console.warn('[Player] advance skipped non-playable URL:', next.song.title, next.song.url);
          this.removeQueueItemsById(serverQueue, [next.song.queueItemId]);
          this.releaseReservedSong(serverQueue, next.song);
          this.rememberSong(serverQueue, { ...next.song, skippedReason: 'non-playable-url' });
          continue;
        }
        const result = await this.playSong(guildId, serverQueue.textChannel, next.song, next.source);
        if (result?.reason === 'backend-unavailable') {
          serverQueue.history.splice(historyLengthBeforeAdvance);
          serverQueue.currentSong = currentSongBeforeAdvance;
          return result;
        }
        return result;
      }
      console.warn('[Player] advance exhausted skip attempts');
      return await this.playSong(guildId, serverQueue.textChannel, null, null);
    } finally {
      serverQueue.advancing = false;
      savePlaybackState(guildId, serverQueue);
      // advance 完成后启动看门狗，防止播放链条断裂导致卡死
      this.armStallWatchdog(guildId);
      this.notifyAdvance(guildId, serverQueue);
    }
  }

  static waitForAdvance(guildId, timeoutMs = 3000, sinceSignal = null) {
    const serverQueue = musicQueue.peek(guildId);
    if (serverQueue && sinceSignal != null && serverQueue.advanceSignal > sinceSignal) {
      return Promise.resolve({ signal: serverQueue.advanceSignal });
    }
    return new Promise(resolve => {
      const waiter = {
        timer: null,
        resolve: value => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(value);
        },
      };
      waiter.timer = setTimeout(() => {
        const waiters = advanceWaiters.get(guildId) || [];
        const remaining = waiters.filter(entry => entry !== waiter);
        if (remaining.length) advanceWaiters.set(guildId, remaining);
        else advanceWaiters.delete(guildId);
        resolve({ timedOut: true });
      }, timeoutMs);
      if (!advanceWaiters.has(guildId)) advanceWaiters.set(guildId, []);
      advanceWaiters.get(guildId).push(waiter);
    });
  }

  /**
   * 卡死检测看门狗：每次 advance/playSong 结束后启动。
   * 如果 STALL_WATCHDOG_MS 后 player 仍是 Idle 且队列中还有歌（或 radio 开启），
   * 说明推进链条断裂，强制调用 advance() 恢复。
   */
  static armStallWatchdog(guildId) {
    this.disarmStallWatchdog(guildId);
    const timer = setTimeout(() => {
      stallTimers.delete(guildId);
      const serverQueue = musicQueue.peek(guildId);
      if (!serverQueue) return;
      if (serverQueue.queueEnded || serverQueue.clearingQueue) return;
      if (serverQueue.advancing || serverQueue.pendingPlaybackRecovery || serverQueue.playbackDeadlineTimer) return;

      const hasWork = this.hasPendingPlayback(serverQueue);
      if (!hasWork) return;

      const backend = this.activeBackend(serverQueue);
      const localStatus = serverQueue.player?.state?.status;
      const isLocalIdle = backend === 'local' && serverQueue.player && localStatus === AudioPlayerStatus.Idle;
      const lavalinkPlayer = backend === 'lavalink' ? getLavalinkPlayer(guildId) : null;
      const lavalinkHasActiveTrack = Boolean(
        lavalinkPlayer?.playing
        || lavalinkPlayer?.paused
        || lavalinkPlayer?.queue?.current
        || lavalinkPlayer?.track
      );
      const isLavalinkIdle = backend === 'lavalink' && !lavalinkHasActiveTrack && !serverQueue.lavalinkStarting;

      // 如果标记为正在播放，检查是否真的有活跃的播放资源
      if (serverQueue.playing) {
        // 健全性检查：playing=true 但没有 player/connection 说明是脏状态
        if (!serverQueue.player && !serverQueue.connection) {
          console.warn(`[StallWatchdog] guild=${guildId} detected stale playing=true (no player, no connection), resetting`);
          serverQueue.playing = false;
          serverQueue.advancing = false;
        } else if (!isLocalIdle && !isLavalinkIdle) {
          return; // 真正在播放，不干预
        } else {
          console.warn(`[StallWatchdog] guild=${guildId} playing=true but backend is idle (backend=${backend}, local=${localStatus || 'none'}, lavalinkActive=${lavalinkHasActiveTrack}), recovering`);
          serverQueue.playing = false;
        }
      }

      if (serverQueue.is247 && !serverQueue.connection) {
        console.warn(`[StallWatchdog] guild=${guildId} detected 24/7 without voice connection, recovering`);
        this.recoverVoiceConnection(guildId, 'stall-watchdog-247').catch(error => {
          console.error('[StallWatchdog] 24/7 voice recovery failed:', error.message);
        });
        return;
      }

      if (isLocalIdle || isLavalinkIdle || (!serverQueue.player && !serverQueue.connection && serverQueue.is247)) {
        // 连续触发计数，防止无限循环
        serverQueue.stallWatchdogConsecutive = (serverQueue.stallWatchdogConsecutive || 0) + 1;
        if (serverQueue.stallWatchdogConsecutive > 5) {
          console.warn(`[StallWatchdog] guild=${guildId} 连续触发 ${serverQueue.stallWatchdogConsecutive} 次，停止重试`);
          serverQueue.queueEnded = true;
          savePlaybackState(guildId, serverQueue);
          return;
        }
        console.warn(`[StallWatchdog] guild=${guildId} 检测到播放卡死 (player=${isLocalIdle ? 'idle' : isLavalinkIdle ? 'lavalink-idle' : 'none'}, playing=${serverQueue.playing}, songs=${serverQueue.songs.length}, radio=${serverQueue.radio?.enabled}, consecutive=${serverQueue.stallWatchdogConsecutive}), 强制推进队列`);
        this.advance(guildId, serverQueue).catch(error => {
          console.error('[StallWatchdog] forced advance failed:', error.message);
        });
      }
    }, STALL_WATCHDOG_MS);
    stallTimers.set(guildId, timer);
  }

  static disarmStallWatchdog(guildId) {
    const existing = stallTimers.get(guildId);
    if (existing) {
      clearTimeout(existing);
      stallTimers.delete(guildId);
    }
  }

  static async playSong(guildId, textChannel, explicitSong = null, explicitSource = null, options = {}) {
    if (!this.operationIsValid(options)) return { ok: false, reason: 'stale' };
    if (!this.inTransition(guildId)) {
      if (explicitSong && !options.recoverySession) this.interruptPlaybackRecovery(guildId);
      return this.runTransition(guildId, () => this.playSong(guildId, textChannel, explicitSong, explicitSource, options));
    }
    const serverQueue = musicQueue.peek(guildId) || musicQueue.get(guildId);
    const actualBackend = this.activeBackend(serverQueue);
    const forceLocal = Boolean(
      options.forceLocal
      || serverQueue.lavalinkVoiceFallback
      || (explicitSong && explicitSong === serverQueue.currentSong && serverQueue.forceLocal)
      || (explicitSong && explicitSong === serverQueue.currentSong && actualBackend === 'local' && options.reconfigureLocal),
    );
    if (!forceLocal && this.shouldUseLavalink(explicitSong)) {
      return this.playSongLavalink(guildId, textChannel, explicitSong, explicitSource, options);
    }

    const timingStartedAt = PLAY_TIMING ? Date.now() : null;
    debugLog('[DEBUG] playSong 被调用, guildId:', guildId);
    if (serverQueue.clearingQueue) return;
    if (textChannel) {
      serverQueue.textChannel = textChannel;
      serverQueue.textChannelId = textChannel.id;
      serverQueue.guildRef ||= textChannel.guild || null;
    }

    // Invalidate the old playback before killing its resources. Late process
    // events must not be able to claim the new track.
    if (serverQueue.currentSong || serverQueue.playing || serverQueue.ffmpegProcess || serverQueue.ytdlpProcess) {
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: Boolean(serverQueue.currentSong) });
    }

    // 清理残留进程
    if (serverQueue.ffmpegProcess) {
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ffmpegProcess);
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ytdlpProcess);
      serverQueue.ytdlpProcess = null;
    }

    if (!explicitSong && serverQueue.songs.length === 0 && (!serverQueue.radio?.enabled || serverQueue.radioQueue.length === 0)) {
      await this.ensureRadioReadyForAutoplay(serverQueue);
    }

    if (!explicitSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0) {
      if (serverQueue.radio?.enabled) {
        serverQueue.radioFailureCount = (serverQueue.radioFailureCount || 0) + 1;
        if (serverQueue.radioFailureCount >= 5) {
          this.stopRadioAfterFailures(guildId, serverQueue, '自动续播连续未找到可播放歌曲');
        }
        serverQueue.playing = false;
        serverQueue.currentSong = null;
        serverQueue.seekOffsetSeconds = 0;
        serverQueue.startedAt = null;
        serverQueue.pausedAt = null;
        serverQueue.queueEnded = true;
        if (textChannel && serverQueue.radio?.enabled) {
          sendPlaybackNotice(serverQueue, textChannel, '📻 自动续播暂时没有找到可播放的推荐，请稍后再试或使用 /radio style 调整风格。');
        }
        this.cleanupProcesses(serverQueue);
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return;
      }
      serverQueue.playing = false;
      serverQueue.currentSong = null;
      serverQueue.player = null;
      serverQueue.audioResource = null;
      serverQueue.ffmpegProcess = null;
      serverQueue.ytdlpProcess = null;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      this.clearStreamStallWatchdog(serverQueue);
      if (serverQueue.is247) {
        savePlaybackState(guildId, serverQueue, { immediate: true });
      } else {
        this.scheduleIdleLeave(guildId, 'queue-ended');
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
      if (!serverQueue.queueEnded) {
        serverQueue.queueEnded = true;
      }
      this.cancelPlaybackWork(serverQueue);
      return;
    }

    let song = explicitSong;
    let source = explicitSource;
    let reservation = null;
    if (!song) {
      const next = await this.getNextSong(guildId, serverQueue);
      song = next?.song;
      source = next?.source;
      reservation = next?.reservation || null;
    }

    if (!song) {
      serverQueue.playing = false;
      serverQueue.queueEnded = true;
      this.cleanupProcesses(serverQueue);
      return;
    }

    reservation ||= serverQueue.reservedNext?.song === song ? serverQueue.reservedNext : null;
    if (reservation) ensureQueueItemId(song);
    const previousSong = serverQueue.currentSong;
    const previousPlaying = serverQueue.playing;
    const previousBackend = serverQueue.activeBackend;

    if (!isPlayableSongUrl(song.url)) {
      console.warn('[Player] skipped non-playable song URL:', song.title, song.url);
      this.removeQueueItemsById(serverQueue, [song.queueItemId]);
      this.releaseReservedSong(serverQueue, song);
      this.rememberSong(serverQueue, { ...song, skippedReason: 'non-playable-url' });
      serverQueue.playbackError = true;
      // 不能依赖 player.stop() 触发 Idle（player 可能已是 Idle），直接调用 advance
      this.advance(guildId, serverQueue);
      return;
    }

    const requestedSeekSeconds = Math.max(0, Number(options.seekSeconds) || 0);
    const recoverySeekSeconds = options.recovery
      ? this.recoverySeekSeconds(serverQueue, song, requestedSeekSeconds)
      : requestedSeekSeconds;
    if (options.recovery && recoverySeekSeconds === null) {
      this.releaseReservedSong(serverQueue, song);
      return this.advancePastExpiredRecovery(guildId, serverQueue, textChannel);
    }

    serverQueue.playbackId += 1;
    const playbackId = serverQueue.playbackId;
    serverQueue.terminalHandledPlaybackId = null;
    serverQueue.lavalinkConfirmedPlaybackId = null;
    serverQueue.startingBackend = 'local';
    serverQueue.activeBackend = null;
    serverQueue.skipRequested = false;
    if (!options.preserveRetryCount) {
      serverQueue.playbackRetryCount = 0;
      serverQueue.lastPlaybackError = null;
    }
    song.source = source || song.source || 'manual';
    serverQueue.forceLocal = forceLocal;
    serverQueue.forceYtdlpPipe = Boolean(options.forceYtdlpPipe || (song === previousSong && serverQueue.forceYtdlpPipe));
    serverQueue.localFallbackTried = Boolean(options.localFallbackTried || (song === previousSong && serverQueue.localFallbackTried));
    if (song.source === 'manual') {
      serverQueue.suppressRadioUntilManualQueueEnds = true;
    }
    serverQueue.currentSong = song;
    const attemptSignal = this.beginPlaybackAttempt(guildId, serverQueue, song, options);
    const unbindStartupCancellation = this.bindStartupCancellation(serverQueue, playbackId, options);
    ensurePanelRevision(serverQueue, song);
    serverQueue.streamDiagnostics = null;
    serverQueue.playing = false;
    serverQueue.stallWatchdogConsecutive = 0;
    serverQueue.queueEnded = false;
    serverQueue.idleReason = null;
    this.clearIdleLeaveTimer(serverQueue);

    try {
      if (!serverQueue.connection) {
        throw new Error('语音连接不存在');
      }

      await withPlaybackSignal(() => this.ensureLocalVoiceConnection(guildId, serverQueue, textChannel || serverQueue.textChannel, attemptSignal), attemptSignal);

      if (serverQueue.connection.state.status !== VoiceConnectionStatus.Ready) {
        console.log('[Voice] Playback waiting for Ready state, current:', serverQueue.connection.state.status);
        await withPlaybackSignal(() => entersState(serverQueue.connection, VoiceConnectionStatus.Ready, 15_000), attemptSignal);
      }
      timingLog(timingStartedAt, 'voice ready before stream setup');

      const markPlaybackError = (message, error = null) => {
        const source = message.startsWith('[yt-dlp') ? 'yt-dlp'
          : message.startsWith('[ffmpeg') ? 'ffmpeg'
            : 'unknown';
        if (!this.recordPlaybackError(guildId, serverQueue, playbackId, source, message, error)) return;
        if (error) {
          console.error(message, error.message);
        } else {
          console.error(message);
        }
        this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
        this.cleanupLocalProcesses(serverQueue);
        try {
          serverQueue.player?.stop(true);
        } catch {
          // The resource may already be idle after a process failure.
        }
        this.advance(guildId, serverQueue).catch(recoveryError => {
          console.error('[Player] advance after stream error failed:', safeErrorMessage(recoveryError));
        });
      };

      const directAudioUrl = serverQueue.forceYtdlpPipe ? null : freshAudioUrl(song);
      const streamDiagnostics = {
        playbackId,
        inputMode: directAudioUrl ? 'direct-url' : 'yt-dlp-pipe',
        ytdlpErrorOutput: '',
        ytdlpExitCode: null,
        ytdlpExitSignal: null,
        ffmpegErrorOutput: '',
        ffmpegExitCode: null,
        ffmpegExitSignal: null,
        bytesStreamed: 0,
        lastBytesAt: Date.now(),
        sourceEnded: false,
        audioStream: null,
      };
      serverQueue.streamDiagnostics = streamDiagnostics;

      let ytdlp = null;
      if (!directAudioUrl) {
        // 用 yt-dlp 获取音频流，通过 ffmpeg 转为 opus
        const ytdlpArgs = [
          '--js-runtimes', 'node',
          '--no-warnings',
          '--force-ipv4',
          '--socket-timeout', '20',
          '--retries', '2',
          '--fragment-retries', '2',
          '--file-access-retries', '2',
          '--retry-sleep', 'http:exp=1:10',
          '--retry-sleep', 'fragment:exp=1:8',
          '-f', 'bestaudio[ext=webm]/bestaudio',
          '-o', '-',
          '--no-playlist',
          '-q',
          ...cookieArgs(isBilibiliSongUrl(song.url) ? 'bilibili' : isYouTubeSongUrl(song.url) ? 'youtube' : 'none'),
          ...ytdlpHeaderArgs(song.url),
          song.url
        ];

        ytdlp = spawn('nice', ['-n', '-5', 'yt-dlp', ...ytdlpArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
        timingLog(timingStartedAt, 'yt-dlp spawned');

        ytdlp.stdout.on('error', (error) => {
          if (error.code !== 'EPIPE') {
            markPlaybackError('[yt-dlp stdout error]', error);
          }
        });

        ytdlp.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) {
            streamDiagnostics.ytdlpErrorOutput += `${msg}\n`;
            debugLog('[yt-dlp stderr]', msg);
          }
        });
      } else {
        timingLog(timingStartedAt, 'using cached audio url');
      }

      // 用 ffmpeg 将 yt-dlp 输出转为 Opus (Ogg 封装)
      const seekSeconds = recoverySeekSeconds;
      const ffmpegArgs = [
        ...(seekSeconds > 0 ? ['-ss', String(Math.floor(seekSeconds))] : []),
        ...(directAudioUrl ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
        '-i', directAudioUrl || 'pipe:0',
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-c:a', 'libopus',
        '-vbr', 'on',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-af', buildAudioFilter(100, normalizeFilterMode(serverQueue.filters?.active) || 'none'),
        '-f', 'ogg',
        'pipe:1'
      ];
      const ffmpeg = spawn('nice', ['-n', '-5', resolveFfmpegPath(), ...ffmpegArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
      timingLog(timingStartedAt, 'ffmpeg spawned');

      ffmpeg.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') {
          markPlaybackError('[ffmpeg stdin error]', error);
        }
      });

      ffmpeg.stdout.on('error', (error) => {
        if (error.code !== 'EPIPE') {
          markPlaybackError('[ffmpeg stdout error]', error);
        }
      });

      // 断流检测字节计数（被动监听，不影响既有 pipe 流向）
      ffmpeg.stdout.on('data', chunk => {
        streamDiagnostics.bytesStreamed += chunk.length;
        streamDiagnostics.lastBytesAt = Date.now();
      });

      if (ytdlp) {
        ytdlp.stdout.pipe(ffmpeg.stdin);
      }

      serverQueue.ytdlpProcess = ytdlp;
      serverQueue.ffmpegProcess = ffmpeg;

      // yt-dlp 出错时关闭 ffmpeg
      if (ytdlp) {
        ytdlp.on('error', (err) => {
          if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
          markPlaybackError('[yt-dlp process error]', err);
          this.terminateChildProcess(ffmpeg);
        });

        ytdlp.on('close', (code, signal) => {
          if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
          streamDiagnostics.ytdlpExitCode = code;
          streamDiagnostics.ytdlpExitSignal = signal;
          if (code !== 0 && !serverQueue.skipRequested) {
            // Preserve extractor text for classification; translate only at the
            // notification boundary. Warnings can precede the actual ERROR.
            markPlaybackError(`[yt-dlp] ${safeErrorMessage(streamDiagnostics.ytdlpErrorOutput)} (code ${code}${signal ? `, signal ${signal}` : ''})`);
          }
          if (!serverQueue.skipRequested && !ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
            ffmpeg.stdin.end();
          }
          serverQueue.ytdlpProcess = null;
        });
      }

      ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          streamDiagnostics.ffmpegErrorOutput += `${msg}\n`;
          debugLog('[ffmpeg stderr]', msg);
        }
      });

      ffmpeg.on('close', (code, signal) => {
        if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
        streamDiagnostics.ffmpegExitCode = code;
        streamDiagnostics.ffmpegExitSignal = signal;
        if (code === 0) streamDiagnostics.sourceEnded = true;
        if (code !== 0 && !serverQueue.skipRequested) {
          if (directAudioUrl) song.audioUrlExpiresAt = 0;
          const detail = summarizeProcessOutput(streamDiagnostics.ffmpegErrorOutput);
          markPlaybackError(`[ffmpeg] exited with code ${code}${signal ? `, signal ${signal}` : ''}${detail ? `: ${detail}` : ''}`);
        }
        serverQueue.ffmpegProcess = null;
      });

      ffmpeg.on('error', (err) => {
        if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
        markPlaybackError('[ffmpeg process error]', err);
      });

      const audioStream = ffmpeg.stdout.pipe(new PassThrough({ highWaterMark: AUDIO_STREAM_BUFFER_BYTES }));
      streamDiagnostics.audioStream = audioStream;
      const resource = createAudioResource(audioStream, {
        inputType: StreamType.OggOpus,
        inlineVolume: true,
        metadata: { playbackId, musicBotPlaybackId: playbackId },
      });
      resource.volume?.setVolume(this.effectiveVolume(serverQueue) / 100);
      serverQueue.audioResource = resource;
      timingLog(timingStartedAt, 'audio resource created');

      let localPlayer = serverQueue.player;
      if (!localPlayer) {
        localPlayer = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
          },
        });
        serverQueue.player = localPlayer;

        localPlayer.on('stateChange', (oldState, newState) => {
          debugLog('Player state:', oldState.status, '->', newState.status);
      if (newState.status === AudioPlayerStatus.Playing) {
            const startedPlaybackId = Number(newState.resource?.metadata?.musicBotPlaybackId);
            if (startedPlaybackId && this.isCurrentPlayback(serverQueue, startedPlaybackId)) {
              this.clearLocalStartTimer(serverQueue);
              serverQueue.activeBackend = 'local';
              serverQueue.startingBackend = null;
              serverQueue.playing = true;
              this.confirmPlaybackOutput(guildId, serverQueue, startedPlaybackId, 'local');
              console.log(`[Local] track start guild=${guildId} playbackId=${startedPlaybackId} title="${serverQueue.currentSong?.title || ''}"`);
              savePlaybackState(guildId, serverQueue, { immediate: true });
            }
          }
      if (newState.status === AudioPlayerStatus.Idle) {
            this.clearLocalStartTimer(serverQueue);
            const endedPlaybackId = Number(oldState.resource?.metadata?.musicBotPlaybackId);
            if (!endedPlaybackId || serverQueue.queueEnded || serverQueue.clearingQueue) return;
            if (this.isCurrentPlayback(serverQueue, endedPlaybackId)) serverQueue.startingBackend = null;
            if (!this.claimTerminal(serverQueue, endedPlaybackId, 'local-idle')) {
              debugLog(`[Player] ignored stale local idle playbackId=${endedPlaybackId} current=${serverQueue.playbackId}`);
              return;
            }
            serverQueue.playing = false;
            this.advance(guildId, serverQueue).catch(error => {
              console.error('[Player] advance after local idle failed:', error.message);
            });
          }
        });

      localPlayer.on('error', (error) => {
        console.error('Player error:', error);
        const errorPlaybackId = Number(error?.resource?.metadata?.playbackId) || null;
        if (!errorPlaybackId || !this.isCurrentPlayback(serverQueue, errorPlaybackId)) return;
        const diagnostics = serverQueue.streamDiagnostics?.playbackId === errorPlaybackId ? serverQueue.streamDiagnostics : null;
        const streamDetails = diagnostics
          ? `input=${diagnostics.inputMode || 'unknown'}, yt-dlp=${diagnostics.ytdlpExitCode ?? (diagnostics.inputMode === 'direct-url' ? 'skipped' : 'running')}${diagnostics.ytdlpExitSignal ? `/${diagnostics.ytdlpExitSignal}` : ''}, ffmpeg=${diagnostics.ffmpegExitCode ?? 'running'}${diagnostics.ffmpegExitSignal ? `/${diagnostics.ffmpegExitSignal}` : ''}`
          : 'process status unavailable';
        const processOutput = summarizeProcessOutput(diagnostics?.ytdlpErrorOutput || diagnostics?.ffmpegErrorOutput || '');
        const detail = `${error.message || 'Discord audio player error'} (${streamDetails}${processOutput ? `, ${processOutput}` : ''})`;
        const recorded = this.recordPlaybackError(guildId, serverQueue, errorPlaybackId, 'player', detail);
        if (recorded && this.claimTerminal(serverQueue, errorPlaybackId, 'local-player-error')) {
          this.advance(guildId, serverQueue);
        }
      });
      }

      if (!localPlayer) throw new Error('本地播放器初始化失败');

      debugLog('[DEBUG] Connection state before subscribe:', serverQueue.connection.state.status);
      const sub = serverQueue.connection.subscribe(localPlayer);
      if (!sub) {
        throw new Error('本地播放器未能订阅语音连接');
      }
      debugLog('[DEBUG] subscribe() returned:', sub ? 'subscription object' : 'null/undefined', 'connection state after:', serverQueue.connection.state.status);

      debugLog('[DEBUG] Calling player.play()...');
      localPlayer.once(AudioPlayerStatus.Playing, () => {
        const resourcePlaybackId = Number(localPlayer.state.resource?.metadata?.musicBotPlaybackId);
        if (resourcePlaybackId === playbackId && this.isCurrentPlayback(serverQueue, playbackId)) {
          timingLog(timingStartedAt, 'audio player reached playing');
          this.disarmStallWatchdog(guildId);
        }
      });
      await this.waitForPrebuffer(audioStream);
      timingLog(timingStartedAt, 'prebuffer ready');
      // 预缓冲期间可能被 skip/seek/换歌抢占，此时不能再起播旧 resource
      if (!this.isCurrentPlayback(serverQueue, playbackId)) {
        debugLog('[DEBUG] playback superseded during prebuffer, aborting play');
        return;
      }
      if (!this.operationIsValid(options) || attemptSignal.aborted) {
        // The command was revoked while the source was buffering. Do not start
        // audio that nobody is waiting for; drop its processes and song.
        this.cleanupLocalProcesses(serverQueue);
        serverQueue.audioResource = null;
        this.removeQueueItemsById(serverQueue, [song.queueItemId]);
        this.releaseReservedSong(serverQueue, song);
        serverQueue.currentSong = previousSong;
        serverQueue.playing = previousPlaying;
        serverQueue.activeBackend = previousBackend;
        serverQueue.startingBackend = null;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return { ok: false, reason: 'stale' };
      }
      if (serverQueue.player !== localPlayer) {
        debugLog('[DEBUG] local player was replaced during prebuffer, aborting play');
        return;
      }
      localPlayer.play(resource);
      timingLog(timingStartedAt, 'player.play called');
      markPlaybackStarted(serverQueue, seekSeconds);
      this.armLocalStartTimer(guildId, serverQueue, playbackId);
      this.armStreamStallWatchdog(guildId, serverQueue, playbackId);
      if (reservation) this.commitReservedSong(serverQueue, song);
      this.clearBackendUnavailable(serverQueue);
      serverQueue.activeBackend = 'local';
      serverQueue.startingBackend = null;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      if (song.source === 'manual') this.maybePrefillRadioQueue(guildId, serverQueue, 'manual playback');
      debugLog('[DEBUG] player.play() called, player state:', localPlayer.state.status);
      timingLog(timingStartedAt, 'audio resource started');

      if (!options.suppressNowPlaying && serverQueue.notificationMode !== 'private') {
        publishNowPlaying(guildId, textChannel || serverQueue.textChannel, serverQueue, song)
          .then(() => {
            timingLog(timingStartedAt, 'now-playing panel published');
            savePlaybackState(guildId, serverQueue);
          })
          .catch(error => {
            console.warn('[PlayerPanel] background publish failed:', error.message);
          });
      }
      savePlaybackState(guildId, serverQueue);
    } catch (error) {
      if (!this.isCurrentPlayback(serverQueue, playbackId) || attemptSignal.aborted) return;
      if (isLavalinkInfrastructureError(error)) {
        this.releaseReservedSong(serverQueue, song);
        serverQueue.currentSong = previousSong;
        serverQueue.playing = previousPlaying;
        serverQueue.activeBackend = previousBackend;
        serverQueue.startingBackend = null;
        serverQueue.forceLocal = Boolean(options.forceLocal || previousBackend === 'local');
        this.markBackendUnavailable(guildId, serverQueue, error, { pendingSong: song });
        return { ok: false, reason: 'backend-unavailable', error };
      }
      if (serverQueue.ffmpegProcess) {
        this.unpipeAudio(serverQueue);
        this.terminateChildProcess(serverQueue.ffmpegProcess);
        serverQueue.ffmpegProcess = null;
      }
      if (serverQueue.ytdlpProcess) {
        this.unpipeAudio(serverQueue);
        this.terminateChildProcess(serverQueue.ytdlpProcess);
        serverQueue.ytdlpProcess = null;
      }
      serverQueue.audioResource = null;

      console.error('========== 播放错误 ==========');
      console.error('歌曲:', song.title);
      console.error('URL:', song.url);
      console.error('错误类型:', error.name);
      console.error('错误信息:', error.message);
      console.error('================================');

      const errorMsg = safeErrorMessage(error.message || '未知错误');
      serverQueue.playing = false;
      if (this.isCurrentPlayback(serverQueue, playbackId)) serverQueue.startingBackend = null;
      if (!serverQueue.playbackError) {
        serverQueue.lastPlaybackError = {
          source: 'unknown',
          message: errorMsg,
          category: classifyPlaybackError(errorMsg).category,
          songTitle: song.title,
          songUrl: song.url,
          playbackId,
          progressSeconds: getPlaybackProgressSeconds(serverQueue),
          occurredAt: Date.now(),
        };
        serverQueue.playbackError = true;
      }

      // Invalidate before stop(), so the resulting Idle cannot advance this
      // playback after a replacement has already started.
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
      if (serverQueue.player && serverQueue.player.state.status !== AudioPlayerStatus.Idle) {
        serverQueue.player.stop(true);
      }
      this.removeQueueItemsById(serverQueue, [song?.queueItemId]);
      this.releaseReservedSong(serverQueue, song);
      this.advance(guildId, serverQueue).catch(recoveryError => {
        console.error('[Player] advance after local playback error failed:', safeErrorMessage(recoveryError));
      });
    } finally {
      unbindStartupCancellation();
    }
  }

  static async playSongLavalink(guildId, textChannel, explicitSong = null, explicitSource = null, options = {}) {
    if (!this.operationIsValid(options)) return { ok: false, reason: 'stale' };
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.playSongLavalink(guildId, textChannel, explicitSong, explicitSource, options));
    }
    const timingStartedAt = PLAY_TIMING ? Date.now() : null;
    const serverQueue = musicQueue.get(guildId);
    if (serverQueue.clearingQueue) return;
    if (textChannel) {
      serverQueue.textChannel = textChannel;
      serverQueue.textChannelId = textChannel.id;
      serverQueue.guildRef ||= textChannel.guild || null;
    }

    if (explicitSong || serverQueue.songs.length > 0) {
      serverQueue.suppressRadioUntilManualPlay = false;
      serverQueue.radioFailureCount = 0;
    }

    if (!explicitSong && serverQueue.songs.length === 0 && serverQueue.suppressRadioUntilManualPlay) {
      serverQueue.playing = false;
      serverQueue.currentSong = null;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      serverQueue.queueEnded = true;
      this.cleanupProcesses(serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return;
    }

    if (!explicitSong && serverQueue.songs.length === 0 && (!serverQueue.radio?.enabled || serverQueue.radioQueue.length === 0)) {
      await this.ensureRadioReadyForAutoplay(serverQueue);
    }

    if (!explicitSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0) {
      if (serverQueue.radio?.enabled) {
        serverQueue.radioFailureCount = (serverQueue.radioFailureCount || 0) + 1;
        if (serverQueue.radioFailureCount >= 5) {
          this.stopRadioAfterFailures(guildId, serverQueue, '自动续播连续未找到可播放歌曲');
        }
        serverQueue.playing = false;
        serverQueue.currentSong = null;
        serverQueue.seekOffsetSeconds = 0;
        serverQueue.startedAt = null;
        serverQueue.pausedAt = null;
        serverQueue.queueEnded = true;
        if (textChannel && serverQueue.radio?.enabled) {
          sendPlaybackNotice(serverQueue, textChannel, '📻 自动续播暂时没有找到可播放的推荐，请稍后再试或使用 /radio style 调整风格。');
        }
        this.cleanupProcesses(serverQueue);
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return;
      }
      serverQueue.playing = false;
      serverQueue.currentSong = null;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      if (serverQueue.is247) {
        savePlaybackState(guildId, serverQueue, { immediate: true });
      } else {
        this.scheduleIdleLeave(guildId, 'queue-ended');
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
      serverQueue.queueEnded = true;
      this.cleanupProcesses(serverQueue);
      return;
    }

    let song = explicitSong;
    let source = explicitSource;
    if (!song) {
      const next = await this.getNextSong(guildId, serverQueue);
      song = next?.song;
      source = next?.source;
    }

    if (!song) {
      serverQueue.playing = false;
      serverQueue.queueEnded = true;
      this.cleanupProcesses(serverQueue);
      return;
    }

    const sourceLabel = source || song.source || 'manual';
    let lavalinkUrl = isBilibiliSongUrl(song.url) ? freshAudioUrl(song) : (song.url || song.audioUrl);
    const isBilibiliDirectLavalink = isBilibiliSongUrl(song.url);
    const reservation = serverQueue.reservedNext?.song === song ? serverQueue.reservedNext : null;
    const previousSong = serverQueue.currentSong;
    const previousPlaying = serverQueue.playing;
    const previousBackend = serverQueue.activeBackend;
    const startKey = `${lavalinkUrl || song.url || song.title || 'unknown'}:${sourceLabel}:${Number(options.seekSeconds) || 0}:${song.queueItemId || ''}`;
    if (serverQueue.lavalinkStarting && serverQueue.lavalinkStartKey === startKey) {
      debugLog('[Lavalink] duplicate play request suppressed:', song.title);
      return;
    }
    if (serverQueue.currentSong || serverQueue.playing || serverQueue.lavalinkPlayer) {
      this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: Boolean(serverQueue.currentSong) });
    }
    serverQueue.lavalinkStarting = true;
    serverQueue.lavalinkStartKey = startKey;
    serverQueue.lavalinkLastStart = { key: startKey, at: Date.now() };
    const playbackGeneration = this.nextPlaybackGeneration(serverQueue);

    if (!isPlayableSongUrl(song.url)) {
      console.warn('[Lavalink] skipped non-playable song URL:', song.title, song.url);
      this.removeQueueItemsById(serverQueue, [song.queueItemId]);
      this.releaseReservedSong(serverQueue, song);
      this.rememberSong(serverQueue, { ...song, skippedReason: 'non-playable-url' });
      serverQueue.playbackError = true;
      const player = getLavalinkPlayer(guildId);
      if (player) await player.stopPlaying(true, false).catch(() => {});
      try {
        await this.advance(guildId, serverQueue);
        return;
      } finally {
        this.resetLavalinkStart(serverQueue, startKey);
      }
    }

    if (!isBilibiliDirectLavalink && !isLavalinkSupportedUrl(song.url)) {
      this.resetLavalinkStart(serverQueue, startKey);
      return this.playSong(guildId, textChannel, song, source, options);
    }

    const requestedSeekSeconds = Math.max(0, Number(options.seekSeconds) || 0);
    const recoverySeekSeconds = options.recovery
      ? this.recoverySeekSeconds(serverQueue, song, requestedSeekSeconds)
      : requestedSeekSeconds;
    if (options.recovery && recoverySeekSeconds === null) {
      this.resetLavalinkStart(serverQueue, startKey);
      return this.advancePastExpiredRecovery(guildId, serverQueue, textChannel);
    }

    serverQueue.playbackId += 1;
    const playbackId = serverQueue.playbackId;
    serverQueue.terminalHandledPlaybackId = null;
    serverQueue.lavalinkConfirmedPlaybackId = null;
    serverQueue.startingBackend = 'lavalink';
    serverQueue.activeBackend = null;
    serverQueue.skipRequested = false;
    serverQueue.forceLocal = false;
    serverQueue.forceYtdlpPipe = false;
    serverQueue.localFallbackTried = Boolean(options.localFallbackTried);
    if (!options.preserveRetryCount) {
      serverQueue.playbackRetryCount = 0;
      serverQueue.lastPlaybackError = null;
    }
    song.source = sourceLabel;
    if (sourceLabel === 'manual') {
      serverQueue.suppressRadioUntilManualQueueEnds = true;
    }
    serverQueue.currentSong = song;
    const attemptSignal = this.beginPlaybackAttempt(guildId, serverQueue, song, options);
    const unbindStartupCancellation = this.bindStartupCancellation(serverQueue, playbackId, options);
    serverQueue.streamDiagnostics = { playbackId, inputMode: 'lavalink', startPositionSeconds: recoverySeekSeconds };
    serverQueue.playing = false;
    serverQueue.stallWatchdogConsecutive = 0;
    serverQueue.queueEnded = false;
    serverQueue.idleReason = null;
    this.clearIdleLeaveTimer(serverQueue);

    try {
      if (isBilibiliDirectLavalink) {
        await withPlaybackSignal(() => this.refreshBilibiliAudioUrl(song, attemptSignal), attemptSignal);
        lavalinkUrl = freshAudioUrl(song);
        if (!lavalinkUrl) throw new Error('Bilibili 当前无法取得可用音频直链');
      }
      const voiceChannelId = serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId;
      if (!voiceChannelId) throw new Error('语音连接不存在');

      const switchedVoiceBackend = await withPlaybackSignal(() => this.ensureLavalinkVoiceConnection(guildId, serverQueue), attemptSignal);
      const player = await withPlaybackSignal(() => createOrGetLavalinkPlayer({
        guildId,
        voiceChannelId,
        textChannelId: serverQueue.textChannelId,
        volume: this.effectiveVolume(serverQueue),
        signal: attemptSignal,
      }), attemptSignal);
      const connection = lavalinkConnectionShim(voiceChannelId, player);
      if (!connection) throw new NoLavalinkNodeError('Lavalink player voice state is not ready');
      serverQueue.connection = connection;
      serverQueue.lavalinkPlayer = player;
      if (switchedVoiceBackend) {
        serverQueue.suppressVoiceRecoveryUntil = Date.now() + VOICE_TRANSITION_SETTLE_MS;
      }
      timingLog(timingStartedAt, 'lavalink player ready');

      if (isBilibiliDirectLavalink) {
        console.log(`[Bilibili] using direct audio URL via Lavalink: ${song.title}`);
      }
      const result = await withPlaybackSignal(() => player.search({ query: lavalinkUrl }, song.requestedBy || 'system'), attemptSignal);
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      const track = result?.tracks?.[0];
      if (!track) throw new Error(result?.exception?.message || 'Lavalink 未找到可播放音轨');
      track.userData = {
        ...(track.userData || {}),
        musicBotPlaybackId: playbackId,
        musicBotPlatform: isBilibiliDirectLavalink ? 'bilibili' : 'youtube',
      };

      const seekSeconds = recoverySeekSeconds;
      const seekPositionMs = Math.floor(seekSeconds * 1000);
      await withPlaybackSignal(() => applyLavalinkFilter(player, normalizeFilterMode(serverQueue.filters?.active) || 'none'), attemptSignal);
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      await withPlaybackSignal(() => player.setVolume(this.effectiveVolume(serverQueue), true), attemptSignal);
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      serverQueue.pendingNowPlaying = {
        playbackId,
        suppress: Boolean(options.suppressNowPlaying),
        seekSeconds,
      };
      this.armLavalinkStartTimer(guildId, serverQueue, playbackId);
      await withPlaybackSignal(() => player.play({
        clientTrack: track,
        position: seekPositionMs,
        volume: this.effectiveVolume(serverQueue),
      }), attemptSignal);
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      if (reservation) this.commitReservedSong(serverQueue, song);
      this.clearBackendUnavailable(serverQueue);
      serverQueue.activeBackend = 'lavalink';
      timingLog(timingStartedAt, 'lavalink play called');
    } catch (error) {
      if (!this.isCurrentPlayback(serverQueue, playbackId) || attemptSignal.aborted) return;
      this.clearLavalinkStartTimer(serverQueue);
      if (serverQueue.pendingNowPlaying?.playbackId === playbackId) serverQueue.pendingNowPlaying = null;
      if (this.isCurrentPlayback(serverQueue, playbackId)) serverQueue.startingBackend = null;
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      const safePlaybackError = safeErrorMessage(error.message || 'Lavalink 播放失败');
      console.error('[Lavalink] playback error:', safePlaybackError);
      if (isLavalinkInfrastructureError(error)) {
        this.releaseReservedSong(serverQueue, song);
        serverQueue.currentSong = previousSong;
        serverQueue.playing = previousPlaying;
        serverQueue.activeBackend = previousBackend;
        serverQueue.startingBackend = null;
        this.markBackendUnavailable(guildId, serverQueue, error, { pendingSong: song });
        return { ok: false, reason: 'backend-unavailable', error };
      }
      this.recordPlaybackError(guildId, serverQueue, playbackId, 'lavalink', safePlaybackError);
      const progressSeconds = this.lavalinkProgressSeconds(serverQueue);
      if (this.retryLavalinkTrack(guildId, serverQueue, song, safePlaybackError, progressSeconds, Boolean(options.suppressNowPlaying))) return;
      if (this.shouldFallbackLavalinkToLocal(song, options.localFallbackTried)) {
        return this.fallbackLavalinkToLocal(guildId, serverQueue, song, sourceLabel, {
          message: safePlaybackError,
          progressSeconds,
          suppressNowPlaying: Boolean(options.suppressNowPlaying),
        });
      }
      serverQueue.playing = false;
      if (!serverQueue.playbackError) {
        serverQueue.lastPlaybackError = {
          source: 'lavalink',
          message: safePlaybackError,
          songTitle: song.title,
          songUrl: song.url,
          playbackId,
          progressSeconds,
          occurredAt: Date.now(),
        };
        serverQueue.playbackError = true;
      }
      if (song.source !== 'radio') serverQueue.suppressRadioUntilManualPlay = true;
      if (this.shouldStopAfterLavalinkFailures(guildId, serverQueue, safePlaybackError)) return;
      this.removeQueueItemsById(serverQueue, [song?.queueItemId]);
      this.releaseReservedSong(serverQueue, song);
      await this.advance(guildId, serverQueue);
    } finally {
      unbindStartupCancellation();
      this.resetLavalinkStart(serverQueue, startKey);
    }
  }

  static shouldStopAfterLavalinkFailures(guildId, serverQueue, message = '') {
    serverQueue.lavalinkFailureCount = (serverQueue.lavalinkFailureCount || 0) + 1;
    if (serverQueue.lavalinkFailureCount < MAX_LAVALINK_CONSECUTIVE_FAILURES) return false;

    const reason = safeErrorMessage(String(message).split('\n')[0].slice(0, 180));
    console.warn(`[Lavalink] stopping queue after ${serverQueue.lavalinkFailureCount} consecutive failures: ${reason}`);
    sendPlaybackNotice(serverQueue, serverQueue.textChannel, `⚠️ Lavalink 连续播放失败，已停止自动跳歌并关闭 Radio，以避免面板继续跳转。\n原因：${reason}\n请稍后再试，或换一个音源。`);

    // A backend outage is not a user queue operation. Preserve the current
    // song and every manually queued item so recovery can resume them.
    this.markBackendUnavailable(guildId, serverQueue, new Error(reason), {
      pendingSong: serverQueue.currentSong,
    });
    getLavalinkPlayer(guildId)?.stopPlaying(false, false).catch(error => {
      console.error('[Lavalink] stop after failures failed:', error.message);
    });
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return true;
  }

  static handleLavalinkTrackEnd(guildId, _player = null, _track = null, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const reason = String(payload?.reason || '').toLowerCase();
    const playbackId = this.lavalinkPlaybackId(_track);
    if (!playbackId) return;
    if (!['finished', 'loadfailed', 'cleanup'].includes(reason)) {
      debugLog(`[Lavalink] trackEnd ignored reason="${reason}" guild=${guildId}`);
      return;
    }
    if (reason === 'loadfailed') {
      this.handleLavalinkFailure(guildId, playbackId, 'Lavalink 音轨载入失败', 'load-failed').catch(error => {
        console.error('[Lavalink] load-failed recovery failed:', error.message);
      });
      return;
    }
    serverQueue.lavalinkFailureCount = 0;
    serverQueue.radioFailureCount = 0;
    this.resetLavalinkStart(serverQueue);
    if (reason === 'finished') {
      this.deferLavalinkFinish(guildId, serverQueue, playbackId, 'lavalink-finished');
      return;
    }
    if (!this.claimTerminal(serverQueue, playbackId, 'lavalink-cleanup')) return;
    serverQueue.playing = false;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after track cleanup failed:', error.message);
    });
  }

  static handleLavalinkTrackStart(guildId, _player = null, track = null, _payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const playbackId = this.lavalinkPlaybackId(track);
    if (!playbackId || !this.isCurrentPlayback(serverQueue, playbackId) || serverQueue.playbackAttemptController?.signal.aborted) return;
    if (serverQueue.terminalHandledPlaybackId === playbackId) return;

    this.clearLavalinkStartTimer(serverQueue);
    serverQueue.lavalinkConfirmedPlaybackId = playbackId;
    serverQueue.activeBackend = 'lavalink';
    serverQueue.startingBackend = null;
    serverQueue.playing = true;
    this.disarmStallWatchdog(guildId);

    const pending = serverQueue.pendingNowPlaying?.playbackId === playbackId
      ? serverQueue.pendingNowPlaying
      : null;
    markPlaybackStarted(serverQueue, pending?.seekSeconds || 0);
    savePlaybackState(guildId, serverQueue, { immediate: true });
    if (serverQueue.currentSong?.source === 'manual') {
      this.maybePrefillRadioQueue(guildId, serverQueue, 'manual lavalink playback');
    }
    if (!pending?.suppress && serverQueue.notificationMode !== 'private') {
      publishNowPlaying(guildId, serverQueue.textChannel, serverQueue, serverQueue.currentSong)
        .then(() => savePlaybackState(guildId, serverQueue))
        .catch(error => console.warn('[PlayerPanel] background publish failed:', error.message));
    }
    serverQueue.pendingNowPlaying = null;
  }

  static handleLavalinkPlayerUpdate(guildId, player) {
    const queue = musicQueue.peek(guildId);
    const playbackId = this.lavalinkPlaybackId(player?.queue?.current);
    if (!queue || !this.isCurrentPlayback(queue, playbackId) || queue.activeBackend !== 'lavalink' || player.paused
      || queue.playbackAttemptController?.signal.aborted) return;
    // Use the server-reported position, not lavalink-client's extrapolated clock.
    if (Number(player.lastPosition) > (Number(queue.seekOffsetSeconds) || 0) * 1000 + 500) {
      if (queue.streamDiagnostics) queue.streamDiagnostics.confirmedPositionMs = Number(player.lastPosition);
      this.confirmPlaybackOutput(guildId, queue, playbackId, 'lavalink');
    }
  }

  static handleLavalinkQueueEnd(guildId, _player = null, _track = null, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    const reason = String(payload?.reason || '').toLowerCase();
    console.log(`[Lavalink] queue end observed guild=${guildId} exists=${Boolean(serverQueue)} queueEnded=${Boolean(serverQueue?.queueEnded)} clearing=${Boolean(serverQueue?.clearingQueue)} reason=${reason || 'unknown'} radio=${Boolean(serverQueue?.radio?.enabled)} radioQueue=${serverQueue?.radioQueue?.length ?? 'n/a'} songs=${serverQueue?.songs?.length ?? 'n/a'} current="${serverQueue?.currentSong?.title || ''}" playbackError=${Boolean(serverQueue?.playbackError)} retry=${serverQueue?.playbackRetryCount ?? 'n/a'}`);

    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const playbackId = this.lavalinkPlaybackId(_track);
    if (!playbackId) return;
    if (reason === 'loadfailed') {
      this.handleLavalinkFailure(guildId, playbackId, 'Lavalink 队列载入失败', 'queue-load-failed').catch(error => {
        console.error('[Lavalink] queue load-failed recovery failed:', error.message);
      });
      return;
    }
    if (!['finished', 'cleanup'].includes(reason)) return;
    if (reason === 'finished') {
      this.deferLavalinkFinish(guildId, serverQueue, playbackId, 'lavalink-queue-finished');
      return;
    }
    if (!this.claimTerminal(serverQueue, playbackId, 'lavalink-queue-cleanup')) return;
    serverQueue.playing = false;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after queue end failed:', error.message);
    });
  }

  static handleLavalinkTrackError(guildId, _player = null, track = null, payload = {}) {
    const message = payload?.exception?.message || payload?.error || 'Lavalink 音轨播放失败';
    const playbackId = this.lavalinkPlaybackId(track);
    if (!playbackId) return;
    this.handleLavalinkFailure(guildId, playbackId, message, 'track-error').catch(error => {
      console.error('[Lavalink] track error recovery failed:', error.message);
    });
  }

  static handleLavalinkTrackStuck(guildId, _player = null, track = null, payload = {}) {
    const message = `Lavalink 音轨卡住超过 ${payload?.thresholdMs || 'unknown'}ms`;
    const playbackId = this.lavalinkPlaybackId(track);
    if (!playbackId) return;
    this.handleLavalinkFailure(guildId, playbackId, message, 'track-stuck').catch(error => {
      console.error('[Lavalink] track stuck recovery failed:', error.message);
    });
  }

  static handleLavalinkSocketClosed(guildId, _player = null, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.activeBackend !== 'lavalink' || !serverQueue.playing) return;
    const playbackId = serverQueue.playbackId;
    setTimeout(() => {
      if (!this.isCurrentPlayback(serverQueue, playbackId) || serverQueue.activeBackend !== 'lavalink') return;
      const player = getLavalinkPlayer(guildId);
      const botVoice = serverQueue.guildRef?.members?.me?.voice;
      const botStillInExpectedChannel = botVoice
        ? botVoice.channelId === serverQueue.voiceChannelId
        : true;
      if (botStillInExpectedChannel && player?.connected && (player.playing || player.paused)) return;
      const message = `Lavalink 语音连接关闭 code=${payload?.code || 'unknown'}`;
      this.handleLavalinkFailure(guildId, playbackId, message, 'socket-closed').catch(error => {
        console.error('[Lavalink] socket-close recovery failed:', error.message);
      });
    }, 5000);
  }

  static handleLavalinkNodeDisconnect() {
    for (const [guildId, serverQueue] of musicQueue.entries()) {
      const activeBackend = this.activeBackend(serverQueue);
      const usesLavalink = activeBackend === 'lavalink'
        || serverQueue.connection?.type === 'lavalink';
      if (!usesLavalink) continue;
      const player = getLavalinkPlayer(guildId);
      if (serverQueue.currentSong) {
        // A disconnected node is no longer 'active' according to the health
        // check. Freeze at the last confirmed server position; when output was
        // never confirmed, fall back to the elapsed playback clock so an outage
        // is never counted as played audio.
        const wasPaused = Boolean(serverQueue.pausedAt || serverQueue.currentSong.playbackPaused);
        const confirmedPositionMs = serverQueue.streamDiagnostics?.outputConfirmed
          ? Number(player?.lastPosition ?? serverQueue.streamDiagnostics?.confirmedPositionMs)
          : NaN;
        const positionSeconds = Number.isFinite(confirmedPositionMs) && confirmedPositionMs >= 0
          ? confirmedPositionMs / 1000
          : getPlaybackProgressSeconds(serverQueue);
        freezePlaybackProgress(serverQueue, positionSeconds);
        if (wasPaused) {
          serverQueue.pausedAt = Date.now();
          this.setSongPausedState(serverQueue, true);
        }
      }
      serverQueue.playing = false;
      serverQueue.activeBackend = null;
      serverQueue.startingBackend = null;
      serverQueue.connection = null;
      serverQueue.lavalinkPlayer = null;
      serverQueue.lavalinkInterrupted = true;
      serverQueue.backendUnavailable = true;
      serverQueue.playbackBlocked = true;
      serverQueue.pendingRecovery = {
        guildId,
        playbackId: serverQueue.playbackId,
        songId: serverQueue.currentSong?.queueItemId || null,
        reason: 'Lavalink 节点断开',
        at: Date.now(),
      };
      this.clearLavalinkStartTimer(serverQueue);
      this.scheduleLavalinkRecovery(guildId, serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
    }
  }

  static async handleLavalinkNodeReady({ resumed = false } = {}) {
    for (const [guildId, serverQueue] of musicQueue.entries()) {
      const hasRecoveryWork = Boolean(
        serverQueue.currentSong
        || serverQueue.songs.length > 0
        || serverQueue.radioQueue.length > 0
        || serverQueue.radio?.enabled
        || serverQueue.is247
      );
      if ((!serverQueue.lavalinkInterrupted && !serverQueue.backendUnavailable) || !hasRecoveryWork) continue;
      try {
        const lifecycleGeneration = serverQueue.lifecycleGeneration;
        serverQueue.lavalinkInterrupted = false;
        if (!resumed) {
          await destroyLavalinkPlayer(guildId, 'node-session-lost');
          serverQueue.connection = null;
          serverQueue.lavalinkPlayer = null;
        }
        if (musicQueue.peek(guildId) !== serverQueue || serverQueue.lifecycleGeneration !== lifecycleGeneration) continue;
        const restored = await this.recoverBackendUnavailable(guildId, serverQueue);
        if (musicQueue.peek(guildId) !== serverQueue || serverQueue.lifecycleGeneration !== lifecycleGeneration) continue;
        if (restored) {
          this.clearBackendUnavailable(serverQueue);
        } else {
          serverQueue.lavalinkInterrupted = true;
          serverQueue.backendUnavailable = true;
          serverQueue.playbackBlocked = true;
          this.scheduleLavalinkRecovery(guildId, serverQueue);
        }
      } catch (error) {
        serverQueue.lavalinkInterrupted = true;
        serverQueue.backendUnavailable = true;
        serverQueue.playbackBlocked = true;
        this.scheduleLavalinkRecovery(guildId, serverQueue);
        console.error(`[Lavalink] guild=${guildId} node recovery failed:`, error.message);
      }
    }
  }

  static async recoverBackendUnavailable(guildId, serverQueue) {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.recoverBackendUnavailable(guildId, serverQueue), { createQueue: false });
    }
    if (!serverQueue?.backendUnavailable || serverQueue.clearingQueue) return false;
    const lifecycleGeneration = serverQueue.lifecycleGeneration;
    if (!serverQueue.connection && serverQueue.voiceChannelRef && serverQueue.guildRef) {
      serverQueue.connection = await this.joinVoice(
        serverQueue.voiceChannelRef,
        guildId,
        serverQueue.guildRef.voiceAdapterCreator,
      );
    }
    if (musicQueue.peek(guildId) !== serverQueue || serverQueue.lifecycleGeneration !== lifecycleGeneration) return false;
    if (serverQueue.pausedByEmptyChannel) return true;
    if (!serverQueue.currentSong
      && serverQueue.songs.length === 0
      && serverQueue.radioQueue.length === 0
      && !serverQueue.radio?.enabled) return true;
    const result = serverQueue.currentSong
      ? await this.ensurePlaybackOutput(guildId, 'backend-recovery', { force: true })
      : await this.playSong(guildId, serverQueue.textChannel);
    return result !== false && result?.reason !== 'backend-unavailable';
  }

  static cleanupProcesses(serverQueue) {
    this.cancelPlaybackWork(serverQueue);
    this.cleanupLocalProcesses(serverQueue);
  }

  static async ensurePlaybackOutput(guildId, reason = 'voice-activity', { force = false } = {}) {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.ensurePlaybackOutput(guildId, reason, { force }));
    }
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.pendingPlaybackRecovery || serverQueue.backendTransitioning || serverQueue.startingBackend) return true;
    if (serverQueue.backendUnavailable && isLavalinkEnabled()) {
      const lavalinkPlayer = getLavalinkPlayer(guildId);
      if (!lavalinkPlayer && !force) {
        this.scheduleLavalinkRecovery(guildId, serverQueue);
        return false;
      }
    }
    const backend = this.activeBackend(serverQueue);
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!serverQueue?.currentSong || serverQueue.clearingQueue) return false;
      if (serverQueue.lavalinkStarting || serverQueue.lavalinkStartKey) return true;
      if (player && isLavalinkPlayerReady(player, player.node, serverQueue.voiceChannelId)
        && (player.playing || player.paused) && player.queue?.current) {
        serverQueue.activeBackend = 'lavalink';
        serverQueue.playing = !player.paused;
        serverQueue.startingBackend = null;
        if (player.paused) {
          freezePlaybackProgress(serverQueue, Math.max(0, Number(player.position) || 0) / 1000);
          serverQueue.pausedAt ||= Date.now();
          this.setSongPausedState(serverQueue, true);
        } else {
          markPlaybackStarted(serverQueue, Math.max(0, Number(player.position) || 0) / 1000);
          this.setSongPausedState(serverQueue, false);
        }
        savePlaybackState(guildId, serverQueue, { immediate: true });
        this.clearBackendUnavailable(serverQueue);
        return true;
      }
      if (!force && Date.now() - (serverQueue.lastOutputRecoveryAt || 0) < 5000) return true;
      try {
        serverQueue.lastOutputRecoveryAt = Date.now();
        const resumeSeconds = getPlaybackResumeSeconds(serverQueue);
        if (resumeSeconds === null) {
          console.warn(`[Lavalink] guild=${guildId} persisted position reached song duration; advancing instead of seeking past the end`);
          this.clearFinishedCurrentSong(serverQueue, { remember: true });
          serverQueue.queueEnded = false;
          if (!this.hasPendingPlayback(serverQueue)) {
            savePlaybackState(guildId, serverQueue, { immediate: true });
            return false;
          }
          await this.playSong(guildId, serverQueue.textChannel);
          return this.isPlaybackActuallyActive(serverQueue);
        }
      const recoverySong = serverQueue.currentSong;
      const previousPlaybackId = serverQueue.playbackId;
      const wasPaused = Boolean(serverQueue.pausedAt || serverQueue.currentSong?.playbackPaused);
      await this.playSong(guildId, serverQueue.textChannel, recoverySong, recoverySong.source || 'manual', {
        seekSeconds: resumeSeconds,
        suppressNowPlaying: true,
        recovery: true,
      });
      const started = await this.waitForPlaybackStart(guildId, recoverySong, 12_000);
      const recoveredPlaybackId = serverQueue.playbackId;
      if (started && wasPaused && recoveredPlaybackId > previousPlaybackId && this.isCurrentPlayback(serverQueue, recoveredPlaybackId)) {
        const paused = await this.pause(guildId);
        if (!paused) return false;
      }
      return started;
      } catch (error) {
        console.error('[Lavalink] playback output recovery failed:', error.message);
        return false;
      }
    }
    if (!serverQueue?.connection || serverQueue.connection.type === 'lavalink' || !serverQueue.currentSong || serverQueue.clearingQueue) return false;

    try {
      if (serverQueue.player) {
        serverQueue.connection.subscribe(serverQueue.player);
        debugLog('[Voice] Re-subscribed player after', reason);
      }

      const status = serverQueue.player?.state?.status;
      if (serverQueue.playing && status && status !== AudioPlayerStatus.Idle) {
        return true;
      }

      const recoverySong = serverQueue.currentSong;
      const wasPaused = Boolean(serverQueue.pausedAt || serverQueue.currentSong?.playbackPaused);
      const previousPlaybackId = serverQueue.playbackId;
      const resumeSeconds = getPlaybackResumeSeconds(serverQueue);
      if (resumeSeconds === null) {
        await this.advancePastExpiredRecovery(guildId, serverQueue, serverQueue.textChannel);
        return false;
      }
      await this.playSong(guildId, serverQueue.textChannel, recoverySong, recoverySong.source || 'manual', {
        seekSeconds: resumeSeconds,
        suppressNowPlaying: true,
        recovery: true,
      });
      const started = await this.waitForPlaybackStart(guildId, recoverySong, 12_000);
      const recoveredPlaybackId = serverQueue.playbackId;
      if (started && wasPaused && recoveredPlaybackId > previousPlaybackId && this.isCurrentPlayback(serverQueue, recoveredPlaybackId)) {
        const paused = await this.pause(guildId);
        if (!paused) return false;
      }
      return started;
    } catch (error) {
      console.error('[Voice] playback output recovery failed:', error.message);
      return false;
    }
  }

  static async waitForPlaybackStart(guildId, song, timeoutMs = 12_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const serverQueue = musicQueue.peek(guildId);
      if (!serverQueue) return false;
      const backend = this.activeBackend(serverQueue);
      const lavalinkPlayer = backend === 'lavalink' ? getLavalinkPlayer(guildId) : null;
      const confirmed = backend === 'lavalink'
        ? Boolean(lavalinkPlayer?.playing && !lavalinkPlayer?.paused)
        : serverQueue.player?.state?.status === AudioPlayerStatus.Playing;
      if (confirmed
        && (!song || serverQueue.currentSong?.url === song.url)) return true;
      if (song && serverQueue.currentSong && serverQueue.currentSong.url !== song.url) return false;
      await sleep(100);
    }
    return false;
  }

  static clearIdleLeaveTimer(serverQueue) {
    if (serverQueue?.idleLeaveTimer) {
      clearTimeout(serverQueue.idleLeaveTimer);
      serverQueue.idleLeaveTimer = null;
    }
    if (serverQueue) serverQueue.idleReason = null;
  }

  static scheduleIdleLeave(guildId, reason = 'idle') {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.is247 || serverQueue.clearingQueue) return false;

    this.disarmStallWatchdog(guildId);
    this.clearIdleLeaveTimer(serverQueue);
    serverQueue.idleReason = reason;
    serverQueue.idleLeaveTimer = setTimeout(() => {
      this.clearQueueAndLeave(guildId, reason, { notify: false }).catch(error => {
        console.error('[Player] idle cleanup failed:', error.message);
      });
    }, IDLE_TIMEOUT_MS);
    savePlaybackState(guildId, serverQueue);
    return true;
  }

  static markActivity(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.is247 || serverQueue.clearingQueue) return false;
    if (!serverQueue.idleLeaveTimer) return false;

    const reason = serverQueue.idleReason || 'idle';
    this.scheduleIdleLeave(guildId, reason);
    return true;
  }

  static async clearQueueAndLeave(guildId, reason = 'idle', { notify = true, keepConnectionFor247 = true } = {}) {
    if (!this.inTransition(guildId)) {
      this.interruptPlaybackRecovery(guildId);
      return this.runTransition(guildId, () => this.clearQueueAndLeave(guildId, reason, { notify, keepConnectionFor247 }), { createQueue: false });
    }
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.clearingQueue) return false;

    serverQueue.clearingQueue = true;
    const lifecycleGeneration = randomUUID();
    serverQueue.lifecycleGeneration = lifecycleGeneration;
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: false });
    const backend = this.activeBackend(serverQueue);
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    this.clearLavalinkStartTimer(serverQueue);
    this.clearLocalStartTimer(serverQueue);
    serverQueue.reservedNext = null;
    invalidateRadioGeneration(serverQueue, 'queue-cleared');
    this.disarmStallWatchdog(guildId);
    this.clearIdleLeaveTimer(serverQueue);
    this.cancelRecoveryTimers(serverQueue);
    this.cleanupProcesses(serverQueue);

    try {
      serverQueue.player?.stop(true);
    } catch {
      // Ignore player stop failures during cleanup.
    }

    if (backend === 'lavalink') {
      await getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(error => {
        console.warn('[Lavalink] stop during queue cleanup failed:', safeErrorMessage(error));
      });
    }

    serverQueue.songs = [];
    serverQueue.radioQueue = [];
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    serverQueue.suppressRadioUntilManualQueueEnds = false;
    this.resetLavalinkStart(serverQueue);
    serverQueue.currentSong = null;
    serverQueue.playing = false;
    serverQueue.activeBackend = null;
    serverQueue.startingBackend = null;
    serverQueue.player = null;
    serverQueue.audioResource = null;
    serverQueue.queueEnded = false;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
    serverQueue.pausedByEmptyChannel = false;

    if (!(serverQueue.is247 && keepConnectionFor247)) {
      // Lavalink configuration does not imply the current connection is a shim:
      // fallback may have installed a real @discordjs/voice connection.
      const connection = serverQueue.connection;
      if (isLavalinkEnabled() || connection?.type === 'lavalink') {
        await destroyLavalinkPlayer(guildId, reason);
      }
      if (connection && connection.type !== 'lavalink') {
        try {
          connection.destroy();
        } catch (error) {
          console.error('[Voice] destroy connection failed:', error.message);
        }
      }
      if (serverQueue.connection === connection) serverQueue.connection = null;
    }

    if (notify && serverQueue.textChannel) {
      const message = reason === 'empty-channel'
        ? '👋 语音频道 30 分钟无人或无新指令，已离开并清空队列。'
        : reason === 'bot-disconnected'
          ? '👋 我已离开语音频道，播放队列已清空。'
          : '👋 30 分钟内没有新指令，已离开语音频道并清空队列。';
      sendToChannel(serverQueue.textChannel, message);
    }

    if (serverQueue.is247 && keepConnectionFor247 && musicQueue.peek(guildId) === serverQueue) {
      serverQueue.clearingQueue = false;
      serverQueue.backendUnavailable = false;
      serverQueue.playbackBlocked = false;
      serverQueue.pendingRecovery = null;
      savePlaybackState(guildId, serverQueue, { immediate: true });
    } else {
      if (musicQueue.peek(guildId) === serverQueue && serverQueue.lifecycleGeneration === lifecycleGeneration) {
        serverQueue.disposed = true;
        musicQueue.delete(guildId);
        deletePlaybackState(guildId);
      }
    }
    return true;
  }

  static async destroyVoiceConnection(guildId, serverQueue, { keepQueue = true } = {}) {
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: true });
    const backend = this.activeBackend(serverQueue);
    this.cleanupProcesses(serverQueue);
    serverQueue.playing = false;
    serverQueue.startingBackend = null;
    serverQueue.player = null;
    serverQueue.audioResource = null;
    if (serverQueue.connection?.type === 'lavalink'
      || backend === 'lavalink'
      || serverQueue.backendUnavailable
      || serverQueue.lavalinkInterrupted) {
      await destroyLavalinkPlayer(guildId, 'voice-connection-destroyed').catch(error => {
        console.error('[Lavalink] destroy connection failed:', safeErrorMessage(error));
      });
      serverQueue.connection = null;
      if (!keepQueue) {
        serverQueue.songs = [];
        serverQueue.radioQueue = [];
        serverQueue.radioFailureCount = 0;
        serverQueue.suppressRadioUntilManualPlay = false;
        serverQueue.suppressRadioUntilManualQueueEnds = false;
        serverQueue.disposed = true;
        musicQueue.delete(guildId);
      }
      if (keepQueue && musicQueue.peek(guildId) === serverQueue) savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    if (serverQueue.connection) {
      try {
        serverQueue.connection.destroy();
      } catch (error) {
        console.error('[Voice] destroy connection failed:', error.message);
      }
      serverQueue.connection = null;
    }
    if (!keepQueue) {
      serverQueue.songs = [];
      serverQueue.radioQueue = [];
      serverQueue.disposed = true;
      musicQueue.delete(guildId);
    }
    if (keepQueue && musicQueue.peek(guildId) === serverQueue) savePlaybackState(guildId, serverQueue, { immediate: true });
    return true;
  }

  static async recoverVoiceConnection(guildId, reason = 'unknown') {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.recoverVoiceConnection(guildId, reason), { createQueue: false });
    }
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return;
    const blockedUntil = communicationDisabledUntil(serverQueue.guildRef?.members?.me);
    if (blockedUntil) {
      serverQueue.voiceReconnectAttempts = 0;
      this.scheduleVoiceRecovery(
        guildId,
        serverQueue,
        'communication-timeout-expired',
        blockedUntil - Date.now() + 1_000,
      );
      return false;
    }
    if (isLavalinkEnabled() && serverQueue.backendUnavailable) {
      this.scheduleLavalinkRecovery(guildId, serverQueue);
      return false;
    }
    if (this.activeBackend(serverQueue) === 'lavalink' && !serverQueue.backendUnavailable) return;
    if (serverQueue.clearingQueue) return;
    if (Date.now() < (serverQueue.suppressVoiceRecoveryUntil || 0)) return;
    if (!serverQueue.is247 && serverQueue.queueEnded) return;
    if (!serverQueue.is247 && !serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0) return;
    if (serverQueue.reconnectingVoice) return;
    if (!serverQueue.voiceChannelId) return;

    serverQueue.reconnectingVoice = true;
    const lifecycleGeneration = serverQueue.lifecycleGeneration;
    serverQueue.voiceReconnectAttempts = (serverQueue.voiceReconnectAttempts || 0) + 1;
    const attempt = serverQueue.voiceReconnectAttempts;

    try {
      console.warn(`[Voice] Recovering voice connection after ${reason}, attempt ${attempt}`);
      const guild = serverQueue.guildRef
        || serverQueue.textChannel?.guild
        || serverQueue.textChannel?.client?.guilds?.cache?.get(guildId);
      if (!guild) {
        console.warn(`[Voice] recovery aborted: cannot resolve guild ${guildId}`);
        return;
      }
      const voiceChannel = serverQueue.voiceChannelRef?.id === serverQueue.voiceChannelId
        ? serverQueue.voiceChannelRef
        : guild.channels.cache.get(serverQueue.voiceChannelId)
        || await guild.channels.fetch(serverQueue.voiceChannelId).catch(() => null);
      if (!voiceChannel?.isVoiceBased?.()) {
        console.warn(`[Voice] recovery aborted: voice channel ${serverQueue.voiceChannelId} not found`);
        return;
      }

      if (attempt > 3) {
        serverQueue.voiceReconnectAttempts = 0;
        if (serverQueue.is247) {
          if (!serverQueue.voiceRecoveryNotified) {
            serverQueue.voiceRecoveryNotified = true;
            sendPlaybackNotice(serverQueue, serverQueue.textChannel, '⚠️ 语音连接连续恢复失败，将在稍后再次尝试...');
          }
          // 24/7 模式：延迟重试，不永久放弃
          if (serverQueue.voiceRecoveryTimer) clearTimeout(serverQueue.voiceRecoveryTimer);
          serverQueue.voiceRecoveryTimer = setTimeout(() => {
            serverQueue.voiceRecoveryTimer = null;
            const sq = musicQueue.peek(guildId);
            if (sq && sq === serverQueue && sq.lifecycleGeneration === lifecycleGeneration && sq.is247 && !sq.connection) {
              this.recoverVoiceConnection(guildId, 'delayed-retry-247').catch(() => {});
            }
          }, VOICE_RECOVERY_MAX_BACKOFF_MS);
          serverQueue.voiceRecoveryTimer.unref?.();
        } else {
          if (!serverQueue.voiceRecoveryNotified) {
            serverQueue.voiceRecoveryNotified = true;
            sendPlaybackNotice(serverQueue, serverQueue.textChannel, '⚠️ 语音连接连续恢复失败，请稍后重新使用 /play。');
          }
        }
        return;
      }

      await this.destroyVoiceConnection(guildId, serverQueue, { keepQueue: true });
      if (musicQueue.peek(guildId) !== serverQueue || serverQueue.lifecycleGeneration !== lifecycleGeneration) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(VOICE_RECOVERY_MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempt - 1, 6)))));
      serverQueue.connection = await this.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator);
      if (musicQueue.peek(guildId) !== serverQueue || serverQueue.lifecycleGeneration !== lifecycleGeneration) return false;
      serverQueue.voiceReconnectAttempts = 0;
      serverQueue.voiceRecoveryNotified = false;
      if (serverQueue.currentSong) {
        const resumeSeconds = getPlaybackResumeSeconds(serverQueue);
        if (resumeSeconds === null) {
          await this.advancePastExpiredRecovery(guildId, serverQueue, serverQueue.textChannel);
          return;
        }
        const recoverySong = serverQueue.currentSong;
        const wasPaused = Boolean(recoverySong.playbackPaused || serverQueue.pausedAt);
        await this.playSong(guildId, serverQueue.textChannel, recoverySong, recoverySong.source || 'manual', {
          seekSeconds: resumeSeconds,
          suppressNowPlaying: true,
          recovery: true,
        });
        if (wasPaused) {
          this.preservePausedPlayback(guildId, serverQueue);
        }
      }
    } catch (error) {
      console.error('[Voice] recovery failed:', error.message);
      if (error?.code === VOICE_JOIN_BLOCKED_CODE) {
        serverQueue.voiceReconnectAttempts = 0;
        this.scheduleVoiceRecovery(
          guildId,
          serverQueue,
          'communication-timeout-expired',
          Number(error.retryAt) - Date.now() + 1_000,
        );
        return false;
      }
      if (musicQueue.peek(guildId) === serverQueue
        && serverQueue.lifecycleGeneration === lifecycleGeneration
        && serverQueue.is247
        && !serverQueue.clearingQueue
        && !serverQueue.connection) {
        if (serverQueue.voiceRecoveryTimer) clearTimeout(serverQueue.voiceRecoveryTimer);
        serverQueue.voiceRecoveryTimer = setTimeout(() => {
          serverQueue.voiceRecoveryTimer = null;
          this.recoverVoiceConnection(guildId, 'retry-after-failure').catch(() => {});
        }, Math.min(VOICE_RECOVERY_MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(attempt, 6))));
        serverQueue.voiceRecoveryTimer.unref?.();
      }
    } finally {
      serverQueue.reconnectingVoice = false;
    }
  }

  static async joinVoice(voiceChannel, guildId, adapterCreator, options = {}) {
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.joinVoice(voiceChannel, guildId, adapterCreator, options));
    }
    const serverQueue = musicQueue.get(guildId);
    options.signal?.throwIfAborted();
    const blockedError = voiceJoinBlockedError(
      voiceChannel?.guild?.members?.me
      || serverQueue.guildRef?.members?.me,
    );
    if (blockedError) throw blockedError;
    if (isLavalinkEnabled() && !options.forceLocal && !serverQueue.lavalinkVoiceFallback) {
      console.log('[Lavalink] Joining channel:', voiceChannel.name, '(' + voiceChannel.id + ')');
      serverQueue.voiceChannelId = voiceChannel.id;
      serverQueue.voiceChannelRef = voiceChannel;
      serverQueue.guildRef ||= voiceChannel.guild || null;
      let player;
      try {
        player = await createOrGetLavalinkPlayer({
          guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: serverQueue.textChannelId,
          volume: this.effectiveVolume(serverQueue),
        });
      } catch (error) {
        if (!isLavalinkVoiceStateError(error)) throw error;
        console.warn(`[Lavalink] guild=${guildId} Discord voice data unavailable; using local voice fallback`);
        await destroyLavalinkPlayer(guildId, 'voice-state-fallback').catch(() => false);
        serverQueue.connection = null;
        serverQueue.lavalinkPlayer = null;
        serverQueue.lavalinkVoiceFallback = true;
        return this.joinVoice(voiceChannel, guildId, adapterCreator, { ...options, forceLocal: true });
      }
      const connection = lavalinkConnectionShim(voiceChannel.id, player);
      if (!connection) throw new NoLavalinkNodeError('Lavalink player voice state is not ready');
      serverQueue.lavalinkVoiceFallback = false;
      serverQueue.connection = connection;
      serverQueue.lavalinkPlayer = player;
      serverQueue.suppressVoiceRecoveryUntil = 0;
      return serverQueue.connection;
    }

    const timingStartedAt = PLAY_TIMING ? Date.now() : null;
    console.log('[Voice] Joining channel:', voiceChannel.name, '(' + voiceChannel.id + ')');
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: adapterCreator,
      selfDeaf: true,
      debug: VOICE_DEBUG,
    });
    serverQueue.voiceChannelId = voiceChannel.id;
    serverQueue.voiceChannelRef = voiceChannel;
    serverQueue.guildRef ||= voiceChannel.guild || null;

    console.log('[Voice] joinVoiceChannel returned, state:', connection.state.status);

    if (VOICE_DEBUG) {
      connection.on('debug', (message) => {
        const safeMessage = message
          .replaceAll(/"token":"[^"]+"/g, '"token":"[redacted]"')
          .replaceAll(/"session_id":"[^"]+"/g, '"session_id":"[redacted]"');
        console.log('[Voice Debug]', safeMessage);
      });
    }

    connection.on('stateChange', (oldState, newState) => {
      debugLog('[Voice] Connection state:', oldState.status, '->', newState.status);
      if (oldState.status !== VoiceConnectionStatus.Ready && newState.status === VoiceConnectionStatus.Ready) {
        const serverQueue = musicQueue.peek(guildId);
        if (!serverQueue) return;
        serverQueue.voiceReconnectAttempts = 0;
        console.log('[Voice] Ready - player exists:', !!serverQueue?.player);
        if (serverQueue?.player) {
          connection.subscribe(serverQueue.player);
          debugLog('[Voice] Re-subscribed player after Ready');
        }
      }
    });

    connection.on('error', (error) => {
      console.error('[Voice] Connection error:', error);
      if (String(error.message || '').includes('IP discovery') || String(error.message || '').includes('socket closed')) {
        this.recoverVoiceConnection(guildId, error.message).catch(recoveryError => {
          console.error('[Voice] recovery task failed:', recoveryError.message);
        });
      }
    });

    try {
      if (connection.state.status !== VoiceConnectionStatus.Ready) {
        console.log('[Voice] Waiting for Ready state...');
        await withPlaybackSignal(() => entersState(connection, VoiceConnectionStatus.Ready, 30_000), options.signal);
      }
      console.log('[Voice] Connection ready, state:', connection.state.status);
      serverQueue.suppressVoiceRecoveryUntil = 0;
      timingLog(timingStartedAt, 'voice connection ready');
    } catch (error) {
      if (options.signal?.aborted) {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        throw options.signal.reason;
      }
      console.error('[Voice] Packet diagnostics:', {
        hasStatePacket: Boolean(connection.packets?.state),
        hasServerPacket: Boolean(connection.packets?.server),
        serverEndpoint: connection.packets?.server?.endpoint,
        stateChannelId: connection.packets?.state?.channel_id,
        hasSessionId: Boolean(connection.packets?.state?.session_id),
      });
      console.error('[Voice] Ready timeout, destroying connection. state:', connection.state.status, 'error:', error.message);
      connection.destroy();
      throw new Error('连接语音频道超时，请检查机器人语音权限或服务器网络');
    }

    // 连接断开时自动清理
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.recoverVoiceConnection(guildId, 'Disconnected').catch(error => {
          console.error('[Voice] disconnected recovery failed:', safeErrorMessage(error));
        });
      }
    });

    return connection;
  }

  static async skip(guildId, options = {}) {
    if (!this.operationIsValid(options)) return { ok: false, reason: 'stale' };
    if (!this.inTransition(guildId)) {
      // Unguarded user controls may interrupt recovery immediately. Guarded
      // voice work must wait for its in-lock validity check before any mutation.
      if (!options.signal && !options.validateOperation) this.interruptPlaybackRecovery(guildId);
      return this.runTransition(guildId, () => this.skip(guildId, options), { createQueue: false });
    }
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return { ok: false, reason: 'no-queue' };
    if (options.signal || options.validateOperation) this.interruptPlaybackRecovery(guildId);

    if (serverQueue.skipRequested && serverQueue.currentSong) {
      this.removeQueueItemsById(serverQueue, [serverQueue.currentSong.queueItemId]);
      this.releaseReservedSong(serverQueue, serverQueue.currentSong);
    }

    const next = await this.resolveNextSongForSkip(guildId, serverQueue);
    if (!this.operationIsValid(options)) {
      if (next.song) this.releaseReservedSong(serverQueue, next.song);
      return { ok: false, reason: 'stale' };
    }
    if (!next.ok) {
      if (serverQueue.skipRequested && !serverQueue.playing) {
        await this.stopCurrentTrackOnly(guildId, serverQueue);
        this.clearFinishedCurrentSong(serverQueue);
        serverQueue.queueEnded = true;
      }
      if (next.reason === 'no-radio-recommendation' && serverQueue.radio?.enabled) {
        savePlaybackState(guildId, serverQueue);
      }
      return next;
    }
    const skippedSong = serverQueue.currentSong;

    const backend = this.activeBackend(serverQueue);
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    if (backend === 'lavalink') {
      serverQueue.skipRequested = true;
      try {
        const result = await this.playSong(guildId, serverQueue.textChannel, next.song, next.source, options);
        if (result?.reason === 'backend-unavailable') return result;
        this.commitReservedSong(serverQueue, next.song);
      } catch (error) {
        console.error('[Skip/Lavalink] playSong failed after suppress, forcing advance:', error.message);
        this.advance(guildId, serverQueue);
        return { ok: false, reason: 'playback-failed' };
      }
      this.rememberSong(serverQueue, skippedSong);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { ok: true, song: next.song, source: next.source };
    }
    if (serverQueue.ffmpegProcess) {
      serverQueue.skipRequested = true;
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ffmpegProcess);
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      serverQueue.skipRequested = true;
      this.unpipeAudio(serverQueue);
      this.terminateChildProcess(serverQueue.ytdlpProcess);
      serverQueue.ytdlpProcess = null;
    }
    if (serverQueue.player) {
      serverQueue.skipRequested = true;
      serverQueue.player.stop(true);
      try {
        const result = await this.playSong(guildId, serverQueue.textChannel, next.song, next.source, options);
        if (result?.reason === 'backend-unavailable') return result;
        this.commitReservedSong(serverQueue, next.song);
      } catch (error) {
        console.error('[Skip/Local] playSong failed after suppress, forcing advance:', error.message);
        this.advance(guildId, serverQueue);
        return { ok: false, reason: 'playback-failed' };
      }
      this.rememberSong(serverQueue, skippedSong);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { ok: true, song: next.song, source: next.source };
    }
    // player 不存在但有进程被杀掉了，手动触发 advance
    if (serverQueue.skipRequested) {
      try {
        const result = await this.playSong(guildId, serverQueue.textChannel, next.song, next.source, options);
        if (result?.reason === 'backend-unavailable') return result;
        this.commitReservedSong(serverQueue, next.song);
      } catch (error) {
        console.error('[Skip/NoPlayer] playSong failed, forcing advance:', error.message);
        this.advance(guildId, serverQueue);
        return { ok: false, reason: 'playback-failed' };
      }
      this.rememberSong(serverQueue, skippedSong);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { ok: true, song: next.song, source: next.source };
    }
    return { ok: false, reason: 'no-player' };
  }

  static async previous(guildId, options = {}) {
    if (!this.operationIsValid(options)) return { ok: false, reason: 'stale' };
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.previous(guildId, options), { createQueue: false });
    }
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue?.currentSong) return { ok: false, reason: 'no-current-song' };

    const previousSong = serverQueue.history.pop();
    if (!previousSong) return { ok: false, reason: 'no-history' };

    const currentSong = serverQueue.currentSong;
    if (currentSong) {
      ensureQueueItemId(currentSong);
      serverQueue.songs.unshift(currentSong);
    }

    serverQueue.skipRequested = true;
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    serverQueue.queueEnded = false;
    this.cleanupProcesses(serverQueue);
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (player) await player.stopPlaying(true, false).catch(() => {});
    } else if (serverQueue.player) {
      try {
        serverQueue.player.stop(true);
      } catch {
        // Ignore player stop failures before replaying previous song.
      }
    }

    try {
      if (!this.operationIsValid(options)) return { ok: false, reason: 'stale' };
      await this.playSong(guildId, serverQueue.textChannel, previousSong, previousSong.source || 'manual', options);
    } catch (error) {
      console.error('[Previous] playSong failed after suppress, forcing advance:', error.message);
      this.advance(guildId, serverQueue);
    }
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return { ok: true, song: previousSong };
  }

  static async pause(guildId, options = {}) {
    if (!this.operationIsValid(options)) return false;
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.pause(guildId, options), { createQueue: false });
    }
    const backend = this.activeBackend(serverQueue);
    const playbackId = serverQueue.playbackId;
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player && !serverQueue.player) return false;
      if (!player && serverQueue.player) {
        try {
          const paused = serverQueue.player.pause(true);
          if (paused === false) return false;
          if (!this.isCurrentPlayback(serverQueue, playbackId)) return false;
          markPlaybackPaused(serverQueue);
          this.setSongPausedState(serverQueue, true);
          serverQueue.playing = false;
          savePlaybackState(guildId, serverQueue, { immediate: true });
          return true;
        } catch {
          return false;
        }
      }
      return Promise.resolve(player.pause())
        .then(result => {
          if (result === false || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
          markPlaybackPaused(serverQueue);
          this.setSongPausedState(serverQueue, true);
          serverQueue.playing = false;
          savePlaybackState(guildId, serverQueue, { immediate: true });
          return true;
        })
        .catch(error => {
          console.error('[Lavalink] pause failed:', safeErrorMessage(error));
          return false;
        });
    }
    if (serverQueue.player) {
      try {
        const paused = serverQueue.player.pause(true);
        if (paused === false) return false;
        if (!this.isCurrentPlayback(serverQueue, playbackId)) return false;
        markPlaybackPaused(serverQueue);
        this.setSongPausedState(serverQueue, true);
        serverQueue.playing = false;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  static async resume(guildId, options = {}) {
    if (!this.operationIsValid(options)) return false;
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.resume(guildId, options), { createQueue: false });
    }
    const backend = this.activeBackend(serverQueue);
    const playbackId = serverQueue.playbackId;
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player && !serverQueue.player) return false;
      if (!player && serverQueue.player) {
        try {
          const resumed = serverQueue.player.unpause();
          if (resumed === false || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
          markPlaybackResumed(serverQueue);
          this.setSongPausedState(serverQueue, false);
          serverQueue.playing = true;
          savePlaybackState(guildId, serverQueue, { immediate: true });
          return true;
        } catch {
          return false;
        }
      }
      return Promise.resolve(player.resume())
        .then(result => {
          if (result === false || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
          markPlaybackResumed(serverQueue);
          this.setSongPausedState(serverQueue, false);
          serverQueue.playing = true;
          savePlaybackState(guildId, serverQueue, { immediate: true });
          return true;
        })
        .catch(error => {
          console.error('[Lavalink] resume failed:', safeErrorMessage(error));
          return false;
        });
    }
    if (serverQueue.player) {
      try {
        const resumed = serverQueue.player.unpause();
        if (resumed === false || !this.isCurrentPlayback(serverQueue, playbackId)) return false;
        markPlaybackResumed(serverQueue);
        this.setSongPausedState(serverQueue, false);
        serverQueue.playing = true;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  static async setVolume(guildId, volume) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.setVolume(guildId, volume), { createQueue: false });
    }
    const nextVolume = Math.max(0, Math.min(100, Number(volume) || 0));
    const previousVolume = serverQueue.volume;
    serverQueue.volume = nextVolume;
    return this.queueVolumeOperation(serverQueue, () => this.applyOutputVolume(guildId, serverQueue))
      .then(applied => {
        if (!applied) {
          serverQueue.volume = previousVolume;
          return false;
        }
        savePlaybackState(guildId, serverQueue);
        return true;
      })
      .catch(error => {
        serverQueue.volume = previousVolume;
        console.error('[Player] set volume failed:', safeErrorMessage(error));
        return false;
      });
  }

  static async setTransientVolume(guildId, volume, token) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (serverQueue.volumeRestoreTimer) clearTimeout(serverQueue.volumeRestoreTimer);
    serverQueue.volumeRestoreTimer = null;
    serverQueue.pendingVolumeRestore = false;
    serverQueue.transientVolume = { token, volume: Math.max(0, Number(volume) || 0) };
    return this.queueVolumeOperation(serverQueue, () => this.applyOutputVolume(guildId, serverQueue));
  }

  static async clearTransientVolume(guildId, token) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.transientVolume?.token !== token) return false;
    serverQueue.transientVolume = null;
    serverQueue.pendingVolumeRestore = true;
    try {
      const restored = await this.queueVolumeOperation(serverQueue, () => this.applyOutputVolume(guildId, serverQueue));
      if (!restored) this.scheduleVolumeRestore(guildId, serverQueue);
      return restored;
    } catch (error) {
      this.scheduleVolumeRestore(guildId, serverQueue);
      throw error;
    }
  }

  static async setFilter(guildId, mode) {
    const normalized = normalizeFilterMode(mode);
    if (!normalized) return false;
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.setFilter(guildId, mode), { createQueue: false });
    }
    const previousPlaybackId = serverQueue.playbackId;
    const wasPaused = Boolean(serverQueue.pausedAt);
    const previousFilter = serverQueue.filters?.active || 'none';
    serverQueue.filters = { active: normalized };
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (player) {
        try {
          await applyLavalinkFilter(player, normalized);
        } catch (error) {
          serverQueue.filters = { active: previousFilter };
          throw error;
        }
      }
      savePlaybackState(guildId, serverQueue);
      return true;
    }
    if (serverQueue.currentSong && (serverQueue.playing || serverQueue.pausedAt)) {
      const seekSeconds = getPlaybackProgressSeconds(serverQueue);
      await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
        seekSeconds,
        suppressNowPlaying: true,
      });
       const recoveredPlaybackId = serverQueue.playbackId;
       if (recoveredPlaybackId <= previousPlaybackId || !this.isCurrentPlayback(serverQueue, recoveredPlaybackId)) return false;
      if (wasPaused) this.preservePausedPlayback(guildId, serverQueue);
      return true;
    }
    savePlaybackState(guildId, serverQueue);
    return true;
  }

  static async seek(guildId, seconds) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      return this.runTransition(guildId, () => this.seek(guildId, seconds), { createQueue: false });
    }
    if (!serverQueue.currentSong) return false;
    const previousPlaybackId = serverQueue.playbackId;
    const wasPaused = Boolean(serverQueue.pausedAt || serverQueue.currentSong?.playbackPaused);
    const requestedSeconds = Math.max(0, Number(seconds) || 0);
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player) {
        if (!serverQueue.player) return false;
       await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: requestedSeconds,
          suppressNowPlaying: true,
          forceLocal: true,
        });
        const recoveredPlaybackId = serverQueue.playbackId;
        if (recoveredPlaybackId <= previousPlaybackId || !this.isCurrentPlayback(serverQueue, recoveredPlaybackId)) return false;
        if (wasPaused) this.preservePausedPlayback(guildId, serverQueue);
        return true;
      }
       await player.seek(Math.floor(requestedSeconds * 1000));
       if (!this.isCurrentPlayback(serverQueue, serverQueue.playbackId)) return false;
       if (wasPaused) {
         freezePlaybackProgress(serverQueue, requestedSeconds);
         serverQueue.pausedAt = Date.now();
         serverQueue.playing = false;
       } else {
         markPlaybackStarted(serverQueue, requestedSeconds);
       }
       savePlaybackState(guildId, serverQueue, { immediate: true });
       return true;
    }
    await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
      seekSeconds: requestedSeconds,
      suppressNowPlaying: true,
    });
     const recoveredPlaybackId = serverQueue.playbackId;
     if (recoveredPlaybackId <= previousPlaybackId || !this.isCurrentPlayback(serverQueue, recoveredPlaybackId)) return false;
     if (wasPaused) this.preservePausedPlayback(guildId, serverQueue);
    return true;
  }

  static async stop(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!this.inTransition(guildId)) {
      this.interruptPlaybackRecovery(guildId);
      return this.runTransition(guildId, () => this.stop(guildId), { createQueue: false });
    }
    if (!serverQueue.is247) {
      return this.clearQueueAndLeave(guildId, 'stop-command', { notify: false });
    }

    this.clearIdleLeaveTimer(serverQueue);
    this.cancelRecoveryTimers(serverQueue);
    this.invalidateCurrentPlayback(guildId, serverQueue, { freeze: false });
    const backend = this.activeBackend(serverQueue);
    serverQueue.songs = [];
    serverQueue.radioQueue = [];
    serverQueue.radio.enabled = false;
    serverQueue.radio.pendingStyle = null;
    serverQueue.radio.seedSong = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    serverQueue.suppressRadioUntilManualQueueEnds = false;
    this.resetLavalinkStart(serverQueue);
    serverQueue.terminalHandledPlaybackId = serverQueue.playbackId;
    this.clearLavalinkStartTimer(serverQueue);
    serverQueue.playing = false;
    this.cleanupLocalProcesses(serverQueue);
    if (backend === 'lavalink') {
      getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(error => {
        console.error('[Lavalink] stop failed:', error.message);
      });
    } else if (serverQueue.player) {
      serverQueue.player.stop();
    }
    if (backend !== 'lavalink') getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(() => {});
    serverQueue.activeBackend = null;
    serverQueue.startingBackend = null;
    serverQueue.audioResource = null;
    serverQueue.currentSong = null;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
    serverQueue.reservedNext = null;
    serverQueue.forceLocal = false;
    serverQueue.forceYtdlpPipe = false;
    serverQueue.localFallbackTried = false;
    serverQueue.backendUnavailable = false;
    serverQueue.playbackBlocked = false;
    serverQueue.pendingRecovery = null;
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return true;
  }

  static shuffle(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (serverQueue.songs.length > 1) {
      for (let i = serverQueue.songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [serverQueue.songs[i], serverQueue.songs[j]] = [serverQueue.songs[j], serverQueue.songs[i]];
      }
      return true;
    }
    return false;
  }

  static setLoop(guildId, mode) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (['off', 'single', 'queue'].includes(mode)) {
      serverQueue.loop = mode;
      savePlaybackState(guildId, serverQueue);
      return true;
    }
    return false;
  }
}
