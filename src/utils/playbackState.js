import { PlaybackState } from '../models/database.js';

const SAVE_DELAY_MS = 1000;
const timers = new Map();

function serializableRadio(radio = {}) {
  return {
    enabled: Boolean(radio.enabled),
    autodetect: Boolean(radio.autodetect),
    currentStyle: radio.currentStyle || {},
    pendingStyle: radio.pendingStyle || null,
    seedSong: radio.seedSong || null,
    lastGeneratedAt: radio.lastGeneratedAt || null,
  };
}

export function serializeQueue(guildId, serverQueue = {}) {
  return {
    guildId,
    voiceChannelId: serverQueue.voiceChannelId || serverQueue.connection?.joinConfig?.channelId || null,
    textChannelId: serverQueue.textChannelId || serverQueue.textChannel?.id || null,
    currentSong: serverQueue.currentSong || null,
    songs: serverQueue.songs || [],
    radioQueue: serverQueue.radioQueue || [],
    history: (serverQueue.history || []).slice(-100),
    volume: serverQueue.volume ?? 50,
    loop: serverQueue.loop || 'off',
    radio: serializableRadio(serverQueue.radio),
    radioFailureCount: Number(serverQueue.radioFailureCount) || 0,
    suppressRadioUntilManualPlay: Boolean(serverQueue.suppressRadioUntilManualPlay),
    suppressRadioUntilManualQueueEnds: Boolean(serverQueue.suppressRadioUntilManualQueueEnds),
    playbackGeneration: Number(serverQueue.playbackGeneration) || 0,
    is247: Boolean(serverQueue.is247),
    filters: serverQueue.filters || { active: 'none' },
    versionPreference: serverQueue.versionPreference || 'any',
    notificationMode: serverQueue.notificationMode || 'private',
    nowPlayingMessageId: serverQueue.nowPlayingMessageId || null,
    nowPlayingChannelId: serverQueue.nowPlayingChannelId || null,
    seekOffsetSeconds: serverQueue.currentSong ? getPlaybackProgressSeconds(serverQueue) : (serverQueue.seekOffsetSeconds || 0),
    startedAt: null,
    pausedAt: null,
    pausedByEmptyChannel: Boolean(serverQueue.pausedByEmptyChannel),
    updatedAt: new Date().toISOString(),
  };
}

export function hydrateQueue(serverQueue, state = {}) {
  serverQueue.songs = Array.isArray(state.songs) ? state.songs : [];
  serverQueue.radioQueue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  serverQueue.currentSong = state.currentSong || null;
  serverQueue.history = Array.isArray(state.history) ? state.history : [];
  serverQueue.volume = Number.isFinite(state.volume) ? state.volume : 50;
  serverQueue.loop = ['off', 'single', 'queue'].includes(state.loop) ? state.loop : 'off';
  serverQueue.radio = {
    ...serverQueue.radio,
    ...(state.radio || {}),
    isGenerating: false,
  };
  serverQueue.radioFailureCount = Number(state.radioFailureCount) || 0;
  serverQueue.suppressRadioUntilManualPlay = Boolean(state.suppressRadioUntilManualPlay);
  serverQueue.suppressRadioUntilManualQueueEnds = Boolean(state.suppressRadioUntilManualQueueEnds);
  serverQueue.playbackGeneration = Number(state.playbackGeneration) || 0;
  serverQueue.is247 = Boolean(state.is247);
  serverQueue.filters = state.filters || { active: 'none' };
  serverQueue.versionPreference = ['any', 'live', 'normal'].includes(state.versionPreference) ? state.versionPreference : 'any';
  serverQueue.notificationMode = ['on', 'off', 'panel', 'private'].includes(state.notificationMode) ? state.notificationMode : 'private';
  serverQueue.nowPlayingMessageId = state.nowPlayingMessageId || null;
  serverQueue.nowPlayingChannelId = state.nowPlayingChannelId || null;
  serverQueue.seekOffsetSeconds = state.seekOffsetSeconds || 0;
  serverQueue.startedAt = null;
  serverQueue.pausedAt = null;
  serverQueue.pausedByEmptyChannel = Boolean(state.pausedByEmptyChannel);
  serverQueue.voiceChannelId = state.voiceChannelId || null;
  serverQueue.textChannelId = state.textChannelId || null;
}

export function savePlaybackState(guildId, serverQueue, { immediate = false } = {}) {
  if (!guildId || !serverQueue) return;

  const save = () => {
    timers.delete(guildId);
    PlaybackState.set(guildId, serializeQueue(guildId, serverQueue));
  };

  if (immediate) {
    if (timers.has(guildId)) {
      clearTimeout(timers.get(guildId));
      timers.delete(guildId);
    }
    save();
    return;
  }

  if (timers.has(guildId)) clearTimeout(timers.get(guildId));
  timers.set(guildId, setTimeout(save, SAVE_DELAY_MS));
}

export function deletePlaybackState(guildId) {
  if (timers.has(guildId)) {
    clearTimeout(timers.get(guildId));
    timers.delete(guildId);
  }
  PlaybackState.delete(guildId);
}

export function getPlaybackProgressSeconds(serverQueue = {}) {
  const base = Number(serverQueue.seekOffsetSeconds) || 0;
  if (!serverQueue.startedAt || serverQueue.pausedAt) return base;
  return base + Math.max(0, (Date.now() - serverQueue.startedAt) / 1000);
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
  for (const [guildId, timer] of timers) {
    clearTimeout(timer);
    timers.delete(guildId);
  }
}

export function flushPlaybackQueueStates(queueMap) {
  cancelPendingPlaybackSaves();
  for (const [guildId, serverQueue] of queueMap) {
    PlaybackState.set(guildId, serializeQueue(guildId, serverQueue));
  }
}
