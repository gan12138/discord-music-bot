import { LavalinkManager } from 'lavalink-client';
import { withPlaybackSignal } from './playbackErrors.js';

let manager = null;
let handlers = {};
let configuredNodeOptions = null;
let nodeRecoveryTimer = null;
let nodeRecoveryAttempt = 0;
const nodeReadiness = new WeakMap();
const nodeInfoEpochs = new WeakMap();

const DEFAULT_NODE_HEALTH_TIMEOUT_MS = 3_000;
const DEFAULT_NODE_INFO_REQUEST_TIMEOUT_MS = 1_500;
const DEFAULT_NODE_HEALTH_RETRY_DELAYS_MS = [100, 250, 500, 1_000];
const DEFAULT_PLAYER_READY_TIMEOUT_MS = 15_000;
const DEFAULT_NODE_RETRY_AMOUNT = 12;
const DEFAULT_NODE_RETRY_DELAY_MS = 10_000;
const DEFAULT_NODE_RECREATE_MAX_DELAY_MS = 60_000;
const DEFAULT_VOICE_RECONNECT_DELAY_MS = 5_000;

export const NO_LAVALINK_NODE_CODE = 'NO_LAVALINK_NODE';

function safeLavalinkErrorMessage(error, additionalSecrets = []) {
  let message = 'unknown error';
  if (typeof error === 'string') {
    message = error;
  } else if (error?.message) {
    message = error.message;
  } else if (error?.reason) {
    message = error.reason;
  }

  const secrets = [
    process.env.LAVALINK_PASSWORD,
    ...additionalSecrets,
  ].filter(secret => typeof secret === 'string' && secret.length > 0);

  for (const secret of new Set(secrets)) {
    message = message.split(secret).join('[redacted]');
  }

  return String(message)
    .replace(/(["']?(?:authorization|password|passwd)["']?\s*[:=]\s*["']?)[^"',\s;|}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@');
}

function safeNodeErrorMessage(node, error) {
  return safeLavalinkErrorMessage(error, [node?.options?.authorization]);
}

function toSafeLavalinkError(error, additionalSecrets = []) {
  const safeError = new Error(safeLavalinkErrorMessage(error, additionalSecrets));
  if (error?.name) safeError.name = safeLavalinkErrorMessage(error.name, additionalSecrets);
  if (typeof error?.code === 'string') safeError.code = error.code;
  return safeError;
}

export class NoLavalinkNodeError extends Error {
  constructor(reason = 'requires a connected node with valid /v4/info and sessionId') {
    super(`No Lavalink Node is ready: ${safeLavalinkErrorMessage(reason)}`);
    this.name = 'NoLavalinkNodeError';
    this.code = NO_LAVALINK_NODE_CODE;
    this.category = NO_LAVALINK_NODE_CODE;
  }
}

export function isValidLavalinkInfo(info) {
  return Boolean(
    info
    && typeof info === 'object'
    && !Array.isArray(info)
    && info.version
    && typeof info.version === 'object'
    && typeof info.version.semver === 'string'
    && Array.isArray(info.sourceManagers),
  );
}

export function getLavalinkNodeHealth(node) {
  const connected = Boolean(node?.connected);
  const hasInfo = isValidLavalinkInfo(node?.info);
  const hasSessionId = typeof node?.sessionId === 'string' && node.sessionId.trim().length > 0;
  const missing = [];

  if (!connected) missing.push('connected');
  if (!hasInfo) missing.push('info');
  if (!hasSessionId) missing.push('sessionId');

  return {
    connected,
    hasInfo,
    hasSessionId,
    healthy: missing.length === 0,
    missing,
  };
}

export function isLavalinkNodeHealthy(node) {
  return getLavalinkNodeHealth(node).healthy;
}

export function isLavalinkNodeReadyForPlayback(node) {
  const ready = nodeReadiness.has(node) ? nodeReadiness.get(node) === true : true;
  return isLavalinkNodeHealthy(node) && ready;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isLavalinkPlayerVoiceReady(player, voiceChannelId = null) {
  if (!player || player.connected !== true) return false;
  if (voiceChannelId && player.voiceChannelId !== voiceChannelId) return false;

  const voice = player.voice;
  return Boolean(
    voice
    && hasText(voice.endpoint)
    && hasText(voice.sessionId)
    && hasText(voice.token),
  );
}

export function isLavalinkPlayerReady(player, node = null, voiceChannelId = null) {
  if (!player) return false;
  if (node && player.node !== node) return false;
  if (!isLavalinkNodeReadyForPlayback(player.node)) return false;
  return isLavalinkPlayerVoiceReady(player, voiceChannelId);
}

async function waitForLavalinkPlayerReady(player, node, voiceChannelId, timeoutMs = DEFAULT_PLAYER_READY_TIMEOUT_MS, sleep = delay, signal = null) {
  signal?.throwIfAborted();
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!isLavalinkPlayerReady(player, node, voiceChannelId) && Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!isLavalinkNodeReadyForPlayback(node)) return false;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return isLavalinkPlayerReady(player, node, voiceChannelId);
}

export async function reconnectLavalinkPlayerVoice(player, node, voiceChannelId, {
  timeoutMs = DEFAULT_PLAYER_READY_TIMEOUT_MS,
  reconnectDelayMs = DEFAULT_VOICE_RECONNECT_DELAY_MS,
  sleep = delay,
  signal = null,
} = {}) {
  signal?.throwIfAborted();
  if (!player || !node || !voiceChannelId) return false;
  await player.disconnect?.(true).catch(() => null);
  player.connected = false;
  player.voice = {
    endpoint: null,
    sessionId: null,
    token: null,
    channelId: undefined,
  };
  if (player.options) player.options.voiceChannelId = voiceChannelId;
  await sleep(Math.max(0, Number(reconnectDelayMs) || 0));
  signal?.throwIfAborted();
  await player.connect();
  return waitForLavalinkPlayerReady(player, node, voiceChannelId, timeoutMs, sleep, signal);
}

function getLavalinkNodes(lavalinkManager) {
  const nodes = lavalinkManager?.nodeManager?.nodes;
  if (nodes && typeof nodes.values === 'function') return Array.from(nodes.values());
  if (Array.isArray(nodes)) return nodes;
  return [];
}

function getNodeConnectionStatus(node) {
  try {
    return node?.connectionStatus || null;
  } catch {
    return null;
  }
}

function requestNodeReconnect(node) {
  if (!node || node.connected || (typeof node.connect !== 'function' && typeof node.reconnect !== 'function')) return false;
  if (node.isNodeReconnecting) return false;
  if (['PENDING', 'RECONNECTING'].includes(node.reconnectionState)) return false;
  if (['CONNECTING', 'CLOSING'].includes(getNodeConnectionStatus(node))) return false;

  try {
    if (typeof node.reconnect === 'function') {
      node.reconnect(true);
    } else {
      node.connect(node.options?.sessionId || node.sessionId || undefined);
    }
    return true;
  } catch {
    return false;
  }
}

function nodeId(options = configuredNodeOptions) {
  return options?.id || (options ? `${options.host}:${options.port}` : null);
}

export function ensureLavalinkNodePresent(lavalinkManager = manager, options = configuredNodeOptions) {
  if (!lavalinkManager?.nodeManager || !options) return null;
  const id = nodeId(options);
  let node = id ? lavalinkManager.nodeManager.nodes?.get?.(id) : null;
  if (!node) {
    node = lavalinkManager.nodeManager.createNode({ ...options, sessionId: undefined });
    nodeReadiness.set(node, false);
  }
  if (!node.connected) requestNodeReconnect(node);
  return node;
}

function clearLavalinkNodeRecovery() {
  if (nodeRecoveryTimer) clearTimeout(nodeRecoveryTimer);
  nodeRecoveryTimer = null;
  nodeRecoveryAttempt = 0;
}

function scheduleLavalinkNodeRecovery(delayMs = null) {
  if (!manager?.initiated || !configuredNodeOptions || nodeRecoveryTimer) return false;
  const delay = delayMs == null
    ? Math.min(DEFAULT_NODE_RECREATE_MAX_DELAY_MS, 1_000 * (2 ** Math.min(nodeRecoveryAttempt, 6)))
    : Math.max(0, Number(delayMs) || 0);
  nodeRecoveryTimer = setTimeout(() => {
    nodeRecoveryTimer = null;
    nodeRecoveryAttempt += 1;
    const node = ensureLavalinkNodePresent(manager, configuredNodeOptions);
    if (!node) scheduleLavalinkNodeRecovery();
  }, delay);
  nodeRecoveryTimer.unref?.();
  return true;
}

function invalidateNodeInfo(node) {
  if (!node) return;
  nodeInfoEpochs.set(node, (nodeInfoEpochs.get(node) || 0) + 1);
  node.info = null;
}

function withTimeout(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };

    timer = setTimeout(() => finish(resolve)(null), Math.max(1, timeoutMs));
    Promise.resolve()
      .then(operation)
      .then(finish(resolve), finish(reject));
  });
}

async function refreshLavalinkNodeInfo(node, timeoutMs = DEFAULT_NODE_INFO_REQUEST_TIMEOUT_MS) {
  if (!node?.connected) return false;
  const epoch = nodeInfoEpochs.get(node) || 0;

  const requestInfo = typeof node.fetchInfo === 'function'
    ? () => node.fetchInfo()
    : typeof node.request === 'function'
      ? () => node.request('/info') // lavalink-client prefixes this with /v4
      : null;
  if (!requestInfo) return false;

  try {
    const info = await withTimeout(requestInfo, timeoutMs);
    if (!node.connected || (nodeInfoEpochs.get(node) || 0) !== epoch) return false;
    if (!isValidLavalinkInfo(info)) return false;
    node.info = info;
    return true;
  } catch {
    return false;
  }
}

export async function waitForHealthyLavalinkNode(lavalinkManager, {
  timeoutMs = DEFAULT_NODE_HEALTH_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_NODE_INFO_REQUEST_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_NODE_HEALTH_RETRY_DELAYS_MS,
  isNodeReady = isLavalinkNodeHealthy,
  sleep = delay,
} = {}) {
  if (!lavalinkManager) return null;

  const requestedTimeout = Number(timeoutMs);
  const healthTimeout = Number.isFinite(requestedTimeout)
    ? Math.max(0, requestedTimeout)
    : DEFAULT_NODE_HEALTH_TIMEOUT_MS;
  const deadline = Date.now() + healthTimeout;
  const retryDelays = Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
    ? retryDelaysMs
    : [0];
  const nodesNeedingFreshInfo = new Set();
  let attempt = 0;

  while (true) {
    const nodes = getLavalinkNodes(lavalinkManager);
    if (nodes.length === 0) {
      if (lavalinkManager === manager) {
        const node = ensureLavalinkNodePresent(lavalinkManager, configuredNodeOptions);
        if (node) continue;
      }
      return null;
    }

    for (const node of nodes) {
      const needsFreshInfo = nodesNeedingFreshInfo.has(node);
      if (!needsFreshInfo && isNodeReady(node)) return node;

      const health = getLavalinkNodeHealth(node);
      if (!health.connected) {
        nodesNeedingFreshInfo.add(node);
        requestNodeReconnect(node);
      } else if (needsFreshInfo || !health.hasInfo) {
        const remaining = Math.max(1, deadline - Date.now());
        const refreshed = await refreshLavalinkNodeInfo(
          node,
          Math.min(Number(requestTimeoutMs) || DEFAULT_NODE_INFO_REQUEST_TIMEOUT_MS, remaining),
        );
        if (refreshed) nodesNeedingFreshInfo.delete(node);
      }

      if (!nodesNeedingFreshInfo.has(node) && isNodeReady(node)) return node;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    const delayMs = Number(retryDelays[Math.min(attempt, retryDelays.length - 1)]) || 0;
    attempt += 1;
    await sleep(Math.min(Math.max(0, delayMs), remaining));
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNoLavalinkNodeError(error) {
  if (error?.code === NO_LAVALINK_NODE_CODE) return true;
  const message = safeLavalinkErrorMessage(error);
  return /No available Node|No Lavalink Node|node is not connected|node.*not ready/i.test(message);
}

export function isLavalinkEnabled() {
  return process.env.PLAYER_BACKEND === 'lavalink';
}

export function isLavalinkSupportedUrl(url) {
  const text = String(url || '');
  if (/^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\//i.test(text)) return false;
  if (/^https?:\/\/b23\.tv\//i.test(text)) return false;
  return true;
}

export function createLavalinkManager(client, eventHandlers = {}) {
  if (!isLavalinkEnabled()) return null;
  if (manager) return manager;

  const authorization = String(process.env.LAVALINK_PASSWORD || '').trim();
  if (!authorization) {
    throw new Error('LAVALINK_PASSWORD is required when PLAYER_BACKEND=lavalink');
  }

  handlers = eventHandlers;
  configuredNodeOptions = {
    id: process.env.LAVALINK_NAME || 'main',
    host: process.env.LAVALINK_HOST || '127.0.0.1',
    port: Number(process.env.LAVALINK_PORT || 2333),
    authorization,
    secure: process.env.LAVALINK_SECURE === 'true',
    retryAmount: Math.max(1, Number(process.env.LAVALINK_RETRY_AMOUNT) || DEFAULT_NODE_RETRY_AMOUNT),
    retryDelay: Math.max(1_000, Number(process.env.LAVALINK_RETRY_DELAY_MS) || DEFAULT_NODE_RETRY_DELAY_MS),
  };
  manager = new LavalinkManager({
    nodes: [configuredNodeOptions],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: false,
    client: {
      id: process.env.CLIENT_ID,
      username: client.user?.username || 'MusicBot',
    },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      onDisconnect: {
        autoReconnect: true,
        destroyPlayer: false,
      },
    },
    queueOptions: {
      maxPreviousTracks: 0,
    },
  });

  manager.nodeManager.on('connect', node => {
    // `/v4/info` and the WebSocket ready event can complete in either order.
    if (nodeReadiness.get(node) !== true) nodeReadiness.set(node, false);
    console.log(`[Lavalink] node connected: ${node.id}`);
    if (!isValidLavalinkInfo(node.info)) {
      queueMicrotask(() => refreshLavalinkNodeInfo(node).catch(() => {}));
    }
  });
  manager.nodeManager.on('destroy', (node, reason) => {
    nodeReadiness.set(node, false);
    console.warn(`[Lavalink] node destroyed: ${node.id}`, safeNodeErrorMessage(node, reason || 'unknown'));
    if (/NodeReconnectFail/i.test(String(reason || ''))) scheduleLavalinkNodeRecovery();
  });
  manager.nodeManager.on('disconnect', (node, reason) => {
    nodeReadiness.set(node, false);
    if (node.sessionId && node.options) node.options.sessionId = node.sessionId;
    // A reconnect must validate fresh /v4/info instead of trusting stale data.
    invalidateNodeInfo(node);
    console.warn(`[Lavalink] node disconnected: ${node.id}`, safeNodeErrorMessage(node, reason?.reason || reason || 'unknown'));
    handlers.onNodeDisconnect?.(node, reason);
  });
  manager.nodeManager.on('error', (node, error) => {
    console.error(`[Lavalink] node error: ${node.id}`, safeNodeErrorMessage(node, error));
  });
  manager.nodeManager.on('reconnecting', node => {
    console.warn(`[Lavalink] node reconnecting: ${node.id}`);
  });
  manager.nodeManager.on('raw', (node, payload) => {
    if (payload?.op !== 'ready') return;
    nodeReadiness.set(node, false);
    queueMicrotask(async () => {
      node.options.sessionId = node.sessionId || undefined;
      let infoReady = isValidLavalinkInfo(node.info);
      if (!infoReady) {
        const refreshed = await refreshLavalinkNodeInfo(node);
        infoReady = refreshed;
        if (!refreshed) console.warn('[Lavalink] node ready but /v4/info is unavailable');
      }
      await node.updateSession(true, 60).catch(error => {
        console.warn('[Lavalink] failed to enable session resuming:', safeNodeErrorMessage(node, error));
      });
      nodeReadiness.set(node, Boolean(infoReady && isLavalinkNodeHealthy(node)));
      if (nodeReadiness.get(node)) clearLavalinkNodeRecovery();
      if (nodeReadiness.get(node) && payload.resumed !== true) {
        Promise.resolve(handlers.onNodeReady?.(node, payload)).catch(error => {
          console.error('[Lavalink] node ready handler failed:', safeNodeErrorMessage(node, error));
        });
      }
    });
  });
  manager.nodeManager.on('resumed', (node, payload, players) => {
    nodeReadiness.set(node, false);
    Promise.resolve()
      .then(async () => {
        const infoReady = isValidLavalinkInfo(node.info) || await refreshLavalinkNodeInfo(node);
        nodeReadiness.set(node, Boolean(infoReady && isLavalinkNodeHealthy(node)));
        if (!nodeReadiness.get(node)) return;
        clearLavalinkNodeRecovery();
        return handlers.onNodeReady?.(node, payload, players);
      })
      .catch(error => {
        console.error('[Lavalink] node resumed handler failed:', safeNodeErrorMessage(node, error));
      });
  });

  manager.on('trackEnd', (player, track, payload) => {
    console.log(`[Lavalink] track end guild=${player.guildId} reason=${payload?.reason || 'unknown'}`);
    handlers.onTrackEnd?.(player.guildId, player, track, payload);
  });
  manager.on('trackStart', (player, track, payload) => {
    console.log(`[Lavalink] track start guild=${player.guildId}`);
    handlers.onTrackStart?.(player.guildId, player, track, payload);
  });
  manager.on('playerUpdate', (_oldPlayer, player) => handlers.onPlayerUpdate?.(player.guildId, player));
  manager.on('queueEnd', (player, track, payload) => {
    console.log(`[Lavalink] queue end guild=${player.guildId} reason=${payload?.reason || 'unknown'}`);
    handlers.onQueueEnd?.(player.guildId, player, track, payload);
  });
  manager.on('trackError', (player, track, payload) => {
    console.warn(`[Lavalink] track error guild=${player.guildId}: ${safeNodeErrorMessage(player?.node, payload?.exception?.message || payload?.error || 'unknown')}`);
    handlers.onTrackError?.(player.guildId, player, track, payload);
  });
  manager.on('trackStuck', (player, track, payload) => {
    console.warn(`[Lavalink] track stuck guild=${player.guildId} threshold=${payload?.thresholdMs || 'unknown'}`);
    handlers.onTrackStuck?.(player.guildId, player, track, payload);
  });
  manager.on('playerSocketClosed', (player, payload) => {
    console.warn(`[Lavalink] voice socket closed guild=${player.guildId} code=${payload.code} reason=${safeNodeErrorMessage(player?.node, payload.reason || 'none')}`);
    handlers.onPlayerSocketClosed?.(player.guildId, player, payload);
  });

  return manager;
}

export async function initLavalink(client) {
  if (!isLavalinkEnabled() || !manager || manager.initiated) return manager;
  try {
    await manager.init({ id: client.user.id, username: client.user.username });
  } catch (error) {
    const nodeSecrets = getLavalinkNodes(manager).map(node => node?.options?.authorization);
    throw toSafeLavalinkError(error, nodeSecrets);
  }
  return manager;
}

export function sendLavalinkRaw(packet) {
  if (!isLavalinkEnabled() || !manager?.initiated) return;
  manager.sendRawData(packet).catch(error => {
    const nodeSecrets = getLavalinkNodes(manager).map(node => node?.options?.authorization);
    console.warn('[Lavalink] failed to forward raw voice packet:', safeLavalinkErrorMessage(error, nodeSecrets));
  });
}

export function getLavalinkManager() {
  return manager;
}

export function getLavalinkPlayer(guildId) {
  return manager?.getPlayer(guildId) || null;
}

export async function waitForLavalinkReady(timeoutMs = 10_000) {
  if (!isLavalinkEnabled()) return true;
  const startedAt = Date.now();
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() - startedAt < timeout) {
    if (manager?.initiated) {
      const remaining = timeout - (Date.now() - startedAt);
      const node = await waitForHealthyLavalinkNode(manager, {
        timeoutMs: remaining,
        isNodeReady: isLavalinkNodeReadyForPlayback,
      });
      if (node) return true;
      return false;
    }
    await delay(Math.min(250, timeout - (Date.now() - startedAt)));
  }
  return false;
}

export async function createOrGetLavalinkPlayer({ guildId, voiceChannelId, textChannelId, volume = 50, signal = null }) {
  signal?.throwIfAborted();
  if (!isLavalinkEnabled()) throw new Error('Lavalink backend is not enabled');
  if (!manager?.initiated) throw new Error('Lavalink 尚未初始化');

  ensureLavalinkNodePresent(manager, configuredNodeOptions);

  const node = await waitForHealthyLavalinkNode(manager, {
    isNodeReady: isLavalinkNodeReadyForPlayback,
  });
  signal?.throwIfAborted();
  if (!node) {
    throw new NoLavalinkNodeError('no node passed all readiness checks (connected, valid /v4/info, sessionId)');
  }

  let player = getLavalinkPlayer(guildId);
  let created = false;

  try {
    // lavalink-client returns the cached player without checking its node or
    // Discord voice state. Never reuse one that belongs to an old session.
    if (player && !isLavalinkPlayerReady(player, node, voiceChannelId)) {
      const destroyed = await destroyLavalinkPlayer(guildId, 'stale-player');
      signal?.throwIfAborted();
      if (!destroyed) {
        throw new NoLavalinkNodeError('the cached Lavalink player could not be destroyed');
      }
      player = null;
    }

    if (!player) {
      player = manager.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        node,
        volume: Math.max(0, Number(volume) || 0),
        selfDeaf: true,
        selfMute: false,
      });
      created = true;
    }

    if (!isLavalinkNodeReadyForPlayback(player?.node) || player.node !== node) {
      throw new NoLavalinkNodeError('the player was assigned to a stale or unhealthy node');
    }
    if (player.voiceChannelId !== voiceChannelId) {
      await player.changeVoiceState({ voiceChannelId, selfDeaf: true, selfMute: false });
    }
    signal?.throwIfAborted();
    if (!player.connected) await withPlaybackSignal(() => player.connect(), signal);

    let ready = await waitForLavalinkPlayerReady(player, node, voiceChannelId, DEFAULT_PLAYER_READY_TIMEOUT_MS, delay, signal);
    if (!ready) {
      console.warn(`[Lavalink] guild=${guildId} voice state was not ready; forcing one Discord voice reconnect`);
      ready = await reconnectLavalinkPlayerVoice(player, node, voiceChannelId, { signal });
    }
    if (!ready) {
      throw new NoLavalinkNodeError('the player did not receive connected Discord voice data');
    }
    return player;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (created && player) {
      await destroyLavalinkPlayer(guildId, 'player-readiness-failed').catch(() => false);
    }
    if (error instanceof NoLavalinkNodeError || isNoLavalinkNodeError(error)) {
      if (error instanceof NoLavalinkNodeError) throw error;
      throw new NoLavalinkNodeError('the selected node became unavailable during player creation');
    }
    throw toSafeLavalinkError(error, [node?.options?.authorization]);
  }
}

export async function destroyLavalinkPlayer(guildId, reason = 'destroyed') {
  const player = getLavalinkPlayer(guildId);
  if (!player) return false;
  try {
    const result = await player.destroy(reason);
    // lavalink-client returns undefined when a destroy is already in flight;
    // a completed call is still a successful destroy for our callers.
    return result === undefined ? true : result;
  } catch (error) {
    console.warn('[Lavalink] destroy player failed:', safeNodeErrorMessage(player.node, error));
    return false;
  }
}

export function lavalinkConnectionShim(voiceChannelId, player) {
  if (!isLavalinkPlayerReady(player, player?.node, voiceChannelId)) return null;
  return {
    type: 'lavalink',
    joinConfig: { channelId: voiceChannelId },
    state: { status: 'ready' },
    player,
    subscribe: () => null,
    destroy: () => false,
  };
}

export async function applyLavalinkFilter(player, mode) {
  if (!player?.filterManager) return false;
  await player.filterManager.resetFilters();

  switch (mode) {
    case 'none':
      return true;
    case 'bassboost':
      await player.filterManager.setEQPreset('BassboostMedium');
      return true;
    case 'nightcore':
      await player.filterManager.toggleNightcore(1.25, 1.25, 1.0);
      return true;
    case 'slowed':
      await player.filterManager.setRate(0.85);
      return true;
    case 'spedup':
      await player.filterManager.setRate(1.15);
      return true;
    case '8d':
      await player.filterManager.toggleRotation(0.08);
      return true;
    case 'muffled':
      await player.filterManager.toggleLowPass(20);
      return true;
    case 'reverb':
      if (!player.filterManager.lavalinkFilterPlugin?.toggleReverb) return false;
      await player.filterManager.lavalinkFilterPlugin.toggleReverb();
      return true;
    default:
      return false;
  }
}
