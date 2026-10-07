import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { GuildSettings } from '../models/database.js';
import { musicQueue, MusicPlayer } from './player.js';
import { enqueueSongs } from './playback.js';
import { refreshNowPlayingPanel } from './playerPanel.js';
import { YouTube } from './youtube.js';
import { normalizeVoiceText, parseVoiceCommand, voiceCommandKeyterms } from './voiceCommandParser.js';
import { parseAIVoiceIntent, voiceAIConfigStatus } from './voiceIntent.js';
import { canUseVoiceControl } from './voicePermissions.js';
import { createVoiceStt } from './voiceStt.js';
import { deletePlaybackState, savePlaybackState } from './playbackState.js';
import { isVoiceSttAllowed, voiceConsentStatus } from './voiceConsent.js';
import { createVoiceOpusDecoder } from './voiceOpus.js';

const MIN_AUDIO_MS = 300;
const MAX_AUDIO_MS = 10_000;
const SILENCE_MS = 800;
const RATE_WINDOW_MS = 60_000;
const MAX_CONCURRENT_PER_GUILD = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_GUILD_JOBS) || 4);
const MAX_CONCURRENT_GLOBAL = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_GLOBAL_JOBS) || 4);
const USER_COOLDOWN_MS = 1_500;
const DEDUPE_MS = 5_000;
const FOCUS_WINDOW_MS = 8_000;
const AI_FOCUS_WINDOW_MS = 12_000;
const AI_CONFIDENCE_THRESHOLD = Math.max(0.5, Math.min(1, Number(process.env.VOICE_CONTROL_AI_CONFIDENCE) || 0.88));
const FEEDBACK_COOLDOWN_MS = 15_000;
const GUILD_FEEDBACK_COOLDOWN_MS = 5_000;
const COMMAND_DEADLINE_MS = Math.max(1_000, Math.min(60_000, Number(process.env.VOICE_CONTROL_COMMAND_DEADLINE_MS) || 30_000));
const SEARCH_DEADLINE_MS = Math.max(1_000, Math.min(30_000, Number(process.env.VOICE_CONTROL_SEARCH_DEADLINE_MS) || 15_000));
const DUCK_DEADLINE_MS = Math.max(250, Math.min(10_000, Number(process.env.VOICE_CONTROL_DUCK_DEADLINE_MS) || 2_000));
const FOCUS_HARD_DEADLINE_MS = Math.max(FOCUS_WINDOW_MS, Math.min(60_000, Number(process.env.VOICE_CONTROL_FOCUS_DEADLINE_MS) || 45_000));
const VOLUME_RESTORE_DEADLINE_MS = Math.max(500, Math.min(15_000, Number(process.env.VOICE_CONTROL_VOLUME_RESTORE_DEADLINE_MS) || 5_000));
const MAP_CLEANUP_INTERVAL_MS = Math.max(10_000, Math.min(RATE_WINDOW_MS, Number(process.env.VOICE_CONTROL_MAP_CLEANUP_MS) || 60_000));
const MAX_AI_CONCURRENT = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_AI_JOBS) || 2);
const MAX_AI_PER_USER_MINUTE = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_AI_PER_USER_MINUTE) || 4);
const MAX_AI_PER_GUILD_MINUTE = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_AI_PER_GUILD_MINUTE) || 12);
const MAX_SEGMENTS_PER_USER_MINUTE = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_USER_SEGMENTS_PER_MINUTE) || 12);
const MAX_SEGMENTS_PER_GUILD_MINUTE = Math.max(1, Number(process.env.VOICE_CONTROL_MAX_GUILD_SEGMENTS_PER_MINUTE) || 60);
const VOLUME_RESTORE_RETRY_MS = 1_500;
const VOLUME_RESTORE_ATTEMPTS = 3;
const DUCK_VOLUME = Math.max(0, Math.min(100, Number(process.env.VOICE_CONTROL_DUCK_VOLUME) || 15));
const VOICE_CONTROL_DEBUG = process.env.VOICE_CONTROL_DEBUG === '1';
const MAX_BAD_OPUS_RATIO = 0.5;
const MIN_OPUS_PACKETS_FOR_RATIO = 5;
const CONTROL_TERMS = [...new Set(voiceCommandKeyterms('mixed'))]
  .map(term => normalizeVoiceText(term).replace(/\s+/g, ''))
  .filter(Boolean)
  .sort((left, right) => right.length - left.length);

function safeErrorLabel(error) {
  const name = String(error?.name || 'Error').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'Error';
  const status = Number(error?.status || error?.statusCode);
  return Number.isInteger(status) && status > 0 ? `${name}:${status}` : name;
}

function configuredSecret(value) {
  const secret = String(value || '').trim();
  return Boolean(secret && !/^your[_-].*(?:token|key|here)$/i.test(secret));
}

function timeoutError(label) {
  const error = new Error(label);
  error.name = 'TimeoutError';
  return error;
}

async function withDeadline(task, timeoutMs, onTimeout = null) {
  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        onTimeout?.();
      } catch {
        // Deadline cleanup must not mask the timeout.
      }
      reject(timeoutError('voice operation deadline exceeded'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(task), timeout]);
  } finally {
    clearTimeout(timer);
    if (timedOut) timer = null;
  }
}

function voiceDebug(...args) {
  if (VOICE_CONTROL_DEBUG) console.log('[VoiceControlDebug]', ...args);
}

function audioDurationMs(pcmLength, format) {
  return pcmLength / (format.sampleRate * format.channels * format.bytesPerSample) * 1000;
}

function createSttStatus() {
  return {
    lastAudioAt: null,
    lastAudioDurationMs: null,
    lastAudioBytes: 0,
    lastAudioChunks: 0,
    opusDecoderBackend: null,
    lastOpusAt: null,
    lastOpusPackets: 0,
    lastOpusDecodedPackets: 0,
    lastOpusDroppedPackets: 0,
    lastOpusConsecutiveErrors: 0,
    lastOpusError: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastOutcomeAt: null,
    lastOutcome: null,
    lastOutcomeDetail: null,
    lastProbeAt: null,
    lastProbeOk: null,
    lastProbeDetail: null,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    lastWakeAt: null,
    lastCommandAt: null,
    lastCommand: null,
    ignoredForFocus: 0,
    ignoredForGuildConcurrency: 0,
    ignoredForGlobalConcurrency: 0,
    lastAiAt: null,
    lastAiConfidence: null,
    aiCommands: 0,
    aiRejected: 0,
    aiUnavailable: 0,
    fuzzyWakeCount: 0,
    promptLeakRejected: 0,
    ignoredForRateLimit: 0,
    aiRateLimited: 0,
    lastIgnoredAt: null,
    lastIgnoredReason: null,
    lastCommandResult: null,
    pendingQueued: 0,
    pendingProcessed: 0,
    pendingDropped: 0,
    busyIgnored: 0,
    lastPendingAt: null,
    lastPendingState: null,
  };
}

function finitePcmStream(pcm, onCancel) {
  let closeTimer = null;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(pcm));
      closeTimer = setImmediate(() => {
        closeTimer = null;
        try {
          controller.close();
        } catch {
          // The provider may have cancelled the finite input first.
        }
      });
    },
    cancel(reason) {
      clearImmediate(closeTimer);
      onCancel?.(reason);
    },
  });
}

function unavailableVoiceStt() {
  const format = {
    type: 'audio/pcm',
    sampleRate: 24_000,
    channels: 1,
    bytesPerSample: 2,
    frameSize: 480,
  };
  return {
    provider: 'unsupported',
    model: null,
    configured: () => false,
    audioFormat: () => format,
    supportsStreamingInput: () => false,
    healthCheck: async () => ({ ok: false, detail: 'STT provider unavailable' }),
  };
}

export function isVoiceListenerEnabled(value = process.env.VOICE_LISTENER_ENABLED) {
  return value === 'true';
}

export function hasVoiceListenerIdentityConflict(mainUserId, listenerUserId) {
  return Boolean(mainUserId && listenerUserId && mainUserId === listenerUserId);
}

export function hasVoiceListenerTokenConflict(listenerToken = process.env.VOICE_LISTENER_TOKEN, mainToken = process.env.DISCORD_TOKEN) {
  const listener = String(listenerToken || '').trim();
  const main = String(mainToken || '').trim();
  return Boolean(listener && main && listener === main);
}

export function mainBotVoiceChannelId(mainGuild) {
  return mainGuild?.members?.me?.voice?.channelId || null;
}

export function shouldVoiceListenerJoin(settings, mainChannelId, listenerGuild) {
  const voiceControl = settings?.voiceControl || settings || {};
  const listenerAutoJoin = Object.prototype.hasOwnProperty.call(voiceControl, 'listenerAutoJoin')
    ? voiceControl.listenerAutoJoin === true
    : voiceControl.enabled === true;
  return Boolean(
    voiceControl.enabled === true
    && listenerAutoJoin
    && mainChannelId
    && listenerGuild,
  );
}

export function looksLikeSttPromptLeak(value) {
  const text = normalizeVoiceText(value).replace(/\s+/g, '');
  if (!text) return false;
  const matchedTerms = CONTROL_TERMS.filter(term => text.includes(term));
  return matchedTerms.length >= 4;
}

export function isSafeVoicePlayQuery(value) {
  const text = normalizeVoiceText(value).replace(/\s+/g, '');
  if (!text || looksLikeSttPromptLeak(text)) return false;
  const matchedTerms = CONTROL_TERMS.filter(term => text.includes(term));
  if (matchedTerms.length === 0) return true;
  let remainder = text;
  for (const term of matchedTerms) remainder = remainder.replaceAll(term, '');
  return remainder.length >= 2;
}

function commandResultText(command, result) {
  if (command === 'play') {
    if (!result?.ok) {
      if (result?.reason === 'queue-full') return '点歌失败：队列已满';
      if (result?.reason === 'search-timeout') return `点歌失败：搜索超时：${result.query}`;
      if (result?.reason === 'not-found') return `点歌失败：未找到：${result.query}`;
      return '点歌失败';
    }
    if (result.started) return `已开始播放：${result.song.title}`;
    if (result.startPending) return `已加入队列，但播放器未确认起播：${result.song.title}`;
    if (result.queued) return `已加入队列：${result.song.title}`;
    return `点歌失败：播放器未确认起播：${result.song.title}`;
  }
  if (command === 'pause') return result.ok ? '已暂停播放' : '暂停失败，当前可能没有可暂停的歌曲';
  if (command === 'resume') return result.ok ? '已继续播放' : '继续失败，当前可能没有暂停的歌曲';
  if (command === 'previous') {
    if (result.ok) return `已切换到上一首：${result.song.title}`;
    if (result.reason === 'no-history') return '切换失败：没有上一首';
    return '切换失败：当前没有正在播放的歌曲';
  }
  if (command === 'skip') {
    if (result.ok) return `已跳过，下一首：${result.song.title}`;
    if (result.reason === 'no-next-song') return '跳过失败：队列里没有下一首';
    if (result.reason === 'no-radio-recommendation') return '跳过失败：Radio 暂时没有下一首推荐';
    return '跳过失败';
  }
  return '命令执行完成';
}

export class VoiceListenerManager {
  constructor(mainClient, {
    stt = null,
    intentParser = parseAIVoiceIntent,
    opusDecoderFactory = createVoiceOpusDecoder,
  } = {}) {
    this.mainClient = mainClient;
    this.sttProviderRejected = false;
    if (stt) {
      this.stt = stt;
    } else {
      try {
        this.stt = createVoiceStt();
      } catch (error) {
        voiceDebug(`stt-provider-rejected reason=${safeErrorLabel(error)}`);
        this.sttProviderRejected = true;
        this.stt = unavailableVoiceStt();
      }
    }
    this.intentParser = intentParser;
    this.opusDecoderFactory = opusDecoderFactory;
    this.sttFormat = this.stt.audioFormat();
    this.sttStatus = createSttStatus();
    this.sttStatuses = new Map();
    this.client = null;
    this.connections = new Map();
    this.pendingConnections = new Map();
    this.syncing = new Map();
    this.recordings = new Map();
    this.pendingRecordings = new Map();
    this.pendingSegments = new Map();
    this.processing = new Map();
    this.reservations = new Set();
    this.globalReservations = 0;
    this.cooldowns = new Map();
    this.feedbackCooldowns = new Map();
    this.guildFeedbackCooldowns = new Map();
    this.intentProcessing = new Map();
    this.aiProcessing = 0;
    this.segmentRates = new Map();
    this.aiRates = new Map();
    this.wakeWindows = new Map();
    this.fuzzyWakeWindows = new Set();
    this.operationGenerations = new Map();
    this.operationGenerationTimes = new Map();
    this.operationContexts = new Map();
    this.settingsRevisionSignatures = new Map();
    this.settingsRevisions = new Map();
    this.settingsRevisionTimes = new Map();
    this.focuses = new Map();
    this.executingCommands = new Set();
    this.commandLocks = new Set();
    this.recentCommands = new Map();
    this.globalProcessing = 0;
    this.syncInterval = null;
    this.mapCleanupInterval = null;
    this.started = false;
    this.stopping = false;
    this.lifecycleGeneration = 0;
    this.identityConflict = false;
    this.boundMainVoiceSync = (oldState, newState) => {
      if (newState.id !== this.mainClient.user?.id || oldState.channelId === newState.channelId) return;
      this.abortGuildRecordings(newState.guild.id);
      this.syncGuild(newState.guild.id).catch(error => console.error('[VoiceListener] main voice sync failed:', safeErrorLabel(error)));
    };
    this.boundListenerVoiceSync = (oldState, newState) => {
      if (newState.id !== this.client?.user?.id || oldState.channelId === newState.channelId) return;
      this.syncGuild(newState.guild.id).catch(error => console.error('[VoiceListener] listener voice sync failed:', safeErrorLabel(error)));
    };
    this.boundListenerGuildCreate = guild => {
      this.syncGuild(guild.id).catch(error => console.error('[VoiceListener] guild join sync failed:', safeErrorLabel(error)));
    };
    this.boundListenerGuildDelete = guild => {
      this.disconnectGuild(guild.id);
    };
  }

  configured() {
    return isVoiceListenerEnabled()
      && configuredSecret(process.env.VOICE_LISTENER_TOKEN)
      && !hasVoiceListenerTokenConflict()
      && !this.sttProviderRejected
      && typeof this.stt.configured === 'function'
      && this.stt.configured() === true;
  }

  hasVoiceConsent(guildId, userId, settings = GuildSettings.get(guildId).voiceControl) {
    return isVoiceSttAllowed(settings, userId);
  }

  sttStatusFor(guildId = null) {
    if (!guildId) return this.sttStatus;
    let status = this.sttStatuses.get(guildId);
    if (!status) {
      status = createSttStatus();
      this.sttStatuses.set(guildId, status);
    }
    return status;
  }

  recordSttOutcome(guildId, outcome, detail = null) {
    const status = this.sttStatusFor(guildId);
    status.lastOutcomeAt = Date.now();
    status.lastOutcome = outcome;
    status.lastOutcomeDetail = detail ? String(detail).replace(/\s+/g, ' ').slice(0, 160) : null;
  }

  recordAudioStats(guildId, pcmBytes, pcmChunks) {
    const status = this.sttStatusFor(guildId);
    status.lastAudioAt = Date.now();
    status.lastAudioBytes = pcmBytes;
    status.lastAudioChunks = pcmChunks;
    status.lastAudioDurationMs = Math.round(audioDurationMs(pcmBytes, this.sttFormat));
    return status.lastAudioDurationMs;
  }

  recordOpusStats(recording) {
    const decoderStats = recording.decoder?.diagnostics?.() || {};
    recording.opusPackets = decoderStats.totalPackets ?? recording.opusPackets ?? 0;
    recording.opusDecodedPackets = decoderStats.decodedPackets ?? recording.opusDecodedPackets ?? 0;
    recording.opusDroppedPackets = decoderStats.droppedPackets ?? recording.opusDroppedPackets ?? 0;
    recording.opusConsecutiveErrors = decoderStats.consecutiveErrors ?? recording.opusConsecutiveErrors ?? 0;
    recording.lastOpusError = decoderStats.lastError ?? recording.lastOpusError ?? null;
    const status = this.sttStatusFor(recording.guildId);
    status.opusDecoderBackend = decoderStats.backend || recording.decoder?.backend || status.opusDecoderBackend;
    status.lastOpusAt = recording.opusPackets > 0 ? Date.now() : status.lastOpusAt;
    status.lastOpusPackets = recording.opusPackets;
    status.lastOpusDecodedPackets = recording.opusDecodedPackets;
    status.lastOpusDroppedPackets = recording.opusDroppedPackets;
    status.lastOpusConsecutiveErrors = recording.opusConsecutiveErrors;
    status.lastOpusError = recording.lastOpusError;
  }

  recordIgnored(guildId, reason = null) {
    if (reason === null) {
      reason = guildId;
      guildId = null;
    }
    const status = this.sttStatusFor(guildId);
    status.lastIgnoredAt = Date.now();
    status.lastIgnoredReason = reason;
  }

  revokeUserConsent(guildId, userId) {
    this.abortUserVoiceWork(guildId, userId);
  }

  diagnostics(guildId = null) {
    const entry = guildId ? this.connections.get(guildId) : null;
    const voiceControl = guildId ? GuildSettings.get(guildId).voiceControl : null;
    const status = this.sttStatusFor(guildId);
    return {
      listenerEnabled: isVoiceListenerEnabled(),
      tokenConfigured: Boolean(process.env.VOICE_LISTENER_TOKEN),
      tokenConflict: hasVoiceListenerTokenConflict(),
      sttConfigured: this.stt.configured() === true,
      sttProvider: this.stt.provider,
      sttModel: this.stt.model,
      sttAccessMode: guildId ? voiceConsentStatus(guildId).sttAccessMode : 'off',
      cloudSttEnabled: guildId ? voiceConsentStatus(guildId).cloudSttEnabled : false,
      consentedUserCount: guildId ? voiceConsentStatus(guildId).consentedUserCount : 0,
      optedOutUserCount: guildId ? voiceConsentStatus(guildId).optedOutUserCount : 0,
      sttAudioFormat: `${this.sttFormat.type} ${this.sttFormat.sampleRate}Hz mono`,
      aiConfigured: voiceAIConfigStatus().ok,
      aiModel: voiceAIConfigStatus().model,
      aiConfidenceThreshold: AI_CONFIDENCE_THRESHOLD,
      sttStatus: {
        ...status,
        lastProbeAt: this.sttStatus.lastProbeAt,
        lastProbeOk: this.sttStatus.lastProbeOk,
        lastProbeDetail: this.sttStatus.lastProbeDetail,
      },
      listenerReady: Boolean(this.client?.isReady()),
      listenerUser: this.client?.user?.tag || null,
      listenerAutoJoin: voiceControl?.listenerAutoJoin !== false,
      connectionCount: this.connections.size,
      guildConnected: Boolean(entry?.connection?.state?.status === VoiceConnectionStatus.Ready),
      guildChannelId: entry?.channelId || null,
      focusUserId: this.activeFocus(guildId)?.userId || null,
      focusExpiresAt: this.activeFocus(guildId)?.expiresAt || null,
      activeRecordings: guildId
        ? [...new Set([
            ...this.recordings.keys(),
            ...this.pendingRecordings.keys(),
            ...this.pendingSegments.keys(),
            ...this.processing.keys(),
            ...this.intentProcessing.keys(),
          ])].filter(key => key.startsWith(`${guildId}:`)).length
        : new Set([
            ...this.recordings.keys(),
            ...this.pendingRecordings.keys(),
            ...this.pendingSegments.keys(),
            ...this.processing.keys(),
            ...this.intentProcessing.keys(),
          ]).size,
    };
  }

  async probeStt() {
    this.sttStatus.lastProbeAt = Date.now();
    try {
      const result = await this.stt.healthCheck();
      this.sttStatus.lastProbeOk = result.ok;
      this.sttStatus.lastProbeDetail = String(result.detail || '').replace(/\s+/g, ' ').slice(0, 160);
      if (!result.ok) throw new Error(result.detail || 'STT health check failed');
      return result;
    } catch (error) {
      this.sttStatus.lastProbeOk = false;
      this.sttStatus.lastProbeDetail = safeErrorLabel(error);
      this.recordSttFailure(error);
      return { ok: false, detail: safeErrorLabel(error) };
    }
  }

  recordSttFailure(guildId, error = null) {
    if (error === null) {
      error = guildId;
      guildId = null;
    }
    const status = this.sttStatusFor(guildId);
    status.lastErrorAt = Date.now();
    status.lastError = safeErrorLabel(error);
    status.consecutiveFailures += 1;
    if (status.consecutiveFailures >= 3) {
      status.circuitOpenUntil = Date.now() + 60_000;
    }
  }

  recordSttSuccess(guildId = null) {
    const status = this.sttStatusFor(guildId);
    status.lastSuccessAt = Date.now();
    status.lastError = null;
    status.consecutiveFailures = 0;
    status.circuitOpenUntil = 0;
  }

  async start() {
    if (this.started || !this.configured()) {
      if (!this.configured()) {
        const reason = !isVoiceListenerEnabled()
          ? 'VOICE_LISTENER_ENABLED 未显式设置为 true'
          : hasVoiceListenerTokenConflict()
            ? 'VOICE_LISTENER_TOKEN 不得与 DISCORD_TOKEN 相同'
            : !configuredSecret(process.env.VOICE_LISTENER_TOKEN)
              ? 'VOICE_LISTENER_TOKEN 未配置真实密钥'
              : 'STT provider 未完整配置';
        console.log(`[VoiceListener] ${reason}，语音控制监听已禁用`);
      }
      return false;
    }
    if (hasVoiceListenerTokenConflict()) {
      console.error('[VoiceListener] VOICE_LISTENER_TOKEN 与 DISCORD_TOKEN 相同，已拒绝启动');
      return false;
    }
    this.identityConflict = false;
    this.stopping = false;
    this.lifecycleGeneration += 1;
    this.started = true;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    this.client.once(Events.ClientReady, () => {
      if (hasVoiceListenerIdentityConflict(this.mainClient.user?.id, this.client.user?.id)) {
        this.identityConflict = true;
        console.error('[VoiceListener] 监听 Bot 与主 Bot 使用了相同账号，已拒绝启动');
        this.stop().catch(() => {});
        return;
      }
      console.log(`[VoiceListener] ${this.client.user.tag} 已上线`);
      this.syncAll().catch(error => console.error('[VoiceListener] initial sync failed:', safeErrorLabel(error)));
      clearInterval(this.syncInterval);
      this.syncInterval = setInterval(() => {
        this.syncAll().catch(error => console.error('[VoiceListener] periodic sync failed:', safeErrorLabel(error)));
      }, 30_000);
      this.syncInterval.unref?.();
      clearInterval(this.mapCleanupInterval);
      this.mapCleanupInterval = setInterval(() => this.cleanupMaps(), MAP_CLEANUP_INTERVAL_MS);
      this.mapCleanupInterval.unref?.();
    });
    this.client.on(Events.VoiceStateUpdate, this.boundListenerVoiceSync);
    this.client.on(Events.GuildCreate, this.boundListenerGuildCreate);
    this.client.on(Events.GuildDelete, this.boundListenerGuildDelete);
    this.mainClient.on(Events.VoiceStateUpdate, this.boundMainVoiceSync);
    try {
      await this.client.login(process.env.VOICE_LISTENER_TOKEN);
      if (hasVoiceListenerIdentityConflict(this.mainClient.user?.id, this.client?.user?.id)) {
        this.identityConflict = true;
        await this.stop();
        return false;
      }
      return !this.identityConflict;
    } catch (error) {
      console.error('[VoiceListener] 登录失败，主 Bot 将继续运行:', safeErrorLabel(error));
      this.started = false;
      this.mainClient.off(Events.VoiceStateUpdate, this.boundMainVoiceSync);
      this.client.destroy();
      this.client = null;
      return false;
    }
  }

  async stop() {
    this.stopping = true;
    this.lifecycleGeneration += 1;
    clearInterval(this.syncInterval);
    this.syncInterval = null;
    clearInterval(this.mapCleanupInterval);
    this.mapCleanupInterval = null;
    this.mainClient.off(Events.VoiceStateUpdate, this.boundMainVoiceSync);
    if (this.client) {
      this.client.off(Events.VoiceStateUpdate, this.boundListenerVoiceSync);
      this.client.off(Events.GuildCreate, this.boundListenerGuildCreate);
      this.client.off(Events.GuildDelete, this.boundListenerGuildDelete);
    }
    await Promise.all([...this.focuses.keys()].map(guildId => this.releaseFocus(guildId)));
    const activeGuildIds = new Set([
      ...this.connections.keys(),
      ...[...this.pendingConnections.values()].map(entry => entry.guildId),
      ...this.syncing.keys(),
      ...[...this.recordings.keys()].map(key => key.split(':', 1)[0]),
      ...[...this.pendingRecordings.keys()].map(key => key.split(':', 1)[0]),
      ...[...this.pendingSegments.keys()].map(key => key.split(':', 1)[0]),
      ...[...this.processing.keys()].map(key => key.split(':', 1)[0]),
      ...[...this.intentProcessing.keys()].map(key => key.split(':', 1)[0]),
    ]);
    for (const guildId of activeGuildIds) this.disconnectGuild(guildId);
    await Promise.allSettled([...this.syncing.values()].map(state => state.promise));
    this.syncing.clear();
    for (const entry of this.pendingConnections.values()) this.destroyConnectionEntry(entry);
    this.pendingConnections.clear();
    this.client?.destroy();
    this.client = null;
    this.started = false;
  }

  isLifecycleCurrent(generation) {
    return this.started
      && !this.stopping
      && this.lifecycleGeneration === generation
      && Boolean(this.client?.isReady());
  }

  async syncAll() {
    if (!this.client?.isReady()) return;
    const guildIds = new Set([
      ...this.mainClient.guilds.cache.keys(),
      ...this.connections.keys(),
    ]);
    await Promise.all([...guildIds].map(guildId => this.syncGuild(guildId)));
  }

  async syncGuild(guildId) {
    const existingSync = this.syncing.get(guildId);
    if (existingSync) {
      existingSync.requested = true;
      return existingSync.promise;
    }
    const state = { requested: false, promise: null };
    const sync = (async () => {
      do {
        state.requested = false;
        await this.performGuildSync(guildId);
      } while (state.requested);
    })().finally(() => {
      if (this.syncing.get(guildId) === state) this.syncing.delete(guildId);
    });
    state.promise = sync;
    this.syncing.set(guildId, state);
    return sync;
  }

  async performGuildSync(guildId) {
    const lifecycleGeneration = this.lifecycleGeneration;
    if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
    const settings = GuildSettings.get(guildId).voiceControl;
    const mainGuild = this.mainClient.guilds.cache.get(guildId);
    const listenerGuild = this.client.guilds.cache.get(guildId);
    const mainChannelId = mainBotVoiceChannelId(mainGuild);
    if (!shouldVoiceListenerJoin(settings, mainChannelId, listenerGuild)) {
      this.disconnectGuild(guildId);
      return;
    }

    const existing = this.connections.get(guildId);
    const listenerChannelId = listenerGuild.members?.me?.voice?.channelId || null;
    if (existing?.channelId === mainChannelId
      && listenerChannelId === mainChannelId
      && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) return;
    const channel = listenerGuild.channels.cache.get(mainChannelId)
      || await listenerGuild.channels.fetch(mainChannelId).catch(() => null);
    if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
    if (!channel?.isVoiceBased()) return;
    const permissions = channel.permissionsFor(listenerGuild.members?.me);
    if (!permissions?.has('ViewChannel') || !permissions.has('Connect')) {
      console.warn(`[VoiceListener] guild=${guildId} 缺少 ViewChannel 或 Connect 权限`);
      return;
    }

    const connection = joinVoiceChannel({
      channelId: mainChannelId,
      guildId,
      adapterCreator: listenerGuild.voiceAdapterCreator,
      group: `voice-listener:${this.client.user?.id || 'unknown'}`,
      selfMute: true,
      selfDeaf: false,
    });
    const speakingHandler = userId => this.onSpeakingStart(guildId, userId).catch(error => {
      console.error('[VoiceListener] speaking handler failed:', safeErrorLabel(error));
    });
    connection.receiver.speaking.on('start', speakingHandler);
    connection.on(VoiceConnectionStatus.Destroyed, () => this.abortGuildRecordings(guildId));
    const entry = { guildId, connection, channelId: mainChannelId, speakingHandler };
    this.pendingConnections.set(connection, entry);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      if (!this.isLifecycleCurrent(lifecycleGeneration)) {
        this.destroyConnectionEntry(entry);
        return;
      }
      const currentSettings = GuildSettings.get(guildId).voiceControl;
      const currentMainChannelId = mainBotVoiceChannelId(this.mainClient.guilds.cache.get(guildId));
      if (!shouldVoiceListenerJoin(currentSettings, currentMainChannelId, listenerGuild)
        || currentMainChannelId !== mainChannelId) {
        this.destroyConnectionEntry(entry);
        return;
      }
      const previous = this.connections.get(guildId);
      if (previous && previous !== entry) {
        this.abortGuildRecordings(guildId);
        this.connections.delete(guildId);
        this.destroyConnectionEntry(previous);
      }
      this.connections.set(guildId, entry);
      console.log(`[VoiceListener] guild=${guildId} 正在监听频道 ${mainChannelId}`);
    } catch (error) {
      console.warn(`[VoiceListener] guild=${guildId} 连接失败:`, safeErrorLabel(error));
      this.destroyConnectionEntry(entry);
    } finally {
      this.pendingConnections.delete(connection);
    }
  }

  destroyConnectionEntry(entry) {
    if (!entry) return;
    this.pendingConnections.delete(entry.connection);
    entry.connection.receiver?.speaking?.off('start', entry.speakingHandler);
    try {
      entry.connection.destroy();
    } catch {
      // Already destroyed by the voice library.
    }
  }

  disconnectGuild(guildId) {
    this.abortGuildRecordings(guildId);
    const entry = this.connections.get(guildId);
    if (entry) {
      this.connections.delete(guildId);
      this.destroyConnectionEntry(entry);
    }
    for (const pending of this.pendingConnections.values()) {
      if (pending.guildId === guildId) this.destroyConnectionEntry(pending);
    }
  }

  abortGuildRecordings(guildId) {
    for (const [key, recording] of this.recordings) {
      if (!key.startsWith(`${guildId}:`)) continue;
      this.invalidateOperation(key);
      recording.controller.abort(new DOMException('Guild recording cleanup', 'AbortError'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.recordings.delete(key);
      this.releaseReservation(key);
    }
    for (const [key, recording] of this.pendingRecordings) {
      if (!key.startsWith(`${guildId}:`)) continue;
      recording.controller.abort(new DOMException('Guild pending recording cleanup', 'AbortError'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.pendingRecordings.delete(key);
    }
    for (const key of this.pendingSegments.keys()) {
      if (!key.startsWith(`${guildId}:`)) continue;
      this.pendingSegments.delete(key);
      const status = this.sttStatusFor(guildId);
      status.pendingDropped += 1;
      status.lastPendingAt = Date.now();
      status.lastPendingState = 'aborted';
    }
    for (const [key, controller] of this.processing) {
      if (!key.startsWith(`${guildId}:`)) continue;
      this.invalidateOperation(key);
      controller.abort();
      this.processing.delete(key);
      this.operationContexts.delete(key);
    }
    for (const key of this.wakeWindows.keys()) {
      if (key.startsWith(`${guildId}:`)) this.wakeWindows.delete(key);
    }
    for (const key of this.fuzzyWakeWindows) {
      if (key.startsWith(`${guildId}:`)) this.fuzzyWakeWindows.delete(key);
    }
    for (const key of this.cooldowns.keys()) {
      if (key.startsWith(`${guildId}:`)) this.cooldowns.delete(key);
    }
    for (const key of this.feedbackCooldowns.keys()) {
      if (key.startsWith(`${guildId}:`)) this.feedbackCooldowns.delete(key);
    }
    this.guildFeedbackCooldowns.delete(guildId);
    for (const [key, controller] of this.intentProcessing) {
      if (!key.startsWith(`${guildId}:`)) continue;
      this.invalidateOperation(key);
      controller.abort(new DOMException('Guild voice control cleanup', 'AbortError'));
      this.intentProcessing.delete(key);
      this.operationContexts.delete(key);
    }
    for (const key of this.segmentRates.keys()) {
      if (key.startsWith(`${guildId}:`) || key === guildId) this.segmentRates.delete(key);
    }
    for (const key of this.aiRates.keys()) {
      if (key.startsWith(`${guildId}:`) || key === guildId) this.aiRates.delete(key);
    }
    for (const key of this.reservations) {
      if (!key.startsWith(`${guildId}:`)) continue;
      this.reservations.delete(key);
      this.globalReservations = Math.max(0, this.globalReservations - 1);
    }
    this.releaseFocus(guildId).catch(error => {
      console.warn('[VoiceListener] failed to release focus during cleanup:', safeErrorLabel(error));
    });
  }

  abortUserVoiceWork(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const recording = this.recordings.get(key);
    if (recording) {
      this.invalidateOperation(key);
      recording.controller.abort(new DOMException('Voice consent revoked', 'AbortError'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.recordings.delete(key);
      this.releaseReservation(key);
    }
    const pendingRecording = this.pendingRecordings.get(key);
    if (pendingRecording) {
      pendingRecording.controller.abort(new DOMException('Voice consent revoked', 'AbortError'));
      pendingRecording.stream.destroy();
      pendingRecording.decoder.destroy();
      clearTimeout(pendingRecording.maxTimer);
      this.pendingRecordings.delete(key);
    }
    if (this.pendingSegments.delete(key)) {
      const status = this.sttStatusFor(guildId);
      status.pendingDropped += 1;
      status.lastPendingAt = Date.now();
      status.lastPendingState = 'aborted';
    }
    const processing = this.processing.get(key);
    if (processing) {
      this.invalidateOperation(key);
      processing.abort(new DOMException('Voice consent revoked', 'AbortError'));
      this.processing.delete(key);
      this.operationContexts.delete(key);
    }
    const intent = this.intentProcessing.get(key);
    if (intent) {
      this.invalidateOperation(key);
      intent.abort(new DOMException('Voice consent revoked', 'AbortError'));
      this.intentProcessing.delete(key);
      this.operationContexts.delete(key);
    }
    this.wakeWindows.delete(key);
    this.fuzzyWakeWindows.delete(key);
    this.cooldowns.delete(key);
    this.feedbackCooldowns.delete(key);
    this.releaseFocus(guildId, userId).catch(error => {
      console.warn('[VoiceListener] failed to release revoked voice consent:', safeErrorLabel(error));
    });
  }

  settingsSignature(settings) {
    const voiceControl = settings?.voiceControl || settings || {};
    return JSON.stringify({
      enabled: voiceControl.enabled === true,
      listenerAutoJoin: voiceControl.listenerAutoJoin !== false,
      wakeWords: voiceControl.wakeWords || [],
      language: voiceControl.language || 'mixed',
      understandingMode: voiceControl.understandingMode || 'strict',
      permissionMode: 'everyone',
      allowedRoleIds: [],
      auditChannelId: voiceControl.auditChannelId || null,
      enabledCommands: voiceControl.enabledCommands || [],
      sttAccessMode: voiceControl.sttAccessMode || (voiceControl.cloudSttEnabled === false ? 'off' : 'everyone'),
      consentedUserIds: voiceControl.consentedUserIds || [],
      sttOptOutUserIds: voiceControl.sttOptOutUserIds || [],
    });
  }

  currentSettingsRevision(guildId, settings = GuildSettings.get(guildId).voiceControl) {
    const signature = this.settingsSignature(settings);
    const previousSignature = this.settingsRevisionSignatures.get(guildId);
    if (previousSignature !== signature) {
      this.settingsRevisionSignatures.set(guildId, signature);
      this.settingsRevisions.set(guildId, (this.settingsRevisions.get(guildId) || 0) + 1);
    }
    this.settingsRevisionTimes.set(guildId, Date.now());
    return this.settingsRevisions.get(guildId) || 1;
  }

  nextOperationGeneration(key) {
    const generation = (this.operationGenerations.get(key) || 0) + 1;
    this.operationGenerations.set(key, generation);
    this.operationGenerationTimes.set(key, Date.now());
    return generation;
  }

  invalidateOperation(key) {
    this.nextOperationGeneration(key);
    this.operationContexts.delete(key);
  }

  createOperationContext(guildId, userId, settings, signal, { bump = true, channelId = null } = {}) {
    const key = `${guildId}:${userId}`;
    const generation = bump ? this.nextOperationGeneration(key) : this.operationGenerations.get(key);
    const currentSettings = GuildSettings.get(guildId).voiceControl;
    const context = {
      key,
      guildId,
      userId,
      generation,
      settingsRevision: this.currentSettingsRevision(guildId, currentSettings),
      signal,
      channelId,
    };
    this.operationContexts.set(key, context);
    return context;
  }

  isOperationCurrent(context, { requireEnabled = false } = {}) {
    if (!context) return true;
    if (!context.signal || context.signal.aborted) return false;
    if (this.operationGenerations.get(context.key) !== context.generation) return false;
    const settings = GuildSettings.get(context.guildId).voiceControl;
    if (this.currentSettingsRevision(context.guildId, settings) !== context.settingsRevision) return false;
    if (context.channelId) {
      const guild = this.mainClient.guilds.cache.get(context.guildId);
      if (mainBotVoiceChannelId(guild) !== context.channelId) return false;
      if (this.connections.get(context.guildId)?.channelId !== context.channelId) return false;
      const member = guild?.members.cache.get(context.userId);
      const serverQueue = musicQueue.peek(context.guildId);
      if (!member || member.user?.bot || member.voice.channelId !== context.channelId
        || !canUseVoiceControl(member, settings, serverQueue)
        || !this.hasVoiceConsent(context.guildId, context.userId, settings)) return false;
    }
    return !requireEnabled || settings.enabled === true;
  }

  cleanupMaps(now = Date.now()) {
    const cleanupExpiryMap = map => {
      for (const [key, expiresAt] of map) {
        if (!Number.isFinite(expiresAt) || expiresAt <= now) map.delete(key);
      }
    };
    cleanupExpiryMap(this.cooldowns);
    cleanupExpiryMap(this.feedbackCooldowns);
    cleanupExpiryMap(this.guildFeedbackCooldowns);
    cleanupExpiryMap(this.recentCommands);
    cleanupExpiryMap(this.wakeWindows);
    for (const key of this.fuzzyWakeWindows) {
      if (!this.wakeWindows.has(key)) this.fuzzyWakeWindows.delete(key);
    }
    const cleanupRates = map => {
      for (const [key, timestamps] of map) {
        const active = timestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
        if (active.length) map.set(key, active);
        else map.delete(key);
      }
    };
    cleanupRates(this.segmentRates);
    cleanupRates(this.aiRates);
    for (const [key, touchedAt] of this.operationGenerationTimes) {
      if (now - touchedAt < RATE_WINDOW_MS) continue;
      if (this.recordings.has(key) || this.pendingRecordings.has(key) || this.pendingSegments.has(key)
        || this.processing.has(key) || this.intentProcessing.has(key)
        || this.executingCommands.has(key)) continue;
      this.operationGenerationTimes.delete(key);
      this.operationGenerations.delete(key);
      this.operationContexts.delete(key);
    }
    for (const [guildId, touchedAt] of this.settingsRevisionTimes) {
      if (now - touchedAt < RATE_WINDOW_MS) continue;
      const active = this.connections.has(guildId) || this.focuses.has(guildId)
        || [
          ...this.recordings.keys(),
          ...this.pendingRecordings.keys(),
          ...this.pendingSegments.keys(),
          ...this.processing.keys(),
          ...this.intentProcessing.keys(),
        ]
          .some(key => key.startsWith(`${guildId}:`));
      if (active) continue;
      this.settingsRevisionTimes.delete(guildId);
      this.settingsRevisionSignatures.delete(guildId);
      this.settingsRevisions.delete(guildId);
    }
  }

  activeFocus(guildId) {
    const focus = this.focuses.get(guildId);
    if (!focus) return null;
    if (focus.expiresAt > Date.now()) return focus;
    this.releaseFocus(guildId).catch(error => {
      console.warn('[VoiceListener] failed to release expired focus:', safeErrorLabel(error));
    });
    return null;
  }

  keepFocusForFollowup(guildId, userId, token = null) {
    const focus = this.activeFocus(guildId);
    if (!focus || focus.userId !== userId || (token && focus.token !== token)) return false;
    focus.acceptingFollowup = true;
    this.armFocusTimer(guildId, focus, AI_FOCUS_WINDOW_MS);
    return true;
  }

  armFocusTimer(guildId, focus, timeoutMs) {
    clearTimeout(focus.timer);
    const hardDeadlineAt = focus.hardDeadlineAt || Number.MAX_SAFE_INTEGER;
    focus.expiresAt = Math.min(Date.now() + timeoutMs, hardDeadlineAt);
    focus.timer = setTimeout(() => {
      this.releaseFocus(guildId, focus.userId, focus.token).catch(error => {
        console.warn('[VoiceListener] focus timeout cleanup failed:', safeErrorLabel(error));
      });
    }, Math.max(0, focus.expiresAt - Date.now()));
    focus.timer.unref?.();
  }

  abortCompetingWork(guildId, focusUserId) {
    for (const [key, recording] of this.recordings) {
      if (!key.startsWith(`${guildId}:`) || key === `${guildId}:${focusUserId}`) continue;
      this.invalidateOperation(key);
      recording.controller.abort(new Error('Another member acquired voice focus'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.recordings.delete(key);
      this.releaseReservation(key);
    }
    for (const [key, recording] of this.pendingRecordings) {
      if (!key.startsWith(`${guildId}:`) || key === `${guildId}:${focusUserId}`) continue;
      recording.controller.abort(new DOMException('Another member acquired voice focus', 'AbortError'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.pendingRecordings.delete(key);
    }
    for (const key of this.pendingSegments.keys()) {
      if (!key.startsWith(`${guildId}:`) || key === `${guildId}:${focusUserId}`) continue;
      this.pendingSegments.delete(key);
      const status = this.sttStatusFor(guildId);
      status.pendingDropped += 1;
      status.lastPendingAt = Date.now();
      status.lastPendingState = 'aborted';
    }
    for (const [key, controller] of this.processing) {
      if (!key.startsWith(`${guildId}:`) || key === `${guildId}:${focusUserId}`) continue;
      this.invalidateOperation(key);
      controller.abort(new Error('Another member acquired voice focus'));
    }
  }

  async activateFocus(guildId, userId, { timeoutMs = FOCUS_WINDOW_MS } = {}) {
    const existing = this.activeFocus(guildId);
    if (existing && existing.userId !== userId) return false;
    if (existing) {
      if (!existing.executing) this.armFocusTimer(guildId, existing, timeoutMs);
      return true;
    }

    const serverQueue = musicQueue.peek(guildId);
    const originalVolume = Math.max(0, Number(serverQueue?.volume) || 0);
    const focus = {
      token: Symbol(`voice-focus:${guildId}:${userId}`),
      userId,
      expiresAt: 0,
      timer: null,
      originalVolume,
      ducked: false,
      executing: false,
      acceptingFollowup: false,
      hardDeadlineAt: Date.now() + FOCUS_HARD_DEADLINE_MS,
    };
    this.focuses.set(guildId, focus);
    this.armFocusTimer(guildId, focus, timeoutMs);
    this.abortCompetingWork(guildId, userId);
    this.sttStatusFor(guildId).lastWakeAt = Date.now();

    const targetVolume = Math.min(originalVolume, DUCK_VOLUME);
    if (serverQueue?.currentSong && targetVolume < originalVolume) {
      const duckOperation = MusicPlayer.setTransientVolume(guildId, targetVolume, focus.token);
      Promise.resolve(duckOperation).then(() => {
        if (this.focuses.get(guildId) !== focus
          && musicQueue.peek(guildId)?.transientVolume?.token === focus.token) {
          MusicPlayer.clearTransientVolume(guildId, focus.token).catch(() => {});
        }
      }).catch(() => {});
      try {
        const ducked = await withDeadline(duckOperation, DUCK_DEADLINE_MS);
        const ownsOverride = musicQueue.peek(guildId)?.transientVolume?.token === focus.token;
        if (this.focuses.get(guildId) === focus) {
          focus.ducked = ownsOverride;
        } else if (ownsOverride || ducked) {
          await MusicPlayer.clearTransientVolume(guildId, focus.token).catch(() => false);
        }
      } catch (error) {
        if (this.focuses.get(guildId) === focus) await this.releaseFocus(guildId, userId, focus.token);
        voiceDebug(`focus-duck-failed guild=${guildId} user=${userId} reason=${safeErrorLabel(error)}`);
        return false;
      }
    }
    return true;
  }

  async releaseFocus(guildId, userId = null, token = null) {
    const focus = this.focuses.get(guildId);
    if (!focus || (userId && focus.userId !== userId) || (token && focus.token !== token)) return false;
    const processingKey = `${guildId}:${focus.userId}`;
    const recording = this.recordings.get(processingKey);
    if (recording) {
      this.invalidateOperation(processingKey);
      recording.controller.abort(new DOMException('Voice focus expired', 'AbortError'));
      recording.stream.destroy();
      recording.decoder.destroy();
      clearTimeout(recording.maxTimer);
      this.recordings.delete(processingKey);
      this.releaseReservation(processingKey);
    }
    const processing = this.processing.get(processingKey);
    if (processing) {
      this.invalidateOperation(processingKey);
      processing.abort(new DOMException('Voice focus expired', 'AbortError'));
      this.processing.delete(processingKey);
    }
    this.intentProcessing.get(processingKey)?.abort(new DOMException('Voice focus expired', 'AbortError'));
    this.invalidateOperation(processingKey);
    this.focuses.delete(guildId);
    clearTimeout(focus.timer);
    const wakeKey = `${guildId}:${focus.userId}`;
    this.wakeWindows.delete(wakeKey);
    this.fuzzyWakeWindows.delete(wakeKey);
    if (focus.ducked || musicQueue.peek(guildId)?.transientVolume?.token === focus.token) {
      await withDeadline(this.restoreFocusVolume(guildId, focus), VOLUME_RESTORE_DEADLINE_MS)
        .catch(error => voiceDebug(`focus-volume-restore-failed guild=${guildId} reason=${safeErrorLabel(error)}`));
    }
    await this.drainPendingSegment(processingKey);
    return true;
  }

  async restoreFocusVolume(guildId, focus) {
    for (let attempt = 1; attempt <= VOLUME_RESTORE_ATTEMPTS; attempt++) {
      try {
        const restored = await MusicPlayer.clearTransientVolume(guildId, focus.token);
        if (restored || musicQueue.peek(guildId)?.transientVolume?.token !== focus.token) return true;
      } catch (error) {
        if (attempt === VOLUME_RESTORE_ATTEMPTS) {
          console.warn('[VoiceListener] failed to restore playback volume:', safeErrorLabel(error));
          return false;
        }
      }
      await new Promise(resolve => setTimeout(resolve, VOLUME_RESTORE_RETRY_MS));
    }
    return false;
  }

  async onSpeakingStart(guildId, userId) {
    voiceDebug(`speaking-start guild=${guildId} user=${userId}`);
    const entry = this.connections.get(guildId);
    if (!this.started || this.stopping || !entry || userId === this.client.user?.id || userId === this.mainClient.user?.id) {
      this.recordIgnored(guildId, 'missing-entry-or-bot');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=missing-entry-or-bot`);
      return;
    }
    const key = `${guildId}:${userId}`;
    const mainGuild = this.mainClient.guilds.cache.get(guildId);
    const member = mainGuild?.members.cache.get(userId) || await mainGuild?.members.fetch(userId).catch(() => null);
    if (!this.started || this.stopping || this.connections.get(guildId) !== entry
      || entry.connection.state.status === VoiceConnectionStatus.Destroyed) return;
    const settings = GuildSettings.get(guildId);
    const serverQueue = musicQueue.peek(guildId);
    const mainChannelId = mainBotVoiceChannelId(mainGuild);
    const listenerGuild = this.client.guilds.cache.get(guildId);
    const listenerChannel = listenerGuild?.channels.cache.get(entry.channelId);
    const listenerPermissions = listenerChannel?.permissionsFor(listenerGuild?.members?.me);
    if (!member || !member.user || member.user.bot || !mainChannelId || entry.channelId !== mainChannelId
      || member.voice.channelId !== mainChannelId
      || !listenerChannel?.isVoiceBased()
      || !listenerPermissions?.has('ViewChannel')
      || !listenerPermissions.has('Connect')
      || !canUseVoiceControl(member, settings, serverQueue)) {
      this.recordIgnored(guildId, 'member-channel-permission');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=member-channel-permission`);
      return;
    }
    const status = this.sttStatusFor(guildId);
    if (!settings.voiceControl.enabled
      || !this.hasVoiceConsent(guildId, userId, settings.voiceControl)
      || !this.stt.configured()
      || status.circuitOpenUntil > Date.now()) {
      this.recordIgnored(guildId, 'stt-unavailable-or-not-allowed');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=stt-unavailable`);
      return;
    }
    const focus = this.activeFocus(guildId);
    if (focus && focus.userId !== userId) {
      status.ignoredForFocus += 1;
      this.recordIgnored(guildId, 'focus-user');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=focus-user`);
      return;
    }
    const busy = this.recordings.has(key) || this.processing.has(key) || this.intentProcessing.has(key)
      || this.reservations.has(key) || this.executingCommands.has(key)
      || (focus && !focus.acceptingFollowup)
      || (!focus && Date.now() < (this.cooldowns.get(key) || 0));
    if (busy) {
      const canRecordPending = !this.recordings.has(key)
        && !this.pendingRecordings.has(key)
        && !this.pendingSegments.has(key)
        && (this.processing.has(key) || this.intentProcessing.has(key) || this.executingCommands.has(key)
          || Boolean(focus && !focus.acceptingFollowup));
      if (canRecordPending && this.startRecording(guildId, userId, entry, settings.voiceControl, { pending: true })) {
        status.pendingQueued += 1;
        status.lastPendingAt = Date.now();
        status.lastPendingState = 'recording';
        voiceDebug(`recording-pending-start guild=${guildId} user=${userId}`);
        return;
      }
      status.busyIgnored += 1;
      if (this.pendingRecordings.has(key) || this.pendingSegments.has(key)) {
        status.pendingDropped += 1;
        status.lastPendingAt = Date.now();
        status.lastPendingState = 'full';
      }
      this.recordIgnored(guildId, 'busy-or-cooldown');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=busy-or-cooldown`);
      return;
    }
    let rateKeys = null;
    if (!focus) {
      const userRateKey = `${guildId}:${userId}`;
      if (!this.withinRateLimit(this.segmentRates, userRateKey, MAX_SEGMENTS_PER_USER_MINUTE)
        || !this.withinRateLimit(this.segmentRates, guildId, MAX_SEGMENTS_PER_GUILD_MINUTE)) {
        status.ignoredForRateLimit += 1;
        this.recordIgnored(guildId, 'rate-limit');
        voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=rate-limit`);
        return;
      }
      rateKeys = [userRateKey, guildId];
    }
    const guildActive = [...this.reservations].filter(value => value.startsWith(`${guildId}:`)).length;
    if (guildActive >= MAX_CONCURRENT_PER_GUILD) {
      status.ignoredForGuildConcurrency += 1;
      this.recordIgnored(guildId, 'guild-concurrency');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=guild-concurrency`);
      return;
    }
    if (this.globalReservations >= MAX_CONCURRENT_GLOBAL) {
      status.ignoredForGlobalConcurrency += 1;
      this.recordIgnored(guildId, 'global-concurrency');
      voiceDebug(`speaking-ignored guild=${guildId} user=${userId} reason=global-concurrency`);
      return;
    }

    this.reservations.add(key);
    this.globalReservations += 1;
    if (focus?.acceptingFollowup) focus.acceptingFollowup = false;
    if (rateKeys) {
      this.recordRate(this.segmentRates, rateKeys[0]);
      this.recordRate(this.segmentRates, rateKeys[1]);
    }

    let recordingStarted = false;
    try {
      recordingStarted = this.startRecording(guildId, userId, entry, settings.voiceControl);
    } finally {
      if (!recordingStarted) this.releaseReservation(key);
    }
  }

  startRecording(guildId, userId, entry, settings, { pending = false } = {}) {
    const key = `${guildId}:${userId}`;
    const target = pending ? this.pendingRecordings : this.recordings;
    if (target.has(key)) return false;
    let stream;
    try {
      stream = entry.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
      });
    } catch (error) {
      this.recordSttOutcome(guildId, 'input-error', safeErrorLabel(error));
      return false;
    }
    let decoder;
    try {
      decoder = this.opusDecoderFactory({
        sampleRate: this.sttFormat.sampleRate,
        channels: this.sttFormat.channels,
      });
    } catch (error) {
      stream.destroy();
      this.recordSttFailure(guildId, error);
      this.recordSttOutcome(guildId, 'decode-error', safeErrorLabel(error));
      console.warn('[VoiceListener] Opus decoder initialization failed:', safeErrorLabel(error));
      return false;
    }
    const controller = new AbortController();
    const recording = {
      key,
      guildId,
      userId,
      channelId: entry.channelId,
      pending,
      stream,
      decoder,
      controller,
      chunks: [],
      pcmBytes: 0,
      pcmChunks: 0,
      opusPackets: 0,
      opusDecodedPackets: 0,
      opusDroppedPackets: 0,
      opusConsecutiveErrors: 0,
      lastOpusError: null,
      decodeError: null,
      inputError: null,
      finalized: false,
      operation: pending
        ? null
        : this.createOperationContext(guildId, userId, settings, controller.signal, { channelId: entry.channelId }),
      maxTimer: null,
    };
    recording.maxTimer = setTimeout(() => {
      stream.destroy();
    }, MAX_AUDIO_MS);
    target.set(key, recording);
    stream.on('data', packet => {
      const result = decoder.decode(packet);
      this.recordOpusStats(recording);
      if (!result.ok) {
        if (recording.opusDroppedPackets === 1 || result.fatal) {
          console.warn(`[VoiceListener] Opus packet dropped: ${result.reason}${result.fatal ? ' (limit reached)' : ''}`);
        }
        if (result.fatal) {
          const error = new Error(result.reason);
          error.name = 'VoiceOpusDecodeError';
          recording.decodeError = error;
          stream.destroy();
        }
        return;
      }
      recording.chunks.push(result.pcm);
      recording.pcmBytes += result.pcm.length;
      recording.pcmChunks += 1;
    });
    stream.on('error', error => {
      recording.inputError = error;
      console.warn('[VoiceListener] receive stream failed:', safeErrorLabel(error));
    });
    const finalize = () => this.finalizeRecording(recording).catch(error => {
      console.warn('[VoiceListener] recording finalization failed:', safeErrorLabel(error));
    });
    stream.once('end', finalize);
    stream.once('close', finalize);
    voiceDebug(`recording-start guild=${guildId} user=${userId} pending=${pending} rate=${this.sttFormat.sampleRate}`);
    return true;
  }

  async finalizeRecording(recording) {
    if (recording.finalized) return;
    recording.finalized = true;
    clearTimeout(recording.maxTimer);
    this.recordOpusStats(recording);
    recording.decoder?.destroy?.();
    const target = recording.pending ? this.pendingRecordings : this.recordings;
    if (target.get(recording.key) === recording) target.delete(recording.key);
    const durationMs = this.recordAudioStats(recording.guildId, recording.pcmBytes, recording.pcmChunks);
    const status = this.sttStatusFor(recording.guildId);
    voiceDebug(`recording-end guild=${recording.guildId} user=${recording.userId} pending=${recording.pending} durationMs=${durationMs} bytes=${recording.pcmBytes} chunks=${recording.pcmChunks} opus=${recording.opusDecodedPackets}/${recording.opusPackets} dropped=${recording.opusDroppedPackets}`);

    if (!recording.pending) this.cooldowns.set(recording.key, Date.now() + USER_COOLDOWN_MS);
    if (recording.controller.signal.aborted) {
      this.recordSttOutcome(recording.guildId, 'aborted', safeErrorLabel(recording.controller.signal.reason));
      if (!recording.pending) {
        this.releaseReservation(recording.key);
        if (this.operationContexts.get(recording.key) === recording.operation) this.operationContexts.delete(recording.key);
      }
      return;
    }
    if (recording.inputError) {
      this.recordSttFailure(recording.guildId, recording.inputError);
      this.recordSttOutcome(recording.guildId, 'input-error', safeErrorLabel(recording.inputError));
      if (!recording.pending) {
        this.releaseReservation(recording.key);
        if (this.operationContexts.get(recording.key) === recording.operation) this.operationContexts.delete(recording.key);
      }
      return;
    }
    const badOpusRatio = recording.opusPackets > 0
      ? recording.opusDroppedPackets / recording.opusPackets
      : 0;
    const decodeFailed = recording.decodeError
      || (recording.pcmBytes === 0 && recording.opusDroppedPackets > 0)
      || (recording.opusPackets >= MIN_OPUS_PACKETS_FOR_RATIO && badOpusRatio > MAX_BAD_OPUS_RATIO);
    if (decodeFailed) {
      const error = recording.decodeError || new Error(
        recording.pcmBytes === 0 ? 'no valid Opus packets' : 'too many invalid Opus packets',
      );
      error.name = 'VoiceOpusDecodeError';
      this.recordSttFailure(recording.guildId, error);
      this.recordSttOutcome(recording.guildId, 'decode-error', recording.lastOpusError || safeErrorLabel(error));
      if (recording.pending) {
        status.pendingDropped += 1;
      } else {
        await this.sendUnderstandingFeedback(
          recording.guildId,
          recording.userId,
          '',
          '收到的语音音频损坏，请再说一次',
          recording.operation,
        );
        this.releaseReservation(recording.key);
        if (this.operationContexts.get(recording.key) === recording.operation) this.operationContexts.delete(recording.key);
      }
      return;
    }
    if (recording.pcmBytes === 0) {
      this.recordSttOutcome(recording.guildId, 'zero-pcm', 'decoder produced no PCM');
      if (recording.pending) status.pendingDropped += 1;
      else {
        this.releaseReservation(recording.key);
        if (this.operationContexts.get(recording.key) === recording.operation) this.operationContexts.delete(recording.key);
      }
      return;
    }
    if (durationMs < MIN_AUDIO_MS) {
      this.recordSttOutcome(recording.guildId, 'too-short', `${durationMs}ms < ${MIN_AUDIO_MS}ms`);
      if (recording.pending) status.pendingDropped += 1;
      else {
        this.releaseReservation(recording.key);
        if (this.operationContexts.get(recording.key) === recording.operation) this.operationContexts.delete(recording.key);
      }
      return;
    }

    const pcm = Buffer.concat(recording.chunks, recording.pcmBytes);
    if (recording.pending) {
      this.pendingSegments.set(recording.key, {
        guildId: recording.guildId,
        userId: recording.userId,
        channelId: recording.channelId,
        pcm,
      });
      status.lastPendingAt = Date.now();
      status.lastPendingState = 'queued';
      await this.drainPendingSegment(recording.key);
      return;
    }
    await this.processAudio(
      recording.guildId,
      recording.userId,
      pcm,
      recording.controller,
      recording.operation,
      { recordStats: false },
    );
  }

  async drainPendingSegment(key) {
    const segment = this.pendingSegments.get(key);
    const focus = segment ? this.activeFocus(segment.guildId) : null;
    if (!segment || this.recordings.has(key) || this.pendingRecordings.has(key)
      || this.processing.has(key) || this.intentProcessing.has(key) || this.executingCommands.has(key)
      || Boolean(focus && focus.userId === segment.userId && !focus.acceptingFollowup)) return false;
    this.pendingSegments.delete(key);
    const status = this.sttStatusFor(segment.guildId);
    const settings = GuildSettings.get(segment.guildId).voiceControl;
    const controller = new AbortController();
    const operation = this.createOperationContext(segment.guildId, segment.userId, settings, controller.signal, {
      channelId: segment.channelId,
    });
    if (!this.started || this.stopping || !this.isOperationCurrent(operation, { requireEnabled: true })
      || !this.hasVoiceConsent(segment.guildId, segment.userId, settings)) {
      controller.abort(new DOMException('Pending voice segment is stale', 'AbortError'));
      status.pendingDropped += 1;
      status.lastPendingAt = Date.now();
      status.lastPendingState = 'aborted';
      if (this.operationContexts.get(key) === operation) this.operationContexts.delete(key);
      return false;
    }
    this.reservations.add(key);
    this.globalReservations += 1;
    status.pendingProcessed += 1;
    status.lastPendingAt = Date.now();
    status.lastPendingState = 'processing';
    await this.processAudio(segment.guildId, segment.userId, segment.pcm, controller, operation, { recordStats: false });
    status.lastPendingAt = Date.now();
    status.lastPendingState = status.lastOutcome === 'aborted' ? 'aborted' : 'processed';
    return true;
  }

  releaseReservation(key) {
    if (!this.reservations.delete(key)) return;
    this.globalReservations = Math.max(0, this.globalReservations - 1);
  }

  withinRateLimit(map, key, limit) {
    const now = Date.now();
    for (const [entryKey, timestamps] of map) {
      const active = timestamps.filter(timestamp => now - timestamp < RATE_WINDOW_MS);
      if (active.length > 0) map.set(entryKey, active);
      else map.delete(entryKey);
    }
    const recent = (map.get(key) || []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
    if (recent.length > 0) map.set(key, recent);
    else map.delete(key);
    return recent.length < limit;
  }

  recordRate(map, key) {
    const recent = map.get(key) || [];
    recent.push(Date.now());
    map.set(key, recent);
  }

  sttLanguage(settings) {
    if (this.stt.provider === 'vercel-ai-gateway') return 'auto';
    if (settings.language === 'mandarin') return 'zh';
    if (settings.language === 'cantonese') return 'yue';
    return 'auto';
  }

  sttKeyterms(settings) {
    return [...new Set(settings.wakeWords
      .map(word => normalizeVoiceText(word).replace(/\s+/g, ''))
      .filter(word => word.length >= 4)
      .flatMap(word => [word, word.replaceAll('乐', '樂'), word.replaceAll('樂', '乐')]))];
  }

  observeTranscript(guildId, userId, text, settings, part, operation = null) {
    if (!text || part?.type !== 'transcript-final') return;
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    voiceDebug(`stt-final-candidate guild=${guildId} user=${userId} accepted=true`);
  }

  async processAudioStream(guildId, userId, audio, controller, operation = null, {
    transcribe = null,
    inputState = null,
  } = {}) {
    const processingKey = `${guildId}:${userId}`;
    const status = this.sttStatusFor(guildId);
    operation ||= this.createOperationContext(
      guildId,
      userId,
      GuildSettings.get(guildId).voiceControl,
      controller.signal,
    );
    if (status.circuitOpenUntil > Date.now()) {
      this.recordSttOutcome(guildId, 'circuit-open');
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
      await this.drainPendingSegment(processingKey);
      return;
    }
    if (this.globalProcessing >= MAX_CONCURRENT_GLOBAL) {
      status.ignoredForGlobalConcurrency += 1;
      this.recordSttOutcome(guildId, 'global-concurrency');
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
      return;
    }
    this.globalProcessing += 1;
    this.processing.set(processingKey, controller);
    let finalText = '';
    let settings = null;
    let emptyTranscript = false;
    let providerFailed = false;
    try {
      settings = GuildSettings.get(guildId).voiceControl;
      if (!this.isOperationCurrent(operation, { requireEnabled: true })
        || !this.hasVoiceConsent(guildId, userId, settings)
        || !this.stt.configured()) {
        this.recordSttOutcome(guildId, 'aborted', 'voice operation is no longer current');
        return;
      }
      let transcript;
      try {
        const options = {
          language: this.sttLanguage(settings),
          keyterms: this.sttKeyterms(settings),
          signal: controller.signal,
          onTranscript: (text, part) => this.observeTranscript(guildId, userId, text, settings, part, operation),
        };
        transcript = transcribe
          ? await transcribe(options)
          : await this.stt.transcribeStream(audio, options);
        if (!this.isOperationCurrent(operation, { requireEnabled: true })) {
          this.recordSttOutcome(guildId, 'aborted', 'voice operation changed during transcription');
          return;
        }
        if (inputState?.cancelled) {
          const error = inputState.reason instanceof Error
            ? inputState.reason
            : new Error('STT provider cancelled its PCM input');
          this.recordSttFailure(guildId, error);
          this.recordSttOutcome(guildId, 'input-cancelled', safeErrorLabel(error));
          providerFailed = true;
        } else {
          finalText = String(typeof transcript === 'string' ? transcript : transcript?.text || '').trim();
          if (!finalText) {
            emptyTranscript = true;
            status.lastError = null;
            status.consecutiveFailures = 0;
            status.circuitOpenUntil = 0;
            this.recordSttOutcome(guildId, 'empty');
          } else {
            this.recordSttSuccess(guildId);
            this.recordSttOutcome(guildId, 'success');
          }
          voiceDebug(`stt-result guild=${guildId} user=${userId} accepted=true`);
        }
      } catch (error) {
        if (controller.signal.aborted || !this.isOperationCurrent(operation, { requireEnabled: true })) {
          this.recordSttOutcome(guildId, 'aborted', safeErrorLabel(controller.signal.reason || error));
          return;
        }
        const outcome = inputState?.cancelled
          ? 'input-cancelled'
          : error?.name === 'TimeoutError' || /STT timeout/i.test(String(error?.message || ''))
            ? 'timeout'
            : error?.name === 'AbortError'
              ? 'provider-cancelled'
              : 'error';
        this.recordSttFailure(guildId, error);
        this.recordSttOutcome(guildId, outcome, safeErrorLabel(error));
        providerFailed = true;
      }
    } finally {
      if (this.processing.get(processingKey) === controller) this.processing.delete(processingKey);
      this.globalProcessing = Math.max(0, this.globalProcessing - 1);
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
    }
    if (providerFailed) {
      await this.drainPendingSegment(processingKey);
      return;
    }
    if (emptyTranscript && this.isOperationCurrent(operation, { requireEnabled: true })) {
      await this.sendUnderstandingFeedback(
        guildId,
        userId,
        '',
        '语音已收到，但没有识别到清晰内容，请再说一次',
        operation,
      );
    } else if (finalText && this.isOperationCurrent(operation, { requireEnabled: true })) {
      await this.handleTranscript(guildId, userId, finalText, settings, operation);
    }
    await this.drainPendingSegment(processingKey);
  }

  async processAudio(guildId, userId, pcm, controller, operation = null, {
    recordStats = true,
    pcmChunks = pcm?.length ? 1 : 0,
  } = {}) {
    const processingKey = `${guildId}:${userId}`;
    const pcmBytes = pcm?.length || 0;
    operation ||= this.createOperationContext(
      guildId,
      userId,
      GuildSettings.get(guildId).voiceControl,
      controller.signal,
    );
    const durationMs = recordStats
      ? this.recordAudioStats(guildId, pcmBytes, pcmChunks)
      : Math.round(audioDurationMs(pcmBytes, this.sttFormat));
    if (controller.signal.aborted || !this.isOperationCurrent(operation, { requireEnabled: true })) {
      this.recordSttOutcome(guildId, 'aborted', safeErrorLabel(controller.signal.reason));
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
      return;
    }
    if (pcmBytes === 0) {
      this.recordSttOutcome(guildId, 'zero-pcm', 'decoder produced no PCM');
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
      return;
    }
    if (durationMs < MIN_AUDIO_MS) {
      this.recordSttOutcome(guildId, 'too-short', `${durationMs}ms < ${MIN_AUDIO_MS}ms`);
      this.releaseReservation(processingKey);
      if (this.operationContexts.get(processingKey) === operation) this.operationContexts.delete(processingKey);
      return;
    }
    voiceDebug(`stt-start guild=${guildId} user=${userId} bytes=${pcmBytes} chunks=${pcmChunks}`);
    if (!this.stt.supportsStreamingInput?.()) {
      return this.processAudioStream(
        guildId,
        userId,
        finitePcmStream(pcm),
        controller,
        operation,
        { transcribe: options => this.stt.transcribe(pcm, options) },
      );
    }
    const inputState = { cancelled: false, reason: null };
    const audio = finitePcmStream(pcm, reason => {
      inputState.cancelled = true;
      inputState.reason = reason;
    });
    return this.processAudioStream(guildId, userId, audio, controller, operation, { inputState });
  }

  async handleTranscript(guildId, userId, text, settings, operation = null) {
    if (!text) return;
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    const status = this.sttStatusFor(guildId);
    if (looksLikeSttPromptLeak(text)) {
      status.promptLeakRejected += 1;
      voiceDebug(`stt-ignored guild=${guildId} user=${userId} reason=prompt-leak`);
      return;
    }
    const wakeKey = `${guildId}:${userId}`;
    const parsed = parseVoiceCommand({
      text,
      wakeWords: settings.wakeWords,
      wakeActiveUntil: this.wakeWindows.get(wakeKey) || 0,
      language: settings.language,
      understandingMode: settings.understandingMode,
    });
    if (parsed.fuzzyWake && !this.fuzzyWakeWindows.has(wakeKey)) {
      this.fuzzyWakeWindows.add(wakeKey);
      status.fuzzyWakeCount += 1;
    }
    if (parsed.usedWakeWindow && this.fuzzyWakeWindows.has(wakeKey)) {
      parsed.matched = false;
      parsed.reason = 'fuzzy-wake-needs-ai';
      parsed.fuzzyWake = true;
      parsed.wakeWord = null;
    }
    voiceDebug(`parse-result guild=${guildId} user=${userId} matched=${parsed.matched} command=${parsed.command || 'none'} reason=${parsed.reason || 'none'}`);
    const currentFocus = this.activeFocus(guildId);
    if (currentFocus && currentFocus.userId !== userId) return;
    if (parsed.nextWakeActiveUntil) this.wakeWindows.set(wakeKey, parsed.nextWakeActiveUntil);
    if (parsed.wakeWord && !await this.activateFocus(guildId, userId, {
      timeoutMs: parsed.matched ? FOCUS_WINDOW_MS : AI_FOCUS_WINDOW_MS,
    })) return;
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    if (!parsed.matched) {
      if (parsed.reason === 'wake-only') {
        const focus = this.activeFocus(guildId);
        if (focus?.userId === userId) focus.acceptingFollowup = true;
        return;
      }
      if (settings.understandingMode !== 'balanced' || (!parsed.wakeWord && !parsed.usedWakeWindow)) {
        if (parsed.wakeWord || parsed.usedWakeWindow) {
          await this.sendUnderstandingFeedback(guildId, userId, parsed.commandText, '没有识别到可执行的语音命令', operation);
        }
        return;
      }
      const aiParsed = await this.parseWithAI(guildId, userId, text, parsed, settings, operation);
      if (!aiParsed) return;
      if (aiParsed.operation && !this.isOperationCurrent(aiParsed.operation, { requireEnabled: true })) return;
      await this.handleParsedCommand(guildId, userId, aiParsed, settings);
      return;
    }
    await this.handleParsedCommand(guildId, userId, parsed, settings);
  }

  async parseWithAI(guildId, userId, transcript, parsed, settings, sourceOperation = null) {
    const processingKey = `${guildId}:${userId}`;
    const status = this.sttStatusFor(guildId);
    const startingFocus = this.activeFocus(guildId);
    if (!startingFocus || startingFocus.userId !== userId) return null;
    if (sourceOperation && !this.isOperationCurrent(sourceOperation, { requireEnabled: true })) return null;
    const focusToken = startingFocus.token;
    if (this.intentProcessing.has(processingKey) || this.aiProcessing >= MAX_AI_CONCURRENT) {
      status.aiRateLimited += 1;
      this.keepFocusForFollowup(guildId, userId, focusToken);
      return null;
    }
    if (!this.withinRateLimit(this.aiRates, processingKey, MAX_AI_PER_USER_MINUTE)
      || !this.withinRateLimit(this.aiRates, guildId, MAX_AI_PER_GUILD_MINUTE)) {
      status.aiRateLimited += 1;
      await this.sendUnderstandingFeedback(guildId, userId, parsed.commandText, 'AI 语音理解请求过于频繁，请稍后重试', sourceOperation);
      this.keepFocusForFollowup(guildId, userId, focusToken);
      return null;
    }
    const controller = new AbortController();
    const operation = this.createOperationContext(guildId, userId, settings, controller.signal, {
      channelId: sourceOperation?.channelId || null,
    });
    this.intentProcessing.set(processingKey, controller);
    this.aiProcessing += 1;
    this.recordRate(this.aiRates, processingKey);
    this.recordRate(this.aiRates, guildId);
    let acceptedIntent = null;
    const config = voiceAIConfigStatus();
    status.lastAiAt = Date.now();
    try {
      if (!config.ok) {
        status.aiUnavailable += 1;
        await this.sendUnderstandingFeedback(guildId, userId, parsed.commandText, 'AI 语音理解暂不可用，请用标准说法重试', operation);
        this.keepFocusForFollowup(guildId, userId, focusToken);
        return null;
      }

      let intent;
      try {
        intent = await withDeadline(this.intentParser({
            transcript,
            commandText: parsed.commandText || transcript,
            language: settings.language,
            fuzzyWake: parsed.fuzzyWake,
            usedWakeWindow: parsed.usedWakeWindow,
            enabledCommands: settings.enabledCommands,
            signal: controller.signal,
          }), COMMAND_DEADLINE_MS, () => controller.abort(timeoutError('AI intent deadline exceeded')));
        if (!this.isOperationCurrent(operation, { requireEnabled: true })) return null;
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) return null;
        console.warn('[VoiceListener] AI intent parsing failed:', safeErrorLabel(error));
        status.aiUnavailable += 1;
        await this.sendUnderstandingFeedback(guildId, userId, parsed.commandText, 'AI 语音理解请求失败，请再说一次', operation);
        this.keepFocusForFollowup(guildId, userId, focusToken);
        return null;
      }

      status.lastAiConfidence = intent?.confidence ?? null;
      const currentSettings = GuildSettings.get(guildId).voiceControl;
      const currentFocus = this.activeFocus(guildId);
      const accepted = intent?.matched
        && intent.confidence >= AI_CONFIDENCE_THRESHOLD
        && currentSettings.enabled
        && currentSettings.understandingMode === 'balanced'
        && currentSettings.enabledCommands.includes(intent.command)
        && currentFocus?.userId === userId
        && currentFocus.token === focusToken
        && this.isOperationCurrent(operation, { requireEnabled: true });
      if (!accepted) {
        status.aiRejected += 1;
        await this.sendUnderstandingFeedback(guildId, userId, parsed.commandText, '我不确定你的指令，没有执行', operation);
        return null;
      }

      status.aiCommands += 1;
      acceptedIntent = {
        matched: true,
        command: intent.command,
        query: intent.query,
        wakeWord: parsed.wakeWord || null,
        fuzzyWake: Boolean(parsed.fuzzyWake),
        usedWakeWindow: Boolean(parsed.usedWakeWindow),
        usedAI: true,
        confidence: intent.confidence,
        focusToken,
        operation,
      };
      return acceptedIntent;
    } finally {
      if (this.intentProcessing.get(processingKey) === controller) this.intentProcessing.delete(processingKey);
      this.aiProcessing = Math.max(0, this.aiProcessing - 1);
      if (this.operationContexts.get(processingKey) === operation && !acceptedIntent) {
        this.operationContexts.delete(processingKey);
      }
      if (!acceptedIntent) this.keepFocusForFollowup(guildId, userId, focusToken);
    }
  }

  async sendUnderstandingFeedback(guildId, userId, transcript, reason, operation = null) {
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    if (now < (this.feedbackCooldowns.get(key) || 0)
      || now < (this.guildFeedbackCooldowns.get(guildId) || 0)) return;
    this.feedbackCooldowns.set(key, now + FEEDBACK_COOLDOWN_MS);
    this.guildFeedbackCooldowns.set(guildId, now + GUILD_FEEDBACK_COOLDOWN_MS);
    const settings = GuildSettings.get(guildId).voiceControl;
    const channel = await this.feedbackChannel(guildId, settings);
    if (!channel) return;
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    await channel.send({
      content: `🎙️ 语音指令未执行：${reason}。\n例如可以说：“音乐助手，播放罗大佑的童年”。`,
      allowedMentions: { users: [], roles: [], parse: [] },
    }).catch(error => console.warn('[VoiceListener] understanding feedback failed:', safeErrorLabel(error)));
  }

  async handleParsedCommand(guildId, userId, parsed, settings) {
    const wakeKey = `${guildId}:${userId}`;
    const status = this.sttStatusFor(guildId);
    const currentFocus = this.activeFocus(guildId);
    if (currentFocus && currentFocus.userId !== userId) return;
    if (parsed.operation && !this.isOperationCurrent(parsed.operation, { requireEnabled: true })) return;
    if (parsed.usedAI && (!currentFocus || currentFocus.token !== parsed.focusToken)) return;
    this.wakeWindows.delete(wakeKey);
    this.fuzzyWakeWindows.delete(wakeKey);
    const currentSettings = GuildSettings.get(guildId).voiceControl;
    if (!currentSettings.enabled || !currentSettings.enabledCommands.includes(parsed.command)) {
      await this.releaseFocus(guildId, userId, parsed.focusToken || null);
      return;
    }

    const dedupeKey = `${wakeKey}:${parsed.command}:${parsed.query || ''}`;
    const now = Date.now();
    for (const [key, expiresAt] of this.recentCommands) {
      if (expiresAt <= now) this.recentCommands.delete(key);
    }
    if (now < (this.recentCommands.get(dedupeKey) || 0)) {
      if (!this.executingCommands.has(wakeKey)) await this.releaseFocus(guildId, userId, parsed.focusToken || null);
      return;
    }
    this.recentCommands.set(dedupeKey, now + DEDUPE_MS);
    if (!parsed.usedAI && !await this.activateFocus(guildId, userId)) return;
    if (this.commandLocks.has(guildId)) return;
    const focus = this.activeFocus(guildId);
    if (!focus || focus.userId !== userId) return;
    if (parsed.usedAI && focus.token !== parsed.focusToken) return;
    clearTimeout(focus.timer);
    focus.commandDeadlineAt = Math.min(focus.hardDeadlineAt || Number.MAX_SAFE_INTEGER, Date.now() + COMMAND_DEADLINE_MS);
    focus.expiresAt = focus.commandDeadlineAt;
    focus.executing = true;
    this.commandLocks.add(guildId);
    this.executingCommands.add(wakeKey);
    const commandController = new AbortController();
    const operation = this.createOperationContext(
      guildId,
      userId,
      currentSettings,
      commandController.signal,
      { channelId: mainBotVoiceChannelId(this.mainClient.guilds.cache.get(guildId)) },
    );
    operation.deadlineAt = focus.commandDeadlineAt;
    try {
      const outcome = await withDeadline(
        this.executeCommand(guildId, userId, parsed, operation),
        Math.max(1, focus.commandDeadlineAt - Date.now()),
        () => {
          commandController.abort(timeoutError('voice command deadline exceeded'));
          this.invalidateOperation(wakeKey);
        },
      );
      status.lastCommandAt = Date.now();
      status.lastCommand = parsed.command;
      status.lastCommandResult = outcome?.reason || (outcome?.ok === false ? 'failed' : 'ok');
    } catch (error) {
      status.lastCommandAt = Date.now();
      status.lastCommand = parsed.command;
      status.lastCommandResult = error?.name === 'TimeoutError' ? 'timeout' : 'failed';
      if (error?.name === 'TimeoutError') {
        console.warn(`[VoiceListener] command ${parsed.command} timed out`);
        await this.sendAudit(guildId, userId, parsed.command, '执行超时，请稍后重试');
      } else if (error?.name !== 'AbortError') {
        console.warn(`[VoiceListener] command ${parsed.command} failed:`, safeErrorLabel(error));
      }
    } finally {
      this.executingCommands.delete(wakeKey);
      this.commandLocks.delete(guildId);
      commandController.abort(new DOMException('Voice command finished', 'AbortError'));
      await this.releaseFocus(guildId, userId, parsed.focusToken || focus.token);
    }
  }

  async executeCommand(guildId, userId, parsed, operation = null) {
    const mainGuild = this.mainClient.guilds.cache.get(guildId);
    const settings = GuildSettings.get(guildId);
    const serverQueue = musicQueue.peek(guildId);
    const mainChannelId = mainBotVoiceChannelId(mainGuild);
    const member = mainGuild?.members.cache.get(userId) || await mainGuild?.members.fetch(userId).catch(() => null);
    if (!member || member.user?.bot || !mainChannelId || member.voice.channelId !== mainChannelId) {
      return { ok: false, reason: 'member-not-in-channel' };
    }
    if (!settings.voiceControl.enabled
      || !settings.voiceControl.enabledCommands.includes(parsed.command)
      || !this.hasVoiceConsent(guildId, userId, settings.voiceControl)
      || !canUseVoiceControl(member, settings, serverQueue)) return { ok: false, reason: 'not-allowed' };
    const isCurrent = () => !operation
      || (Date.now() <= (operation.deadlineAt || Number.MAX_SAFE_INTEGER)
        && this.isOperationCurrent(operation, { requireEnabled: true }));
    if (!isCurrent()) return { ok: false, reason: 'stale' };

    try {
      let result;
      if (parsed.command === 'play') {
        if (!isSafeVoicePlayQuery(parsed.query)) {
          this.sttStatusFor(guildId).promptLeakRejected += 1;
          await this.sendAudit(guildId, userId, 'play', '拒绝执行：识别结果疑似 STT 提示词泄漏', operation);
          return { ok: false, reason: 'unsafe-query' };
        }
        const searchController = new AbortController();
        const searchSignal = operation?.signal
          ? AbortSignal.any([operation.signal, searchController.signal])
          : searchController.signal;
        let songs;
        try {
          songs = await withDeadline(
            YouTube.search(parsed.query, 1, { signal: searchSignal }),
            SEARCH_DEADLINE_MS,
            () => searchController.abort(timeoutError('voice search deadline exceeded')),
          );
        } catch (error) {
          if (error?.name !== 'TimeoutError') throw error;
          result = { ok: false, reason: 'search-timeout', query: parsed.query };
          await this.sendAudit(guildId, userId, 'play', commandResultText('play', result), operation);
          return result;
        }
        if (!isCurrent()) return { ok: false, reason: 'stale' };
        if (!songs.length) {
          result = { ok: false, reason: 'not-found', query: parsed.query };
          await this.sendAudit(guildId, userId, 'play', commandResultText('play', result), operation);
          return result;
        }
        const currentSettings = GuildSettings.get(guildId);
        const currentMember = mainGuild?.members.cache.get(userId) || await mainGuild?.members.fetch(userId).catch(() => null);
        const currentMainChannelId = mainBotVoiceChannelId(mainGuild);
        const currentQueue = musicQueue.peek(guildId);
        if (!currentSettings.voiceControl.enabled
          || !currentSettings.voiceControl.enabledCommands.includes('play')
          || !currentMember
          || currentMember.voice.channelId !== currentMainChannelId
          || !canUseVoiceControl(currentMember, currentSettings, currentQueue)
          || !isCurrent()) return { ok: false, reason: 'stale' };
        const voiceChannel = member.voice.channel;
        const textChannel = serverQueue?.textChannel || null;
        const hadQueue = Boolean(serverQueue);
        const queue = musicQueue.get(guildId);
        const queuedItemIds = songs
          .map(song => MusicPlayer.ensureQueueItemId(song)?.queueItemId)
          .filter(Boolean);
        try {
          const playback = await enqueueSongs({
            guild: mainGuild,
            voiceChannel,
            textChannel,
            requester: member.user,
            songs,
            waitForStart: false,
          });
          if (!isCurrent()) {
            MusicPlayer.removeQueueItemsById(queue, queuedItemIds);
            savePlaybackState(guildId, queue, { immediate: true });
            if (!hadQueue && !queue.currentSong && queue.songs.length === 0 && queue.radioQueue.length === 0 && !queue.is247) {
              await MusicPlayer.clearQueueAndLeave(guildId, 'voice-command-cancelled', { notify: false });
            }
            return { ok: false, reason: 'stale' };
          }
          if (!playback.ok) {
            result = { ok: false, reason: playback.reason || 'enqueue-failed', query: parsed.query };
          } else {
            result = {
              ok: true,
              song: songs[0],
              started: playback.startedPlayback,
              queued: !playback.startedPlayback,
              startPending: playback.shouldStartPlayback && !playback.startedPlayback,
            };
          }
        } catch (error) {
          MusicPlayer.removeQueueItemsById(queue, queuedItemIds);
          savePlaybackState(guildId, queue, { immediate: true });
          if (!hadQueue && !queue.currentSong && queue.songs.length === 0 && queue.radioQueue.length === 0 && !queue.is247) {
            await MusicPlayer.clearQueueAndLeave(guildId, 'voice-command-error', { notify: false });
            deletePlaybackState(guildId);
          }
          throw error;
        }
      } else if (parsed.command === 'pause') {
        if (!isCurrent()) return { ok: false, reason: 'stale' };
        result = { ok: await MusicPlayer.pause(guildId) };
      } else if (parsed.command === 'resume') {
        if (!isCurrent()) return { ok: false, reason: 'stale' };
        result = { ok: await MusicPlayer.resume(guildId) };
      } else if (parsed.command === 'previous') {
        if (!isCurrent()) return { ok: false, reason: 'stale' };
        result = await MusicPlayer.previous(guildId);
        if (!isCurrent()) return { ok: false, reason: 'stale' };
      } else if (parsed.command === 'skip') {
        if (!isCurrent()) return { ok: false, reason: 'stale' };
        result = await MusicPlayer.skip(guildId);
        if (!isCurrent()) return { ok: false, reason: 'stale' };
      } else {
        return { ok: false, reason: 'unsupported-command' };
      }
      if (!isCurrent()) return { ok: false, reason: 'stale' };
      await this.sendAudit(guildId, userId, parsed.command, commandResultText(parsed.command, result), operation);
      if (!isCurrent()) return { ok: false, reason: 'stale' };
      const activeQueue = musicQueue.peek(guildId);
      if (activeQueue) await refreshNowPlayingPanel(guildId, activeQueue.textChannel, activeQueue);
      return result;
    } catch (error) {
      if (!isCurrent()) return { ok: false, reason: 'stale' };
      console.warn(`[VoiceListener] command ${parsed.command} failed:`, safeErrorLabel(error));
      await this.sendAudit(guildId, userId, parsed.command, `执行失败：${safeErrorLabel(error)}`, operation);
      return { ok: false, reason: 'execution-failed' };
    }
  }

  async auditChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.isTextBased() ? channel : null;
  }

  async feedbackChannel(guildId, settings = GuildSettings.get(guildId).voiceControl) {
    const guild = this.mainClient.guilds.cache.get(guildId);
    const audit = await this.auditChannel(guild, settings.auditChannelId);
    if (audit) return audit;
    const textChannel = musicQueue.peek(guildId)?.textChannel;
    return typeof textChannel?.send === 'function' ? textChannel : null;
  }

  async sendAudit(guildId, userId, command, result, operation = null) {
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    const settings = GuildSettings.get(guildId).voiceControl;
    const channel = await this.feedbackChannel(guildId, settings);
    if (!channel) return;
    if (operation && !this.isOperationCurrent(operation, { requireEnabled: true })) return;
    await channel.send({
      content: `🎙️ <@${userId}> 语音命令 \`${command}\`：${result}`,
      allowedMentions: { users: [], roles: [], parse: [] },
    }).catch(error => {
      console.warn('[VoiceListener] audit send failed:', safeErrorLabel(error));
    });
  }
}
