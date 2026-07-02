import { createAudioPlayer, createAudioResource, AudioPlayerStatus, joinVoiceChannel, VoiceConnectionStatus, entersState, StreamType, NoSubscriberBehavior } from '@discordjs/voice';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import { ensureRadioQueue, maybeApplyAutodetect } from './radio.js';
import { buildAudioFilter, normalizeFilterMode } from './filters.js';
import { Bilibili } from './bilibili.js';
import {
  applyLavalinkFilter,
  createOrGetLavalinkPlayer,
  destroyLavalinkPlayer,
  getLavalinkPlayer,
  isLavalinkEnabled,
  isLavalinkSupportedUrl,
  lavalinkConnectionShim,
} from './lavalink.js';
import { publishNowPlaying } from './playerPanel.js';
import { BILIBILI_USER_AGENT, cookieArgs } from './shared.js';
import {
  deletePlaybackState,
  getPlaybackProgressSeconds,
  markPlaybackPaused,
  markPlaybackResumed,
  markPlaybackStarted,
  savePlaybackState,
} from './playbackState.js';

const VOICE_DEBUG = process.env.VOICE_DEBUG === '1';
const PLAYER_DEBUG = process.env.PLAYER_DEBUG === '1';
const PLAY_TIMING = process.env.PLAY_TIMING === '1';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_PLAYBACK_RETRIES = 2;
const MAX_LAVALINK_CONSECUTIVE_FAILURES = 3;
const RETRY_BACKOFF_MS = 1500;
const RETRY_REWIND_SECONDS = 3;
const RADIO_GENERATION_WAIT_MS = 15_000;
const AUDIO_BUFFER_MB = Number(process.env.AUDIO_BUFFER_MB) || 8;
const AUDIO_STREAM_BUFFER_BYTES = AUDIO_BUFFER_MB * 1024 * 1024;
const AUDIO_PREBUFFER_BYTES = 256 * 1024;
const AUDIO_PREBUFFER_TIMEOUT_MS = Number(process.env.AUDIO_PREBUFFER_MS ?? 1500);
const STALL_WATCHDOG_MS = 15_000; // 15 秒无播放活动则强制推进队列

function debugLog(...args) {
  if (PLAYER_DEBUG) console.log(...args);
}

function timingLog(startedAt, step) {
  if (PLAY_TIMING && startedAt) console.log(`[play timing] ${step}: ${Date.now() - startedAt}ms`);
}

function sendToChannel(channel, payload) {
  return channel?.send(payload).catch(error => {
    console.warn('[Discord] failed to send message:', error.message);
  });
}

function describeYtdlpFailure(message = '') {
  const lower = message.toLowerCase();
  if (lower.includes('http error 412') || lower.includes('precondition failed')) return 'Bilibili 返回 412 风控/反爬，建议配置有效的 YTDLP_COOKIE_FILES cookies 文件后重试';
  if (lower.includes('no such option') || lower.includes('unknown option')) return `yt-dlp 参数不兼容：${summarizeProcessOutput(message)}`;
  if (lower.includes('403') || lower.includes('forbidden')) return '平台返回 403/Forbidden，可能需要 cookies 或稍后重试';
  if (lower.includes('sign in') || lower.includes('age') || lower.includes('bot')) return '平台要求验证登录/年龄或检测到机器人，建议配置 YTDLP_COOKIE_FILES';
  if (lower.includes('private')) return '视频是私有内容，无法播放';
  if (lower.includes('unavailable')) return '视频当前不可用';
  if (lower.includes('bytes read') && lower.includes('more expected')) return '音源连接中途断开，已多次重试仍失败，可能是网络波动或平台 CDN 临时异常';
  if (lower.includes('timed out') || lower.includes('timeout')) return '获取音频超时，请稍后重试';
  return message || 'yt-dlp 获取音频失败';
}

function describePlaybackErrorForUser(errorInfo) {
  if (!errorInfo?.message) return '播放流中断，可能是网络波动或音源临时不可用';
  return String(errorInfo.message).replace(/^\[[^\]]+\]\s*/, '');
}

function summarizeProcessOutput(output = '') {
  const text = String(output).trim().replace(/\s+/g, ' ');
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
      this.queue.set(guildId, {
        songs: [],
        radioQueue: [],
        currentSong: null,
        history: [],
        player: null,
        activeBackend: null,
        connection: null,
        volume: 50,
        loop: 'off',
        textChannel: null,
        playing: false,
        ffmpegProcess: null,
        ytdlpProcess: null,
        audioResource: null,
        playbackError: false,
        lastPlaybackError: null,
        playbackRetryCount: 0,
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
        skipRequested: false,
        suppressNextIdleAdvance: false,
        reconnectingVoice: false,
        voiceReconnectAttempts: 0,
        seekOffsetSeconds: 0,
        startedAt: null,
        pausedAt: null,
        pausedByEmptyChannel: false,
        is247: false,
        voiceChannelId: null,
        textChannelId: null,
        filters: { active: 'none' },
        versionPreference: 'any',
        notificationMode: 'private',
        nowPlayingMessageId: null,
        nowPlayingChannelId: null,
        idleLeaveTimer: null,
        idleReason: null,
        queueEnded: false,
        clearingQueue: false,
        radio: {
          enabled: false,
          autodetect: false,
          currentStyle: {},
          pendingStyle: null,
          seedSong: null,
          isGenerating: false,
          lastGeneratedAt: null,
        },
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
  static shouldUseLavalink(song = null) {
    if (!isLavalinkEnabled()) return false;
    if (song?.forceLocalFallback) return false;
    if (!song) return true;
    if (isBilibiliSongUrl(song.url) && freshAudioUrl(song)) return true;
    return isLavalinkSupportedUrl(song.url || song.audioUrl);
  }

  static async refreshBilibiliAudioUrl(song) {
    if (!isBilibiliSongUrl(song?.url) || freshAudioUrl(song)) return song;
    try {
      const refreshed = await Bilibili.getVideoInfo(song.url);
      if (refreshed?.audioUrl) {
        song.audioUrl = refreshed.audioUrl;
        song.audioUrlExpiresAt = refreshed.audioUrlExpiresAt;
      }
    } catch (error) {
      console.warn('[Bilibili] failed to refresh direct audio URL:', error.message);
    }
    return song;
  }

  static activeBackend(serverQueue) {
    if (serverQueue?.activeBackend) return serverQueue.activeBackend;
    if (serverQueue?.player) return 'local';
    return isLavalinkEnabled() ? 'lavalink' : 'local';
  }

  static async ensureLocalVoiceConnection(guildId, serverQueue, textChannel = null) {
    if (serverQueue.connection?.type !== 'lavalink') return;

    const guild = textChannel?.guild || serverQueue.textChannel?.guild;
    const voiceChannelId = serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId;
    if (!guild || !voiceChannelId) {
      throw new Error('Bilibili 本地播放需要真实语音连接，但缺少语音频道信息');
    }

    const voiceChannel = guild.channels.cache.get(voiceChannelId)
      || await guild.channels.fetch(voiceChannelId).catch(() => null);
    if (!voiceChannel) {
      throw new Error('Bilibili 本地播放需要真实语音连接，但找不到语音频道');
    }

    await destroyLavalinkPlayer(guildId, 'switch-to-local-playback');
    serverQueue.connection = await this.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator, { forceLocal: true });
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

  static cleanupLocalProcesses(serverQueue) {
    if (serverQueue.ffmpegProcess) {
      this.unpipeAudio(serverQueue);
      serverQueue.ffmpegProcess.kill();
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      this.unpipeAudio(serverQueue);
      serverQueue.ytdlpProcess.kill();
      serverQueue.ytdlpProcess = null;
    }
  }

  static async getNextSong(guildId, serverQueue) {
    // 手动队列优先，不受 pausedByEmptyChannel 影响
    if (serverQueue.songs.length > 0) {
      return { song: serverQueue.songs.shift(), source: 'manual' };
    }

    if (serverQueue.suppressRadioUntilManualQueueEnds) {
      // 手动队列已空（songs.shift() 后到达这里），清除抑制标志，允许 radio 接力
      serverQueue.suppressRadioUntilManualQueueEnds = false;
    }

    // 频道没人时，不触发 radio/AI，让手动队列播完后自然停止
    if (serverQueue.pausedByEmptyChannel) return null;

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
      if (serverQueue.radioQueue.length === 0) {
        await ensureRadioQueue(serverQueue, 5);
      }

      const song = serverQueue.radioQueue.shift();
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
      if (generatedCount > 0 || serverQueue.radioQueue.length > 0) {
        const radioSong = serverQueue.radioQueue.shift();
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
    if (serverQueue.radioQueue.length > 0) return generated;
    if (serverQueue.radio.isGenerating && serverQueue.radio._generatingPromise) {
      await Promise.race([
        serverQueue.radio._generatingPromise,
        sleep(RADIO_GENERATION_WAIT_MS),
      ]);
    }
    return serverQueue.radioQueue.length;
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
    return serverQueue.playbackId === playbackId;
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
    const errorMessage = error?.message || message || '未知播放错误';
    const progressSeconds = getPlaybackProgressSeconds(serverQueue);
    serverQueue.playbackError = true;
    serverQueue.lastPlaybackError = {
      source,
      message: errorMessage,
      songTitle: serverQueue.currentSong?.title || '未知歌曲',
      songUrl: serverQueue.currentSong?.url || '',
      playbackId,
      progressSeconds,
      occurredAt: Date.now(),
    };
    console.error(`[PlaybackError] source=${source} guild=${guildId} playbackId=${playbackId} progress=${progressSeconds}s title="${serverQueue.lastPlaybackError.songTitle}"`);
    console.error('[PlaybackError] message=', errorMessage);
    return true;
  }

  static resetLavalinkStart(serverQueue, startKey = null) {
    if (!serverQueue) return;
    if (!startKey || serverQueue.lavalinkStartKey === startKey) {
      serverQueue.lavalinkStarting = false;
      serverQueue.lavalinkStartKey = null;
    }
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
    serverQueue.radioQueue = [];
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    serverQueue.suppressRadioUntilManualQueueEnds = true;
    serverQueue.queueEnded = false;
  }

  static async stopCurrentTrackOnly(guildId, serverQueue) {
    this.cleanupProcesses(serverQueue);
    serverQueue.skipRequested = true;
    serverQueue.suppressNextIdleAdvance = true;
    this.resetLavalinkStart(serverQueue);
    if (isLavalinkEnabled()) {
      const player = getLavalinkPlayer(guildId);
      if (player) await player.stopPlaying(true, false).catch(() => {});
      return;
    }
    try {
      serverQueue.player?.stop(true);
    } catch {
      // Ignore stop failures while replacing the current track.
    }
  }

  static stopRadioAfterFailures(guildId, serverQueue, reason) {
    serverQueue.radio.enabled = false;
    serverQueue.radioQueue = [];
    serverQueue.radio.pendingStyle = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = true;
    sendToChannel(serverQueue.textChannel, `⚠️ Radio 连续播放失败，已自动关闭以避免面板继续跳歌。\n原因：${reason}`);
    savePlaybackState(guildId, serverQueue, { immediate: true });
  }

  static async advance(guildId, serverQueue) {
    if (serverQueue.queueEnded || serverQueue.clearingQueue) {
      debugLog('[Player] advance ignored because queue is ended/clearing');
      return;
    }

    if (serverQueue.advancing) {
      return this.waitForAdvance(guildId, 3000);
    }

    serverQueue.advancing = true;
    try {
      const hadPlaybackError = serverQueue.playbackError;
      const playbackErrorInfo = hadPlaybackError ? serverQueue.lastPlaybackError : null;

      const isFatalProcessCrash = /signal\s+SIGSEGV/i.test(playbackErrorInfo?.message || '');
      if (playbackErrorInfo && serverQueue.currentSong && !isFatalProcessCrash && serverQueue.playbackRetryCount < MAX_PLAYBACK_RETRIES && serverQueue.songs.length === 0) {
        serverQueue.playbackError = false;
        serverQueue.playbackRetryCount += 1;
        const retrySeekSeconds = Math.max(0, (playbackErrorInfo.progressSeconds || getPlaybackProgressSeconds(serverQueue)) - RETRY_REWIND_SECONDS);
        console.warn(`[PlaybackRetry] attempt=${serverQueue.playbackRetryCount}/${MAX_PLAYBACK_RETRIES} seek=${retrySeekSeconds}s title="${serverQueue.currentSong.title}"`);
        await sleep(RETRY_BACKOFF_MS);
        if (serverQueue.skipRequested || serverQueue.clearingQueue || serverQueue.queueEnded) return;
        return await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: retrySeekSeconds,
          suppressNowPlaying: true,
          preserveRetryCount: true,
        });
      }

      if (serverQueue.playbackError) {
        if (playbackErrorInfo && serverQueue.currentSong) {
          const reason = describePlaybackErrorForUser(playbackErrorInfo);
          console.warn(`[PlaybackSkipAfterError] title="${serverQueue.currentSong.title}" reason="${reason}"`);
          sendToChannel(serverQueue.textChannel, `⚠️ 当前歌曲播放流连续中断，已跳到下一首：**${serverQueue.currentSong.title}**\n原因：${reason}`);
          if (serverQueue.currentSong.source !== 'radio') {
            serverQueue.suppressRadioUntilManualPlay = true;
          }
        }
        serverQueue.playbackError = false;
      } else if (serverQueue.loop === 'single' && serverQueue.currentSong && !serverQueue.skipRequested) {
        return await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual');
      } else if (serverQueue.currentSong) {
        this.rememberSong(serverQueue, serverQueue.currentSong);
      }

      if (serverQueue.currentSong?.source === 'manual' && serverQueue.songs.length === 0) {
        serverQueue.suppressRadioUntilManualQueueEnds = false;
      }

      if (serverQueue.loop === 'queue' && serverQueue.currentSong?.source === 'manual' && !serverQueue.skipRequested && !hadPlaybackError) {
        serverQueue.songs.push(serverQueue.currentSong);
      }

      serverQueue.skipRequested = false;
      serverQueue.lastPlaybackError = null;
      serverQueue.playbackRetryCount = 0;

      // 用循环代替递归，避免 advancing 锁导致跳过不可播放歌曲时卡死
      const MAX_SKIP = 20;
      for (let attempt = 0; attempt < MAX_SKIP; attempt++) {
        const next = await this.getNextSong(guildId, serverQueue);
        if (!next?.song) {
          return await this.playSong(guildId, serverQueue.textChannel, null, null);
        }
        if (!isPlayableSongUrl(next.song.url)) {
          console.warn('[Player] advance skipped non-playable URL:', next.song.title, next.song.url);
          this.rememberSong(serverQueue, { ...next.song, skippedReason: 'non-playable-url' });
          continue;
        }
        return await this.playSong(guildId, serverQueue.textChannel, next.song, next.source);
      }
      console.warn('[Player] advance exhausted skip attempts');
      return await this.playSong(guildId, serverQueue.textChannel, null, null);
    } finally {
      serverQueue.advancing = false;
      // advance 完成后重置 lavalinkAdvanceHandled，允许下一次 Lavalink 事件触发新的 advance
      if (isLavalinkEnabled()) {
        serverQueue.lavalinkAdvanceHandled = false;
      }
      savePlaybackState(guildId, serverQueue);
      // advance 完成后启动看门狗，防止播放链条断裂导致卡死
      this.armStallWatchdog(guildId);
      const waiters = advanceWaiters.get(guildId);
      if (waiters) {
        advanceWaiters.delete(guildId);
        for (const resolve of waiters) resolve();
      }
    }
  }

  static waitForAdvance(guildId, timeoutMs = 3000) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      if (!advanceWaiters.has(guildId)) advanceWaiters.set(guildId, []);
      advanceWaiters.get(guildId).push(() => { clearTimeout(timer); resolve(); });
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
      if (serverQueue.advancing) return; // advance 还在跑，让它继续

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
    if (explicitSong) await this.refreshBilibiliAudioUrl(explicitSong);
    if (!options.forceLocal && this.shouldUseLavalink(explicitSong)) {
      return this.playSongLavalink(guildId, textChannel, explicitSong, explicitSource, options);
    }

    const timingStartedAt = PLAY_TIMING ? Date.now() : null;
    debugLog('[DEBUG] playSong 被调用, guildId:', guildId);
    const serverQueue = musicQueue.get(guildId);
    if (serverQueue.clearingQueue) return;
    if (textChannel) {
      serverQueue.textChannel = textChannel;
      serverQueue.textChannelId = textChannel.id;
    }

    // 清理残留进程
    if (serverQueue.ffmpegProcess) {
      this.unpipeAudio(serverQueue);
      serverQueue.ffmpegProcess.kill();
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      this.unpipeAudio(serverQueue);
      serverQueue.ytdlpProcess.kill();
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
          sendToChannel(textChannel, '📻 自动续播暂时没有找到可播放的推荐，请稍后再试或使用 /radio style 调整风格。');
        }
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
      if (serverQueue.is247) {
        savePlaybackState(guildId, serverQueue, { immediate: true });
      } else {
        this.scheduleIdleLeave(guildId, 'queue-ended');
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
      if (!serverQueue.queueEnded) {
        serverQueue.queueEnded = true;
      }
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
      return;
    }

    if (!isPlayableSongUrl(song.url)) {
      console.warn('[Player] skipped non-playable song URL:', song.title, song.url);
      this.rememberSong(serverQueue, { ...song, skippedReason: 'non-playable-url' });
      serverQueue.playbackError = true;
      // 不能依赖 player.stop() 触发 Idle（player 可能已是 Idle），直接调用 advance
      this.advance(guildId, serverQueue);
      return;
    }

    serverQueue.playbackId += 1;
    const playbackId = serverQueue.playbackId;
    serverQueue.skipRequested = false;
    if (!options.preserveRetryCount) {
      serverQueue.playbackRetryCount = 0;
      serverQueue.lastPlaybackError = null;
    }
    song.source = source || song.source || 'manual';
    if (song.source === 'manual') {
      serverQueue.suppressRadioUntilManualQueueEnds = true;
    }
    serverQueue.currentSong = song;
    serverQueue.streamDiagnostics = null;
    serverQueue.playing = true;
    serverQueue.stallWatchdogConsecutive = 0;
    serverQueue.pausedByEmptyChannel = false;
    serverQueue.queueEnded = false;
    serverQueue.idleReason = null;
    this.clearIdleLeaveTimer(serverQueue);

    try {
      if (!serverQueue.connection) {
        throw new Error('语音连接不存在');
      }

      await this.ensureLocalVoiceConnection(guildId, serverQueue, textChannel || serverQueue.textChannel);

      if (serverQueue.connection.state.status !== VoiceConnectionStatus.Ready) {
        console.log('[Voice] Playback waiting for Ready state, current:', serverQueue.connection.state.status);
        await entersState(serverQueue.connection, VoiceConnectionStatus.Ready, 15_000);
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
        if (serverQueue.player) {
          serverQueue.player.stop(true);
        }
      };

      const directAudioUrl = options.forceYtdlpPipe ? null : freshAudioUrl(song);
      const streamDiagnostics = {
        playbackId,
        inputMode: directAudioUrl ? 'direct-url' : 'yt-dlp-pipe',
        ytdlpErrorOutput: '',
        ytdlpExitCode: null,
        ytdlpExitSignal: null,
        ffmpegErrorOutput: '',
        ffmpegExitCode: null,
        ffmpegExitSignal: null,
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
          '--retries', '8',
          '--fragment-retries', '12',
          '--file-access-retries', '5',
          '--retry-sleep', 'http:exp=1:10',
          '--retry-sleep', 'fragment:exp=1:8',
          '-f', 'bestaudio[ext=webm]/bestaudio',
          '-o', '-',
          '--no-playlist',
          '-q',
          ...cookieArgs(),
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
      const seekSeconds = Math.max(0, Number(options.seekSeconds) || 0);
      const ffmpegArgs = [
        ...(seekSeconds > 0 ? ['-ss', String(Math.floor(seekSeconds))] : []),
        ...(directAudioUrl ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
        '-i', directAudioUrl || 'pipe:0',
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-c:a', 'libopus',
        '-vbr', 'on',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-af', buildAudioFilter(serverQueue.volume, normalizeFilterMode(serverQueue.filters?.active) || 'none'),
        '-f', 'ogg',
        'pipe:1'
      ];
      const ffmpeg = spawn('nice', ['-n', '-5', ffmpegPath || 'ffmpeg', ...ffmpegArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
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
          ffmpeg.kill();
        });

        ytdlp.on('close', (code, signal) => {
          if (!this.isCurrentPlayback(serverQueue, playbackId)) return;
          streamDiagnostics.ytdlpExitCode = code;
          streamDiagnostics.ytdlpExitSignal = signal;
          if (code !== 0 && !serverQueue.skipRequested) {
            markPlaybackError(`[yt-dlp] ${describeYtdlpFailure(streamDiagnostics.ytdlpErrorOutput)} (code ${code}${signal ? `, signal ${signal}` : ''})`);
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
      const resource = createAudioResource(audioStream, {
        inputType: StreamType.OggOpus,
        inlineVolume: true,
        metadata: { playbackId },
      });
      resource.volume?.setVolume(Math.max(0, Number(serverQueue.volume) || 0) / 100);
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
        });

        localPlayer.on(AudioPlayerStatus.Idle, () => {
          if (serverQueue.queueEnded || serverQueue.clearingQueue) return;
          const hasNext = this.hasPendingPlayback(serverQueue);
          if (serverQueue.suppressNextIdleAdvance) {
            serverQueue.suppressNextIdleAdvance = false;
            if (!hasNext) return;
            console.warn(`[Player] guild=${guildId} ignored stale suppressNextIdleAdvance on local idle because pending playback exists (songs=${serverQueue.songs.length}, radioQueue=${serverQueue.radioQueue.length}, radio=${Boolean(serverQueue.radio?.enabled)})`);
          }
          debugLog('Player Idle triggered');
          this.advance(guildId, serverQueue);
        });

      localPlayer.on('error', (error) => {
        console.error('Player error:', error);
        const errorPlaybackId = error?.resource?.metadata?.playbackId || serverQueue.playbackId;
        const diagnostics = serverQueue.streamDiagnostics?.playbackId === errorPlaybackId ? serverQueue.streamDiagnostics : null;
        const streamDetails = diagnostics
          ? `input=${diagnostics.inputMode || 'unknown'}, yt-dlp=${diagnostics.ytdlpExitCode ?? (diagnostics.inputMode === 'direct-url' ? 'skipped' : 'running')}${diagnostics.ytdlpExitSignal ? `/${diagnostics.ytdlpExitSignal}` : ''}, ffmpeg=${diagnostics.ffmpegExitCode ?? 'running'}${diagnostics.ffmpegExitSignal ? `/${diagnostics.ffmpegExitSignal}` : ''}`
          : 'process status unavailable';
        const processOutput = summarizeProcessOutput(diagnostics?.ytdlpErrorOutput || diagnostics?.ffmpegErrorOutput || '');
        const detail = `${error.message || 'Discord audio player error'} (${streamDetails}${processOutput ? `, ${processOutput}` : ''})`;
        this.recordPlaybackError(guildId, serverQueue, errorPlaybackId, 'player', detail);
        this.advance(guildId, serverQueue);
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
        if (this.isCurrentPlayback(serverQueue, playbackId)) {
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
      if (serverQueue.player !== localPlayer) {
        debugLog('[DEBUG] local player was replaced during prebuffer, aborting play');
        return;
      }
      localPlayer.play(resource);
      serverQueue.activeBackend = 'local';
      timingLog(timingStartedAt, 'player.play called');
      markPlaybackStarted(serverQueue, seekSeconds);
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
      if (serverQueue.ffmpegProcess) {
        this.unpipeAudio(serverQueue);
        serverQueue.ffmpegProcess.kill();
        serverQueue.ffmpegProcess = null;
      }
      if (serverQueue.ytdlpProcess) {
        this.unpipeAudio(serverQueue);
        serverQueue.ytdlpProcess.kill();
        serverQueue.ytdlpProcess = null;
      }
      serverQueue.audioResource = null;

      console.error('========== 播放错误 ==========');
      console.error('歌曲:', song.title);
      console.error('URL:', song.url);
      console.error('错误类型:', error.name);
      console.error('错误信息:', error.message);
      console.error('================================');

      const errorMsg = error.message || '未知错误';
      const canRetry = !serverQueue.skipRequested && serverQueue.playbackRetryCount < MAX_PLAYBACK_RETRIES;
      if (textChannel && !canRetry) {
        sendToChannel(textChannel, `⚠️ 无法播放 **${song.title}**: ${errorMsg}`);
      }

      serverQueue.playing = false;
      if (!serverQueue.playbackError) {
        serverQueue.lastPlaybackError = {
          source: 'unknown',
          message: errorMsg,
          songTitle: song.title,
          songUrl: song.url,
          playbackId,
          progressSeconds: getPlaybackProgressSeconds(serverQueue),
          occurredAt: Date.now(),
        };
        serverQueue.playbackError = true;
      }

      // 直接调用 advance() 推进队列。不能依赖 player.stop() 触发 Idle 事件，
      // 因为如果 player 已经是 Idle 状态，stop() 不会再发出 Idle 事件，导致卡死。
      // 设置 suppressNextIdleAdvance 防止 player.stop() 额外触发的 Idle 事件导致重复 advance。
      serverQueue.suppressNextIdleAdvance = true;
      if (serverQueue.player && serverQueue.player.state.status !== AudioPlayerStatus.Idle) {
        serverQueue.player.stop(true);
      }
      this.advance(guildId, serverQueue);
    }
  }

  static async playSongLavalink(guildId, textChannel, explicitSong = null, explicitSource = null, options = {}) {
    const timingStartedAt = PLAY_TIMING ? Date.now() : null;
    const serverQueue = musicQueue.get(guildId);
    if (serverQueue.clearingQueue) return;
    if (textChannel) {
      serverQueue.textChannel = textChannel;
      serverQueue.textChannelId = textChannel.id;
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
          sendToChannel(textChannel, '📻 自动续播暂时没有找到可播放的推荐，请稍后再试或使用 /radio style 调整风格。');
        }
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
      return;
    }

    let song = explicitSong;
    let source = explicitSource;
    if (!song) {
      const next = await this.getNextSong(guildId, serverQueue);
      song = next?.song;
      source = next?.source;
    }

    if (song) await this.refreshBilibiliAudioUrl(song);

    if (!song) {
      serverQueue.playing = false;
      serverQueue.queueEnded = true;
      return;
    }

    const sourceLabel = source || song.source || 'manual';
    const lavalinkUrl = isBilibiliSongUrl(song.url) ? freshAudioUrl(song) : (song.url || song.audioUrl);
    const isBilibiliDirectLavalink = isBilibiliSongUrl(song.url) && Boolean(lavalinkUrl);
    const startKey = `${lavalinkUrl || song.url || song.title || 'unknown'}:${sourceLabel}:${Number(options.seekSeconds) || 0}`;
    if (
      serverQueue.lavalinkLastStart?.key === startKey
      && Date.now() - serverQueue.lavalinkLastStart.at < 1500
    ) {
      debugLog('[Lavalink] recent duplicate play request suppressed:', song.title);
      return;
    }
    if (serverQueue.lavalinkStarting && serverQueue.lavalinkStartKey === startKey) {
      debugLog('[Lavalink] duplicate play request suppressed:', song.title);
      return;
    }
    serverQueue.lavalinkStarting = true;
    serverQueue.lavalinkStartKey = startKey;
    serverQueue.lavalinkLastStart = { key: startKey, at: Date.now() };
    const playbackGeneration = this.nextPlaybackGeneration(serverQueue);

    if (!isPlayableSongUrl(song.url)) {
      console.warn('[Lavalink] skipped non-playable song URL:', song.title, song.url);
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

    serverQueue.playbackId += 1;
    const playbackId = serverQueue.playbackId;
    serverQueue.skipRequested = false;
    if (!options.preserveRetryCount) {
      serverQueue.playbackRetryCount = 0;
      serverQueue.lastPlaybackError = null;
    }
    song.source = sourceLabel;
    if (sourceLabel === 'manual') {
      serverQueue.suppressRadioUntilManualQueueEnds = true;
    }
    serverQueue.currentSong = song;
    serverQueue.streamDiagnostics = { playbackId, inputMode: 'lavalink' };
    serverQueue.playing = true;
    serverQueue.lavalinkAdvanceHandled = false;
    serverQueue.stallWatchdogConsecutive = 0;
    serverQueue.pausedByEmptyChannel = false;
    serverQueue.queueEnded = false;
    serverQueue.idleReason = null;
    this.clearIdleLeaveTimer(serverQueue);

    try {
      const voiceChannelId = serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId;
      if (!voiceChannelId) throw new Error('语音连接不存在');

      const player = await createOrGetLavalinkPlayer({
        guildId,
        voiceChannelId,
        textChannelId: serverQueue.textChannelId,
        volume: serverQueue.volume,
      });
      serverQueue.connection = lavalinkConnectionShim(voiceChannelId);
      serverQueue.lavalinkPlayer = player;
      timingLog(timingStartedAt, 'lavalink player ready');

      if (isBilibiliDirectLavalink) {
        console.log(`[Bilibili] using direct audio URL via Lavalink: ${song.title}`);
      }
      const result = await player.search({ query: lavalinkUrl }, song.requestedBy || 'system');
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      const track = result?.tracks?.[0];
      if (!track) throw new Error(result?.exception?.message || 'Lavalink 未找到可播放音轨');

      const seekPositionMs = Math.max(0, Math.floor((Number(options.seekSeconds) || 0) * 1000));
      await applyLavalinkFilter(player, normalizeFilterMode(serverQueue.filters?.active) || 'none');
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      await player.setVolume(Math.max(0, Number(serverQueue.volume) || 0), true);
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      await player.play({
        clientTrack: track,
        position: seekPositionMs,
        volume: Math.max(0, Number(serverQueue.volume) || 0),
      });
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      serverQueue.activeBackend = 'lavalink';
      timingLog(timingStartedAt, 'lavalink play called');
      this.disarmStallWatchdog(guildId);

      markPlaybackStarted(serverQueue, options.seekSeconds || 0);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      if (song.source === 'manual') this.maybePrefillRadioQueue(guildId, serverQueue, 'manual lavalink playback');

      if (!options.suppressNowPlaying && serverQueue.notificationMode !== 'private') {
        publishNowPlaying(guildId, textChannel || serverQueue.textChannel, serverQueue, song)
          .then(() => savePlaybackState(guildId, serverQueue))
          .catch(error => {
            console.warn('[PlayerPanel] background publish failed:', error.message);
          });
      }
      savePlaybackState(guildId, serverQueue);
    } catch (error) {
      if (!this.isCurrentGeneration(serverQueue, playbackGeneration)) return;
      console.error('[Lavalink] playback error:', error.message);
      if (serverQueue.lavalinkAdvanceHandled) return;
      serverQueue.lavalinkAdvanceHandled = true;
      if (isBilibiliDirectLavalink && !options.localFallbackTried) {
        console.warn(`[Bilibili] Lavalink direct URL failed, falling back to local yt-dlp: ${error.message}`);
        song.audioUrlExpiresAt = 0;
        song.forceLocalFallback = true;
        serverQueue.lavalinkAdvanceHandled = false;
        serverQueue.playing = false;
        this.resetLavalinkStart(serverQueue, startKey);
        return this.playSong(guildId, textChannel, song, source, {
          ...options,
          forceLocal: true,
          forceYtdlpPipe: true,
          localFallbackTried: true,
        });
      }
      const canRetry = !serverQueue.skipRequested && serverQueue.playbackRetryCount < MAX_PLAYBACK_RETRIES;
      if (textChannel && !canRetry) {
        sendToChannel(textChannel, `⚠️ 无法播放 **${song.title}**: ${error.message || '未知错误'}`);
      }

      serverQueue.playing = false;
      if (!serverQueue.playbackError) {
        serverQueue.lastPlaybackError = {
          source: 'lavalink',
          message: error.message || 'Lavalink 播放失败',
          songTitle: song.title,
          songUrl: song.url,
          playbackId,
          progressSeconds: getPlaybackProgressSeconds(serverQueue),
          occurredAt: Date.now(),
        };
        serverQueue.playbackError = true;
      }
      if (song.source !== 'radio') serverQueue.suppressRadioUntilManualPlay = true;
      if (this.shouldStopAfterLavalinkFailures(guildId, serverQueue, error.message || 'Lavalink 播放失败')) return;
      await this.advance(guildId, serverQueue);
    } finally {
      this.resetLavalinkStart(serverQueue, startKey);
    }
  }

  static shouldStopAfterLavalinkFailures(guildId, serverQueue, message = '') {
    serverQueue.lavalinkFailureCount = (serverQueue.lavalinkFailureCount || 0) + 1;
    if (serverQueue.lavalinkFailureCount < MAX_LAVALINK_CONSECUTIVE_FAILURES) return false;

    const reason = String(message).split('\n')[0].slice(0, 180);
    console.warn(`[Lavalink] stopping queue after ${serverQueue.lavalinkFailureCount} consecutive failures: ${reason}`);
    sendToChannel(serverQueue.textChannel, `⚠️ Lavalink 连续播放失败，已停止自动跳歌并关闭 Radio，以避免面板继续跳转。\n原因：${reason}\n请稍后再试，或换一个音源。`);

    serverQueue.songs = [];
    serverQueue.radioQueue = [];
    serverQueue.radio.enabled = false;
    serverQueue.radio.pendingStyle = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = true;
    serverQueue.playing = false;
    serverQueue.currentSong = null;
    serverQueue.queueEnded = true;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
    serverQueue.playbackError = false;
    serverQueue.lastPlaybackError = null;
    serverQueue.playbackRetryCount = 0;
    serverQueue.skipRequested = false;
    this.resetLavalinkStart(serverQueue);
    getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(error => {
      console.error('[Lavalink] stop after failures failed:', error.message);
    });
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return true;
  }

  static handleLavalinkTrackEnd(guildId, _player = null, _track = null, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const reason = String(payload?.reason || '').toLowerCase();
    if (!['finished', 'end', 'ended'].includes(reason)) {
      debugLog(`[Lavalink] trackEnd ignored reason="${reason}" guild=${guildId}`);
      return;
    }
    serverQueue.lavalinkFailureCount = 0;
    serverQueue.radioFailureCount = 0;
    this.resetLavalinkStart(serverQueue);
    const hasNext = this.hasPendingPlayback(serverQueue);
    if (serverQueue.suppressNextIdleAdvance) {
      serverQueue.suppressNextIdleAdvance = false;
      if (!hasNext) return;
      console.warn(`[Lavalink] guild=${guildId} ignored stale suppressNextIdleAdvance on trackEnd because pending playback exists (reason=${reason}, songs=${serverQueue.songs.length}, radioQueue=${serverQueue.radioQueue.length}, radio=${Boolean(serverQueue.radio?.enabled)})`);
    }
    if (serverQueue.lavalinkAdvanceHandled) return;
    serverQueue.lavalinkAdvanceHandled = true;
    serverQueue.playing = false;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after track end failed:', error.message);
    });
  }

  static handleLavalinkQueueEnd(guildId, _player = null, _track = null, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    const reason = String(payload?.reason || '').toLowerCase();
    console.log(`[Lavalink] queue end observed guild=${guildId} exists=${Boolean(serverQueue)} queueEnded=${Boolean(serverQueue?.queueEnded)} clearing=${Boolean(serverQueue?.clearingQueue)} reason=${reason || 'unknown'} radio=${Boolean(serverQueue?.radio?.enabled)} radioQueue=${serverQueue?.radioQueue?.length ?? 'n/a'} songs=${serverQueue?.songs?.length ?? 'n/a'} current="${serverQueue?.currentSong?.title || ''}" playbackError=${Boolean(serverQueue?.playbackError)} retry=${serverQueue?.playbackRetryCount ?? 'n/a'}`);

    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    if (!['finished', 'end', 'ended', 'loadfailed'].includes(reason)) return;

    const hasNext = this.hasPendingPlayback(serverQueue);
    if (!hasNext) return;

    // loadFailed 不重置失败计数，只有正常结束才重置
    if (reason !== 'loadfailed') {
      serverQueue.lavalinkFailureCount = 0;
      serverQueue.radioFailureCount = 0;
    }
    this.resetLavalinkStart(serverQueue);
    if (serverQueue.suppressNextIdleAdvance) {
      serverQueue.suppressNextIdleAdvance = false;
      if (!hasNext) return;
      console.warn(`[Lavalink] guild=${guildId} ignored stale suppressNextIdleAdvance on queueEnd because pending playback exists (reason=${reason}, songs=${serverQueue.songs.length}, radioQueue=${serverQueue.radioQueue.length}, radio=${Boolean(serverQueue.radio?.enabled)})`);
    }
    if (serverQueue.lavalinkAdvanceHandled) return;
    serverQueue.lavalinkAdvanceHandled = true;
    serverQueue.playing = false;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after queue end failed:', error.message);
    });
  }

  static handleLavalinkTrackError(guildId, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const message = payload?.exception?.message || payload?.error || 'Lavalink 音轨播放失败';
    this.recordPlaybackError(guildId, serverQueue, serverQueue.playbackId, 'lavalink', message);
    if (serverQueue.currentSong?.source !== 'radio') serverQueue.suppressRadioUntilManualPlay = true;
    this.resetLavalinkStart(serverQueue);
    if (serverQueue.lavalinkAdvanceHandled) return;
    serverQueue.lavalinkAdvanceHandled = true;
    if (this.shouldStopAfterLavalinkFailures(guildId, serverQueue, message)) return;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after track error failed:', error.message);
    });
  }

  static handleLavalinkTrackStuck(guildId, payload = {}) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.queueEnded || serverQueue.clearingQueue) return;
    const message = `Lavalink 音轨卡住超过 ${payload?.thresholdMs || 'unknown'}ms`;
    this.recordPlaybackError(guildId, serverQueue, serverQueue.playbackId, 'lavalink', message);
    this.resetLavalinkStart(serverQueue);
    if (serverQueue.lavalinkAdvanceHandled) return;
    serverQueue.lavalinkAdvanceHandled = true;

    if (serverQueue.currentSong?.source === 'radio') {
      serverQueue.radioFailureCount = (serverQueue.radioFailureCount || 0) + 1;
      if (serverQueue.radioFailureCount >= 3) {
        this.stopRadioAfterFailures(guildId, serverQueue, message);
        return;
      }
    } else {
      serverQueue.suppressRadioUntilManualPlay = true;
    }

    if (this.shouldStopAfterLavalinkFailures(guildId, serverQueue, message)) return;
    this.advance(guildId, serverQueue).catch(error => {
      console.error('[Lavalink] advance after track stuck failed:', error.message);
    });
  }

  static cleanupProcesses(serverQueue) {
    this.cleanupLocalProcesses(serverQueue);
  }

  static async ensurePlaybackOutput(guildId, reason = 'voice-activity') {
    const serverQueue = musicQueue.peek(guildId);
    if (isLavalinkEnabled()) {
      const player = getLavalinkPlayer(guildId);
      if (!serverQueue?.currentSong || serverQueue.clearingQueue) return false;
      if (serverQueue.lavalinkStarting || serverQueue.lavalinkStartKey) return true;
      if (player?.connected && (player.playing || player.paused || player.track)) return true;
      if (Date.now() - (serverQueue.lastOutputRecoveryAt || 0) < 5000) return true;
      try {
        serverQueue.lastOutputRecoveryAt = Date.now();
        await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: getPlaybackProgressSeconds(serverQueue),
          suppressNowPlaying: true,
        });
        return true;
      } catch (error) {
        console.error('[Lavalink] playback output recovery failed:', error.message);
        return false;
      }
    }
    if (!serverQueue?.connection || !serverQueue.currentSong || serverQueue.clearingQueue) return false;

    try {
      if (serverQueue.player) {
        serverQueue.connection.subscribe(serverQueue.player);
        debugLog('[Voice] Re-subscribed player after', reason);
      }

      const status = serverQueue.player?.state?.status;
      if (serverQueue.playing && status && status !== AudioPlayerStatus.Idle) {
        return true;
      }

      await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
        seekSeconds: getPlaybackProgressSeconds(serverQueue),
        suppressNowPlaying: true,
      });
      return true;
    } catch (error) {
      console.error('[Voice] playback output recovery failed:', error.message);
      return false;
    }
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
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue || serverQueue.clearingQueue) return false;

    serverQueue.clearingQueue = true;
    this.disarmStallWatchdog(guildId);
    this.clearIdleLeaveTimer(serverQueue);
    this.cleanupProcesses(serverQueue);

    try {
      serverQueue.player?.stop(true);
    } catch {
      // Ignore player stop failures during cleanup.
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
    serverQueue.player = null;
    serverQueue.audioResource = null;
    serverQueue.queueEnded = false;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
    serverQueue.pausedByEmptyChannel = false;

    if (isLavalinkEnabled() && !(serverQueue.is247 && keepConnectionFor247)) {
      await destroyLavalinkPlayer(guildId, reason);
      serverQueue.connection = null;
    } else if (serverQueue.connection && !(serverQueue.is247 && keepConnectionFor247)) {
      try {
        serverQueue.connection.destroy();
      } catch (error) {
        console.error('[Voice] destroy connection failed:', error.message);
      }
      serverQueue.connection = null;
    }

    if (notify && serverQueue.textChannel) {
      const message = reason === 'empty-channel'
        ? '👋 语音频道 30 分钟无人或无新指令，已离开并清空队列。'
        : reason === 'bot-disconnected'
          ? '👋 我已离开语音频道，播放队列已清空。'
          : '👋 30 分钟内没有新指令，已离开语音频道并清空队列。';
      sendToChannel(serverQueue.textChannel, message);
    }

    if (serverQueue.is247 && keepConnectionFor247) {
      serverQueue.clearingQueue = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
    } else {
      musicQueue.delete(guildId);
      deletePlaybackState(guildId);
    }
    return true;
  }

  static destroyVoiceConnection(guildId, serverQueue, { keepQueue = true } = {}) {
    this.cleanupProcesses(serverQueue);
    serverQueue.playing = false;
    serverQueue.player = null;
    serverQueue.audioResource = null;
    if (isLavalinkEnabled()) {
      destroyLavalinkPlayer(guildId, 'voice-connection-destroyed').catch(error => {
        console.error('[Lavalink] destroy connection failed:', error.message);
      });
      serverQueue.connection = null;
      if (!keepQueue) {
        serverQueue.songs = [];
        serverQueue.radioQueue = [];
        serverQueue.radioFailureCount = 0;
        serverQueue.suppressRadioUntilManualPlay = false;
        serverQueue.suppressRadioUntilManualQueueEnds = false;
        musicQueue.delete(guildId);
      }
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return;
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
      musicQueue.delete(guildId);
    }
    savePlaybackState(guildId, serverQueue, { immediate: true });
  }

  static async recoverVoiceConnection(guildId, reason = 'unknown') {
    if (isLavalinkEnabled()) return;
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return;
    if (serverQueue.clearingQueue) return;
    if (Date.now() < (serverQueue.suppressVoiceRecoveryUntil || 0)) return;
    if (!serverQueue.is247 && serverQueue.queueEnded) return;
    if (!serverQueue.is247 && !serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0) return;
    if (serverQueue.reconnectingVoice) return;
    if (!serverQueue.voiceChannelId) return;

    serverQueue.reconnectingVoice = true;
    serverQueue.voiceReconnectAttempts = (serverQueue.voiceReconnectAttempts || 0) + 1;
    const attempt = serverQueue.voiceReconnectAttempts;

    try {
      console.warn(`[Voice] Recovering voice connection after ${reason}, attempt ${attempt}`);
      const guild = serverQueue.textChannel?.guild
        || serverQueue.textChannel?.client?.guilds?.cache?.get(guildId);
      if (!guild) {
        console.warn(`[Voice] recovery aborted: cannot resolve guild ${guildId}`);
        return;
      }
      const voiceChannel = guild.channels.cache.get(serverQueue.voiceChannelId)
        || await guild.channels.fetch(serverQueue.voiceChannelId).catch(() => null);
      if (!voiceChannel?.isVoiceBased?.()) {
        console.warn(`[Voice] recovery aborted: voice channel ${serverQueue.voiceChannelId} not found`);
        return;
      }

      this.destroyVoiceConnection(guildId, serverQueue, { keepQueue: true });
      if (attempt > 3) {
        serverQueue.voiceReconnectAttempts = 0;
        if (serverQueue.is247) {
          serverQueue.textChannel?.send('⚠️ 语音连接连续恢复失败，将在 60 秒后再次尝试...').catch(() => {});
          // 24/7 模式：延迟重试，不永久放弃
          setTimeout(() => {
            const sq = musicQueue.peek(guildId);
            if (sq && sq.is247 && !sq.connection) {
              this.recoverVoiceConnection(guildId, 'delayed-retry-247').catch(() => {});
            }
          }, 60_000);
        } else {
          serverQueue.textChannel?.send('⚠️ 语音连接连续恢复失败，请稍后重新使用 /play。').catch(() => {});
        }
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      serverQueue.connection = await this.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator);
      if (serverQueue.currentSong && serverQueue.textChannel) {
        await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: getPlaybackProgressSeconds(serverQueue),
          suppressNowPlaying: true,
        });
      }
    } catch (error) {
      console.error('[Voice] recovery failed:', error.message);
    } finally {
      serverQueue.reconnectingVoice = false;
    }
  }

  static async joinVoice(voiceChannel, guildId, adapterCreator, options = {}) {
    if (isLavalinkEnabled() && !options.forceLocal) {
      console.log('[Lavalink] Joining channel:', voiceChannel.name, '(' + voiceChannel.id + ')');
      const serverQueue = musicQueue.get(guildId);
      serverQueue.voiceChannelId = voiceChannel.id;
      serverQueue.connection = lavalinkConnectionShim(voiceChannel.id);
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
    const serverQueue = musicQueue.get(guildId);
    serverQueue.voiceChannelId = voiceChannel.id;

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
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      }
      console.log('[Voice] Connection ready, state:', connection.state.status);
      timingLog(timingStartedAt, 'voice connection ready');
    } catch (error) {
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
        const serverQueue = musicQueue.peek(guildId);
        if (!serverQueue) return;
        serverQueue.connection = null;
        serverQueue.player = null;
        serverQueue.audioResource = null;
        serverQueue.playing = false;
        serverQueue.activeBackend = null;
        serverQueue.advancing = false;
        this.recoverVoiceConnection(guildId, 'Disconnected').catch(error => {
          console.error('[Voice] disconnected recovery failed:', error.message);
        });
      }
    });

    return connection;
  }

  static async skip(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return { ok: false, reason: 'no-queue' };

    const next = await this.resolveNextSongForSkip(guildId, serverQueue);
    if (!next.ok) {
      if (next.reason === 'no-radio-recommendation' && serverQueue.radio?.enabled) {
        savePlaybackState(guildId, serverQueue);
      }
      return next;
    }

    const backend = this.activeBackend(serverQueue);
    if (backend === 'lavalink') {
      serverQueue.skipRequested = true;
      serverQueue.suppressNextIdleAdvance = true;
      try {
        await this.playSong(guildId, serverQueue.textChannel, next.song, next.source);
      } catch (error) {
        console.error('[Skip/Lavalink] playSong failed after suppress, forcing advance:', error.message);
        serverQueue.suppressNextIdleAdvance = false;
        this.advance(guildId, serverQueue);
      }
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { ok: true, song: next.song, source: next.source };
    }
    if (serverQueue.ffmpegProcess) {
      serverQueue.skipRequested = true;
      this.unpipeAudio(serverQueue);
      serverQueue.ffmpegProcess.kill();
      serverQueue.ffmpegProcess = null;
    }
    if (serverQueue.ytdlpProcess) {
      serverQueue.skipRequested = true;
      this.unpipeAudio(serverQueue);
      serverQueue.ytdlpProcess.kill();
      serverQueue.ytdlpProcess = null;
    }
    if (serverQueue.player) {
      serverQueue.skipRequested = true;
      serverQueue.suppressNextIdleAdvance = true;
      serverQueue.player.stop(true);
      try {
        await this.playSong(guildId, serverQueue.textChannel, next.song, next.source);
      } catch (error) {
        console.error('[Skip/Local] playSong failed after suppress, forcing advance:', error.message);
        serverQueue.suppressNextIdleAdvance = false;
        this.advance(guildId, serverQueue);
      }
      return { ok: true, song: next.song, source: next.source };
    }
    // player 不存在但有进程被杀掉了，手动触发 advance
    if (serverQueue.skipRequested) {
      serverQueue.suppressNextIdleAdvance = true;
      try {
        await this.playSong(guildId, serverQueue.textChannel, next.song, next.source);
      } catch (error) {
        console.error('[Skip/NoPlayer] playSong failed, forcing advance:', error.message);
        serverQueue.suppressNextIdleAdvance = false;
        this.advance(guildId, serverQueue);
      }
      return { ok: true, song: next.song, source: next.source };
    }
    return { ok: false, reason: 'no-player' };
  }

  static async previous(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue?.currentSong) return { ok: false, reason: 'no-current-song' };

    const previousSong = serverQueue.history.pop();
    if (!previousSong) return { ok: false, reason: 'no-history' };

    if (serverQueue.currentSong) {
      serverQueue.songs.unshift(serverQueue.currentSong);
    }

    serverQueue.skipRequested = true;
    serverQueue.suppressNextIdleAdvance = true;
    serverQueue.queueEnded = false;
    this.cleanupProcesses(serverQueue);
    if (isLavalinkEnabled()) {
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
      await this.playSong(guildId, serverQueue.textChannel, previousSong, previousSong.source || 'manual');
    } catch (error) {
      console.error('[Previous] playSong failed after suppress, forcing advance:', error.message);
      serverQueue.suppressNextIdleAdvance = false;
      this.advance(guildId, serverQueue);
    }
    savePlaybackState(guildId, serverQueue, { immediate: true });
    return { ok: true, song: previousSong };
  }

  static pause(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    const backend = this.activeBackend(serverQueue);
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player && !serverQueue.player) return false;
      if (!player && serverQueue.player) {
        serverQueue.player.pause();
        markPlaybackPaused(serverQueue);
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return true;
      }
      player.pause().catch(error => console.error('[Lavalink] pause failed:', error.message));
      markPlaybackPaused(serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    if (serverQueue.player) {
      serverQueue.player.pause();
      markPlaybackPaused(serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    return false;
  }

  static resume(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    const backend = this.activeBackend(serverQueue);
    if (backend === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player && !serverQueue.player) return false;
      if (!player && serverQueue.player) {
        serverQueue.player.unpause();
        markPlaybackResumed(serverQueue);
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return true;
      }
      player.resume().catch(error => console.error('[Lavalink] resume failed:', error.message));
      markPlaybackResumed(serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    if (serverQueue.player) {
      serverQueue.player.unpause();
      markPlaybackResumed(serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    return false;
  }

  static setVolume(guildId, volume) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    serverQueue.volume = volume;
    if (this.activeBackend(serverQueue) === 'lavalink') {
      getLavalinkPlayer(guildId)?.setVolume(Math.max(0, Number(volume) || 0), true).catch(error => {
        console.error('[Lavalink] set volume failed:', error.message);
      });
      serverQueue.audioResource?.volume?.setVolume(Math.max(0, Number(volume) || 0) / 100);
      savePlaybackState(guildId, serverQueue);
      return true;
    }
    serverQueue.audioResource?.volume?.setVolume(Math.max(0, Number(volume) || 0) / 100);
    savePlaybackState(guildId, serverQueue);
    return true;
  }

  static async setFilter(guildId, mode) {
    const normalized = normalizeFilterMode(mode);
    if (!normalized) return false;
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    serverQueue.filters = { active: normalized };
    if (isLavalinkEnabled()) {
      const player = getLavalinkPlayer(guildId);
      if (player) await applyLavalinkFilter(player, normalized);
      savePlaybackState(guildId, serverQueue);
      return true;
    }
    if (serverQueue.currentSong && serverQueue.playing) {
      const seekSeconds = getPlaybackProgressSeconds(serverQueue);
      await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
        seekSeconds,
        suppressNowPlaying: true,
      });
      return true;
    }
    savePlaybackState(guildId, serverQueue);
    return true;
  }

  static async seek(guildId, seconds) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!serverQueue.currentSong) return false;
    if (this.activeBackend(serverQueue) === 'lavalink') {
      const player = getLavalinkPlayer(guildId);
      if (!player) {
        if (!serverQueue.player) return false;
        await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: seconds,
          suppressNowPlaying: true,
          forceLocal: true,
        });
        return true;
      }
      await player.seek(Math.max(0, Math.floor((Number(seconds) || 0) * 1000)));
      markPlaybackStarted(serverQueue, seconds);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    await this.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
      seekSeconds: seconds,
      suppressNowPlaying: true,
    });
    return true;
  }

  static stop(guildId) {
    const serverQueue = musicQueue.peek(guildId);
    if (!serverQueue) return false;
    if (!serverQueue.is247) {
      this.clearQueueAndLeave(guildId, 'stop-command', { notify: false });
      return true;
    }

    this.clearIdleLeaveTimer(serverQueue);
    serverQueue.songs = [];
    serverQueue.radioQueue = [];
    serverQueue.radio.enabled = false;
    serverQueue.radio.pendingStyle = null;
    serverQueue.radio.seedSong = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    serverQueue.suppressRadioUntilManualQueueEnds = false;
    this.resetLavalinkStart(serverQueue);
    serverQueue.playing = false;
    serverQueue.activeBackend = null;
    this.cleanupLocalProcesses(serverQueue);
    if (isLavalinkEnabled()) {
      getLavalinkPlayer(guildId)?.stopPlaying(true, false).catch(error => {
        console.error('[Lavalink] stop failed:', error.message);
      });
      serverQueue.currentSong = null;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return true;
    }
    this.cleanupLocalProcesses(serverQueue);
    if (serverQueue.player) {
      serverQueue.player.stop();
    }
    serverQueue.audioResource = null;
    serverQueue.currentSong = null;
    serverQueue.seekOffsetSeconds = 0;
    serverQueue.startedAt = null;
    serverQueue.pausedAt = null;
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
