import { GuildSettings, PlaybackState } from '../models/database.js';
import { durationToSeconds } from './time.js';

const SAVE_DELAY_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_HISTORY_SIZE = 100;
const pendingSaves = new Map();

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export const MAX_QUEUE_SIZE = positiveInteger(process.env.MAX_QUEUE_SIZE, DEFAULT_MAX_QUEUE_SIZE, 10_000);

export function getMaxQueueSize() {
  return MAX_QUEUE_SIZE;
}

export function getQueueLimit() {
  return MAX_QUEUE_SIZE;
}

export function getQueueCapacity(serverQueue = {}, queueName = 'songs') {
  const queue = serverQueue && typeof serverQueue === 'object' && Array.isArray(serverQueue[queueName])
    ? serverQueue[queueName]
    : [];
  return Math.max(0, MAX_QUEUE_SIZE - queue.length);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function queueItems(values, { fromEnd = false, limit = MAX_QUEUE_SIZE } = {}) {
  if (!Array.isArray(values)) return [];
  const valid = values.filter(isRecord);
  return (fromEnd ? valid.slice(-limit) : valid.slice(0, limit));
}

function serializableSong(song) {
  if (!isRecord(song)) return null;
  const {
    audioUrl: _audioUrl,
    audioUrlExpiresAt: _audioUrlExpiresAt,
    audioHeaders: _audioHeaders,
    forceLocalFallback: _forceLocalFallback,
    ...persistent
  } = song;
  return persistent;
}

function serializableRadio(radio = {}) {
  const source = isRecord(radio) ? radio : {};
  return {
    enabled: Boolean(source.enabled),
    autodetect: Boolean(source.autodetect),
    currentStyle: isRecord(source.currentStyle) ? source.currentStyle : {},
    pendingStyle: isRecord(source.pendingStyle) ? source.pendingStyle : null,
    seedSong: serializableSong(source.seedSong),
    lastGeneratedAt: source.lastGeneratedAt || null,
  };
}

export function serializeQueue(guildId, serverQueue = {}) {
  const source = isRecord(serverQueue) ? serverQueue : {};
  const songs = queueItems(source.songs).map(serializableSong).filter(Boolean);
  const radioQueue = queueItems(source.radioQueue).map(serializableSong).filter(Boolean);
  const history = queueItems(source.history, { fromEnd: true, limit: MAX_HISTORY_SIZE })
    .map(serializableSong)
    .filter(Boolean);
  return {
    guildId,
    voiceChannelId: source.voiceChannelId || source.connection?.joinConfig?.channelId || null,
    textChannelId: source.textChannelId || source.textChannel?.id || null,
    currentSong: serializableSong(source.currentSong),
    songs,
    radioQueue,
    history,
    volume: source.volume ?? 50,
    loop: source.loop || 'off',
    radio: serializableRadio(source.radio),
    radioFailureCount: Number(source.radioFailureCount) || 0,
    suppressRadioUntilManualPlay: Boolean(source.suppressRadioUntilManualPlay),
    suppressRadioUntilManualQueueEnds: Boolean(source.suppressRadioUntilManualQueueEnds),
    is247: Boolean(source.is247),
    filters: isRecord(source.filters) ? source.filters : { active: 'none' },
    versionPreference: source.versionPreference || 'any',
    notificationMode: source.notificationMode || 'private',
    nowPlayingMessageId: source.nowPlayingMessageId || null,
    nowPlayingChannelId: source.nowPlayingChannelId || null,
    seekOffsetSeconds: source.currentSong ? getPlaybackProgressSeconds(source) : (source.seekOffsetSeconds || 0),
    startedAt: null,
    pausedAt: null,
    pausedByEmptyChannel: Boolean(source.pausedByEmptyChannel),
    updatedAt: new Date().toISOString(),
  };
}

export function hydrateQueue(serverQueue, state = {}) {
  if (!serverQueue || typeof serverQueue !== 'object') return serverQueue;
  const source = isRecord(state) ? state : {};
  const settings = serverQueue.guildId || source.guildId
    ? GuildSettings.get(serverQueue.guildId || source.guildId)
    : { defaultVolume: 50, versionPreference: 'any', notificationMode: 'private' };
  const radioState = isRecord(source.radio) ? source.radio : {};
  const existingRadio = isRecord(serverQueue.radio) ? serverQueue.radio : {};
  const volume = Number(source.volume);
  const seekOffsetSeconds = Number(source.seekOffsetSeconds);

  serverQueue.songs = queueItems(source.songs);
  serverQueue.radioQueue = queueItems(source.radioQueue);
  serverQueue.currentSong = isRecord(source.currentSong) ? source.currentSong : null;
  serverQueue.history = queueItems(source.history, { fromEnd: true, limit: MAX_HISTORY_SIZE });
  serverQueue.volume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : settings.defaultVolume;
  serverQueue.loop = ['off', 'single', 'queue'].includes(source.loop) ? source.loop : 'off';
  serverQueue.radio = {
    ...existingRadio,
    ...radioState,
    isGenerating: false,
  };
  serverQueue.radioFailureCount = Number(source.radioFailureCount) || 0;
  serverQueue.suppressRadioUntilManualPlay = Boolean(source.suppressRadioUntilManualPlay);
  serverQueue.suppressRadioUntilManualQueueEnds = Boolean(source.suppressRadioUntilManualQueueEnds);
  serverQueue.playbackGeneration = 0;
  serverQueue.is247 = Boolean(source.is247);
  serverQueue.filters = isRecord(source.filters) ? source.filters : { active: 'none' };
  serverQueue.versionPreference = ['any', 'live', 'normal'].includes(source.versionPreference)
    ? source.versionPreference
    : settings.versionPreference;
  serverQueue.notificationMode = ['on', 'off', 'panel', 'private'].includes(source.notificationMode)
    ? source.notificationMode
    : settings.notificationMode;
  serverQueue.nowPlayingMessageId = source.nowPlayingMessageId || null;
  serverQueue.nowPlayingChannelId = source.nowPlayingChannelId || null;
  serverQueue.seekOffsetSeconds = Number.isFinite(seekOffsetSeconds) ? Math.max(0, seekOffsetSeconds) : 0;
  serverQueue.startedAt = null;
  serverQueue.pausedAt = null;
  serverQueue.pausedByEmptyChannel = Boolean(source.pausedByEmptyChannel);
  serverQueue.voiceChannelId = source.voiceChannelId || null;
  serverQueue.textChannelId = source.textChannelId || null;
  serverQueue.disposed = false;
}

export function savePlaybackState(guildId, serverQueue, { immediate = false } = {}) {
  if (!guildId || !serverQueue || serverQueue.disposed) return;

  const save = pending => {
    const current = pendingSaves.get(guildId);
    if (serverQueue.disposed || current !== pending || current.queue !== serverQueue || current.token !== pending.token) return;
    pendingSaves.delete(guildId);
    PlaybackState.set(guildId, serializeQueue(guildId, serverQueue));
  };

  if (immediate) {
    if (serverQueue.disposed) return;
    cancelPendingPlaybackSave(guildId);
    PlaybackState.set(guildId, serializeQueue(guildId, serverQueue));
    return;
  }

  cancelPendingPlaybackSave(guildId);
  const pending = {
    queue: serverQueue,
    token: Symbol('playback-save'),
    timer: null,
  };
  pending.timer = setTimeout(() => save(pending), SAVE_DELAY_MS);
  pendingSaves.set(guildId, pending);
}

export function cancelPendingPlaybackSave(guildId) {
  const pending = pendingSaves.get(guildId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingSaves.delete(guildId);
  return true;
}

export function deletePlaybackState(guildId) {
  cancelPendingPlaybackSave(guildId);
  PlaybackState.delete(guildId);
}

export function getPlaybackProgressSeconds(serverQueue = {}) {
  const base = Number(serverQueue.seekOffsetSeconds) || 0;
  const raw = !serverQueue.startedAt || serverQueue.pausedAt
    ? base
    : base + Math.max(0, (Date.now() - serverQueue.startedAt) / 1000);
  const duration = durationToSeconds(serverQueue.currentSong?.duration);
  return duration === null ? Math.max(0, raw) : Math.max(0, Math.min(raw, duration));
}

export function getPlaybackResumeSeconds(serverQueue = {}) {
  const progress = getPlaybackProgressSeconds(serverQueue);
  const duration = durationToSeconds(serverQueue.currentSong?.duration);
  if (duration !== null && progress >= Math.max(0, duration - 0.5)) return null;
  return progress;
}

export function freezePlaybackProgress(serverQueue, positionSeconds = null) {
  const position = positionSeconds == null
    ? getPlaybackProgressSeconds(serverQueue)
    : Math.max(0, Number(positionSeconds) || 0);
  const duration = durationToSeconds(serverQueue.currentSong?.duration);
  serverQueue.seekOffsetSeconds = duration === null ? position : Math.min(position, duration);
  serverQueue.startedAt = null;
  serverQueue.pausedAt = null;
  return serverQueue.seekOffsetSeconds;
}

export function markPlaybackStarted(serverQueue, seekOffsetSeconds = 0) {
  serverQueue.seekOffsetSeconds = Math.max(0, Number(seekOffsetSeconds) || 0);
  serverQueue.startedAt = Date.now();
  serverQueue.pausedAt = null;
}

export function markPlaybackPaused(serverQueue) {
  serverQueue.seekOffsetSeconds = getPlaybackProgressSeconds(serverQueue);
  serverQueue.startedAt = null;
  serverQueue.pausedAt = Date.now();
}

export function markPlaybackResumed(serverQueue) {
  serverQueue.startedAt = Date.now();
  serverQueue.pausedAt = null;
}

export function cancelPendingPlaybackSaves() {
  for (const guildId of pendingSaves.keys()) {
    cancelPendingPlaybackSave(guildId);
  }
}

export function flushPlaybackQueueStates(queueMap) {
  cancelPendingPlaybackSaves();
  for (const [guildId, serverQueue] of queueMap) {
    if (serverQueue?.disposed) continue;
    PlaybackState.set(guildId, serializeQueue(guildId, serverQueue));
  }
}
