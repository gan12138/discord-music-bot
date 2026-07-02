import { LavalinkManager } from 'lavalink-client';

let manager = null;
let handlers = {};

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

  handlers = eventHandlers;
  manager = new LavalinkManager({
    nodes: [
      {
        id: process.env.LAVALINK_NAME || 'main',
        host: process.env.LAVALINK_HOST || '127.0.0.1',
        port: Number(process.env.LAVALINK_PORT || 2333),
        authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: process.env.LAVALINK_SECURE === 'true',
        retryAmount: 5,
        retryDelay: 10_000,
      },
    ],
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
    console.log(`[Lavalink] node connected: ${node.id}`);
  });
  manager.nodeManager.on('disconnect', (node, reason) => {
    console.warn(`[Lavalink] node disconnected: ${node.id}`, reason?.reason || reason || 'unknown');
  });
  manager.nodeManager.on('error', (node, error) => {
    console.error(`[Lavalink] node error: ${node.id}`, error?.message || error);
  });
  manager.nodeManager.on('reconnecting', node => {
    console.warn(`[Lavalink] node reconnecting: ${node.id}`);
  });

  manager.on('trackEnd', (player, track, payload) => {
    console.log(`[Lavalink] track end guild=${player.guildId} reason=${payload?.reason || 'unknown'}`);
    handlers.onTrackEnd?.(player.guildId, player, track, payload);
  });
  manager.on('queueEnd', (player, track, payload) => {
    console.log(`[Lavalink] queue end guild=${player.guildId} reason=${payload?.reason || 'unknown'}`);
    handlers.onQueueEnd?.(player.guildId, player, track, payload);
  });
  manager.on('trackError', (player, track, payload) => {
    console.warn(`[Lavalink] track error guild=${player.guildId}: ${payload?.exception?.message || payload?.error || 'unknown'}`);
    handlers.onTrackError?.(player.guildId, player, track, payload);
  });
  manager.on('trackStuck', (player, track, payload) => {
    console.warn(`[Lavalink] track stuck guild=${player.guildId} threshold=${payload?.thresholdMs || 'unknown'}`);
    handlers.onTrackStuck?.(player.guildId, player, track, payload);
  });
  manager.on('playerSocketClosed', (player, payload) => {
    console.warn(`[Lavalink] voice socket closed guild=${player.guildId} code=${payload.code} reason=${payload.reason || 'none'}`);
  });

  return manager;
}

export async function initLavalink(client) {
  if (!isLavalinkEnabled() || !manager || manager.initiated) return manager;
  await manager.init({ id: client.user.id, username: client.user.username });
  return manager;
}

export function sendLavalinkRaw(packet) {
  if (!isLavalinkEnabled() || !manager?.initiated) return;
  manager.sendRawData(packet).catch(error => {
    console.warn('[Lavalink] failed to forward raw voice packet:', error.message);
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
  while (Date.now() - startedAt < timeoutMs) {
    if (manager?.initiated && manager.useable) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return Boolean(manager?.initiated && manager.useable);
}

export async function createOrGetLavalinkPlayer({ guildId, voiceChannelId, textChannelId, volume = 50 }) {
  if (!isLavalinkEnabled()) throw new Error('Lavalink backend is not enabled');
  if (!manager?.initiated) throw new Error('Lavalink 尚未初始化');
  if (!manager.useable) throw new Error('Lavalink 节点未连接');

  const player = manager.createPlayer({
    guildId,
    voiceChannelId,
    textChannelId,
    volume: Math.max(0, Number(volume) || 0),
    selfDeaf: true,
    selfMute: false,
  });

  if (player.voiceChannelId !== voiceChannelId) {
    await player.changeVoiceState({ voiceChannelId, selfDeaf: true, selfMute: false });
  }
  if (!player.connected) await player.connect();
  return player;
}

export async function destroyLavalinkPlayer(guildId, reason = 'destroyed') {
  const player = getLavalinkPlayer(guildId);
  if (!player) return false;
  await player.destroy(reason).catch(error => {
    console.warn('[Lavalink] destroy player failed:', error.message);
  });
  return true;
}

export function lavalinkConnectionShim(voiceChannelId) {
  return {
    type: 'lavalink',
    joinConfig: { channelId: voiceChannelId },
    state: { status: 'ready' },
    subscribe: () => null,
    destroy: () => {},
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
