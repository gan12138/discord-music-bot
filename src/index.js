import { File } from 'node:buffer';
globalThis.File = File;

import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import 'dotenv/config';
import { resolveFfmpegPath, ffmpegVersion } from './utils/ffmpeg.js';
import { musicQueue, MusicPlayer } from './utils/player.js';
import { createLavalinkManager, destroyLavalinkPlayer, isLavalinkEnabled, sendLavalinkRaw } from './utils/lavalink.js';
import { flushPlaybackQueueStates } from './utils/playbackState.js';
import { VoiceListenerManager } from './utils/voiceListenerManager.js';
import { setVoiceControlManager } from './utils/voiceControlRuntime.js';
import db from './models/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const lockPath = join(__dirname, '..', 'data', 'bot.pid');

for (const envName of ['DISCORD_TOKEN', 'CLIENT_ID']) {
  if (!process.env[envName]) {
    console.error(`Missing required environment variable: ${envName}`);
    process.exit(1);
  }
}

for (const binary of ['yt-dlp']) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const message = `Missing or unusable runtime dependency: ${binary}`;
    if (isLavalinkEnabled()) {
      console.warn(`${message}; YouTube/Bilibili/Spotify metadata lookup and local fallback may fail.`);
      if (result.error) console.warn(result.error.message);
    } else {
      console.error(message);
      if (result.error) console.error(result.error.message);
      process.exit(1);
    }
  }
}

try {
  const ffmpegPath = resolveFfmpegPath();
  console.log(`[ffmpeg] using ${ffmpegPath} (${ffmpegVersion(ffmpegPath) || 'unknown version'})`);
} catch (error) {
  if (!isLavalinkEnabled()) {
    console.error('Missing or unusable runtime dependency: ffmpeg (需 --enable-libopus)');
    console.error(error.message);
    process.exit(1);
  }
  console.warn(`[ffmpeg] ${error.message}; 本地播放/回落将不可用`);
}

try {
  writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
} catch {
  const existingPid = Number(readFileSync(lockPath, 'utf8').trim());
  if (existingPid && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 0);
      console.error(`Another bot process is already running with PID ${existingPid}. Exiting.`);
      process.exit(1);
    } catch {
      // Stale lock file, overwrite it
    }
  }
  writeFileSync(lockPath, String(process.pid));
}
process.on('exit', () => {
  try {
    flushPlaybackQueueStates(musicQueue.entries());
    db.flushDB();
    if (readFileSync(lockPath, 'utf8') === String(process.pid)) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // Ignore lock cleanup failures during shutdown.
  }
});

let shuttingDown = false;
async function cleanupAllQueues() {
  const destroys = [];
  for (const [guildId, serverQueue] of musicQueue.entries()) {
    MusicPlayer.cleanupProcesses(serverQueue);
    if (isLavalinkEnabled()) {
      destroys.push(destroyLavalinkPlayer(guildId, 'shutdown').catch(error => {
        console.warn(`[Shutdown] Lavalink destroy failed guild=${guildId}:`, MusicPlayer.safeErrorMessage(error));
      }));
    }
    try {
      serverQueue.connection?.destroy();
    } catch (error) {
      console.error('[Shutdown] failed to destroy voice connection:', error.message);
    }
  }
  await Promise.all(destroys);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  await voiceControlManager.stop();
  await cleanupAllQueues();
  flushPlaybackQueueStates(musicQueue.entries());
  db.flushDB();
  client.destroy();
  process.exit(0);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});
client.on('shardReady', shardId => {
  console.log(`[DiscordGateway] ready shard=${shardId}`);
});
client.on('shardDisconnect', (event, shardId) => {
  // Record only the close code; gateway payloads can contain session details.
  console.warn(`[DiscordGateway] disconnected shard=${shardId} code=${event.code}`);
});
client.on('shardReconnecting', shardId => {
  console.warn(`[DiscordGateway] reconnecting shard=${shardId}`);
});
client.on('shardResume', (shardId, replayedEvents) => {
  console.log(`[DiscordGateway] resumed shard=${shardId} replayedEvents=${replayedEvents}`);
});
client.on('shardError', (error, shardId) => {
  console.error(`[DiscordGateway] error shard=${shardId}:`, MusicPlayer.safeErrorMessage(error));
});
client.on('error', error => {
  console.error('[DiscordGateway] client error:', MusicPlayer.safeErrorMessage(error));
});
const voiceControlManager = new VoiceListenerManager(client);
setVoiceControlManager(voiceControlManager);
client.once('ready', () => {
  voiceControlManager.start().catch(error => {
    console.error('[VoiceListener] startup failed, main bot will continue:', error.message);
  });
});

createLavalinkManager(client, {
  onNodeDisconnect: () => MusicPlayer.handleLavalinkNodeDisconnect(),
  onNodeReady: (_node, payload) => MusicPlayer.handleLavalinkNodeReady({ resumed: payload?.resumed === true }),
  onTrackStart: (guildId, player, track, payload) => MusicPlayer.handleLavalinkTrackStart(guildId, player, track, payload),
  onPlayerUpdate: (guildId, player) => MusicPlayer.handleLavalinkPlayerUpdate(guildId, player),
  onTrackEnd: (guildId, player, track, payload) => MusicPlayer.handleLavalinkTrackEnd(guildId, player, track, payload),
  onQueueEnd: (guildId, player, track, payload) => MusicPlayer.handleLavalinkQueueEnd(guildId, player, track, payload),
  onTrackError: (guildId, player, track, payload) => MusicPlayer.handleLavalinkTrackError(guildId, player, track, payload),
  onTrackStuck: (guildId, player, track, payload) => MusicPlayer.handleLavalinkTrackStuck(guildId, player, track, payload),
  onPlayerSocketClosed: (guildId, player, payload) => MusicPlayer.handleLavalinkSocketClosed(guildId, player, payload),
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.on('raw', (packet) => {
  sendLavalinkRaw(packet);
});

if (process.env.VOICE_DEBUG === '1') client.on('raw', (packet) => {
  if (packet.t === 'VOICE_STATE_UPDATE') {
    const data = packet.d;
    if (data.user_id === client.user?.id) {
      console.log('[Voice Raw] VOICE_STATE_UPDATE', {
        guildId: data.guild_id,
        channelId: data.channel_id,
        hasSessionId: Boolean(data.session_id),
        selfMute: data.self_mute,
        selfDeaf: data.self_deaf,
      });
    }
  } else if (packet.t === 'VOICE_SERVER_UPDATE') {
    const data = packet.d;
    console.log('[Voice Raw] VOICE_SERVER_UPDATE', {
      guildId: data.guild_id,
      hasEndpoint: Boolean(data.endpoint),
      endpoint: data.endpoint,
      hasToken: Boolean(data.token),
    });
  }
});

client.commands = new Collection();
client.buttons = new Collection();
client.selects = new Collection();
client.searchSessions = new Collection();

const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const command = await import(`file://${filePath}`);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.log(`⚠️  命令 ${file} 缺少必要的 "data" 或 "execute" 属性`);
  }
}

for (const [directory, collection, label] of [
  ['buttons', client.buttons, '按钮'],
  ['selects', client.selects, '下拉菜单'],
]) {
  const componentPath = join(__dirname, directory);
  if (!existsSync(componentPath)) continue;

  const componentFiles = readdirSync(componentPath).filter(file => file.endsWith('.js'));
  for (const file of componentFiles) {
    const filePath = join(componentPath, file);
    const component = await import(`file://${filePath}`);
    if ('customId' in component && 'execute' in component) {
      collection.set(component.customId, component);
    } else {
      console.log(`⚠️  ${label} ${file} 缺少必要的 "customId" 或 "execute" 属性`);
    }
  }
}

const eventsPath = join(__dirname, 'events');
const eventFiles = readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = join(eventsPath, file);
  const event = await import(`file://${filePath}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  // 语音连接快速重建时可能重复关闭已销毁的 UDP socket，属于无害的竞态错误，
  // 不应因此让整个进程崩溃重启（会导致所有服务器播放中断）。
  if (error?.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
    console.warn('Ignoring benign voice UDP socket race:', error.message);
    return;
  }
  console.error('Uncaught exception:', error);
  voiceControlManager.stop().catch(() => {});
  cleanupAllQueues().catch(() => {});
  flushPlaybackQueueStates(musicQueue.entries());
  db.flushDB();
  // 未捕获异常后 Node.js 处于未定义状态，必须退出
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
