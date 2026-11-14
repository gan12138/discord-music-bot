import { ActivityType, Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { PlaybackState } from '../models/database.js';
import { initLavalink, isLavalinkEnabled, waitForLavalinkReady } from '../utils/lavalink.js';
import { hydrateQueue, savePlaybackState } from '../utils/playbackState.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { withPlaybackSignal } from '../utils/playbackErrors.js';

export const name = Events.ClientReady;
export const once = true;

export function isManualPlaybackPaused(serverQueue) {
  return Boolean(serverQueue.currentSong?.playbackPaused || serverQueue.pausedAt);
}

// Called inside the guild transition, including again after an awaited join.
// Never follow a returning member (or a moved Bot) into a different channel.
export function canRestoreVoiceChannel(guild, serverQueue, voiceChannel, { requireHumans = false } = {}) {
  const botMember = guild.members.me;
  if (!botMember || !voiceChannel?.isVoiceBased?.() || voiceChannel.id !== serverQueue.voiceChannelId
    || (voiceChannel.guild?.id && voiceChannel.guild.id !== guild.id)) return false;
  const botChannelId = botMember.voice?.channelId || botMember.voice?.channel?.id;
  const connectionChannelId = serverQueue.connection?.joinConfig?.channelId;
  if ((botChannelId && botChannelId !== voiceChannel.id)
    || (connectionChannelId && connectionChannelId !== voiceChannel.id)) return false;
  const timeoutUntil = Number(botMember.communicationDisabledUntilTimestamp
    || botMember.communicationDisabledUntil?.getTime?.() || 0);
  if (timeoutUntil > Date.now()) return false;
  const permissions = voiceChannel.permissionsFor?.(botMember);
  if (!permissions?.has?.('ViewChannel') || !permissions.has('Connect') || !permissions.has('Speak')) return false;
  return !requireHumans || Boolean(voiceChannel.members?.some(member => !member.user.bot));
}

export async function releaseRestoredVoiceConnection(serverQueue, connection) {
  // Destroy only the handle acquired by this restore, not a replacement player.
  // Its synthetic disconnect must not clear the deliberately deferred queue.
  serverQueue.suppressVoiceRecoveryUntil = Math.max(serverQueue.suppressVoiceRecoveryUntil || 0, Date.now() + 3_000);
  try {
    if (connection?.type === 'lavalink') await connection.player?.destroy?.('restore-target-invalid');
    else connection?.destroy?.();
  } finally {
    if (serverQueue.connection === connection) serverQueue.connection = null;
    if (serverQueue.lavalinkPlayer === connection?.player) serverQueue.lavalinkPlayer = null;
  }
}

export async function restoreStartupState(client, guildId, state, { lavalinkReady = true } = {}) {
  const serverQueue = musicQueue.get(guildId);
  const generation = serverQueue.lifecycleGeneration;
  const isCurrent = () => musicQueue.peek(guildId) === serverQueue
    && serverQueue.lifecycleGeneration === generation && !serverQueue.disposed && !serverQueue.clearingQueue;

  // Phase 1 (in the guild lock): pure state work only — hydrate, resolve
  // channels that are already cached, and validate the restore target. No
  // network await may run here or one slow restore would block every later
  // /play, pause or skip for this guild.
  const plan = await MusicPlayer.runTransition(guildId, async () => {
    if (!isCurrent()) return null;
    hydrateQueue(serverQueue, state);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    serverQueue.textChannel = state.textChannelId
      ? (guild.channels.cache.get(state.textChannelId) || serverQueue.textChannel || null)
      : null;

    const voiceChannel = state.voiceChannelId
      ? (guild.channels.cache.get(state.voiceChannelId) || null)
      : null;

    if (!voiceChannel?.isVoiceBased?.()) {
      if (!serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0 && !serverQueue.is247) {
        musicQueue.delete(guildId);
        PlaybackState.delete(guildId);
      }
      return { deferred: true, guild, voiceChannel: null };
    }

    serverQueue.voiceChannelRef = voiceChannel;
    serverQueue.guildRef = guild;
    const hasHumans = voiceChannel.members.some(member => !member.user.bot);
    if (!serverQueue.is247 && !hasHumans) {
      serverQueue.pausedByEmptyChannel = true;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { deferred: true, guild, voiceChannel };
    }
    if (!canRestoreVoiceChannel(guild, serverQueue, voiceChannel, { requireHumans: !serverQueue.is247 })) {
      return { deferred: true, guild, voiceChannel };
    }
    // A persisted manual pause must not briefly play while recreating output.
    if (isManualPlaybackPaused(serverQueue)) return { deferred: true, guild, voiceChannel };

    if (isLavalinkEnabled() && !lavalinkReady) {
      serverQueue.backendUnavailable = true;
      serverQueue.playbackBlocked = true;
      serverQueue.pendingRecovery = {
        guildId,
        playbackId: serverQueue.playbackId,
        reason: 'Lavalink 启动延迟',
        at: Date.now(),
      };
      MusicPlayer.scheduleLavalinkRecovery(guildId, serverQueue);
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return { deferred: true, guild, voiceChannel };
    }
    return { deferred: false, guild, voiceChannel };
  }, { createQueue: false }).catch(error => {
    console.error(`[Recovery] guild ${guildId} startup restore failed:`, error.message);
    return null;
  });

  if (!plan) return false;

  // Phase 2 (outside the guild lock): the slow network work.
  if (!plan.deferred && plan.voiceChannel) {
    try {
      const connection = await MusicPlayer.joinVoice(plan.voiceChannel, guildId, plan.guild.voiceAdapterCreator);
      if (!isCurrent() || isManualPlaybackPaused(serverQueue)
        || !canRestoreVoiceChannel(plan.guild, serverQueue, plan.voiceChannel, { requireHumans: !serverQueue.is247 })) {
        await releaseRestoredVoiceConnection(serverQueue, connection);
        if (isCurrent() && !serverQueue.is247 && !plan.voiceChannel.members.some(member => !member.user.bot)) {
          serverQueue.pausedByEmptyChannel = true;
          savePlaybackState(guildId, serverQueue, { immediate: true });
        }
        return false;
      }
      // Commit inside the lock: assignment plus the "not deferred" decision.
      const committed = await MusicPlayer.runTransition(guildId, async () => {
        if (!isCurrent()) return false;
        serverQueue.connection = connection;
        serverQueue.pausedByEmptyChannel = false;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        return true;
      }, { createQueue: false });
      if (!committed) {
        await releaseRestoredVoiceConnection(serverQueue, connection);
        return false;
      }
    } catch (error) {
      console.error(`[Recovery] guild ${guildId} 恢复失败:`, error.message);
      if (isCurrent() && serverQueue.is247 && !serverQueue.connection) {
        serverQueue.backendUnavailable = true;
        serverQueue.playbackBlocked = true;
        serverQueue.pendingRecovery = {
          guildId,
          playbackId: serverQueue.playbackId,
          reason: error.message || '启动语音连接失败',
          at: Date.now(),
        };
        const retryAt = Number(error.retryAt) || 0;
        if (error.code === 'VOICE_JOIN_BLOCKED' && retryAt > Date.now()) {
          MusicPlayer.scheduleVoiceRecovery(guildId, serverQueue, 'communication-timeout-expired', retryAt - Date.now() + 1_000);
        } else {
          MusicPlayer.scheduleLavalinkRecovery(guildId, serverQueue, 60_000);
        }
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
      return false;
    }
  }

  if (!isCurrent()) return false;

  // Resolve the channels that were not cached without holding the lock.
  if (state.textChannelId && !serverQueue.textChannel) {
    serverQueue.textChannel = await plan.guild.channels.fetch(state.textChannelId).catch(() => null);
  }
  if (serverQueue.notificationMode === 'panel' && serverQueue.currentSong) {
    await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue).catch(error => {
      console.warn(`[Recovery] guild ${guildId} panel refresh failed:`, error.message);
    });
  }
  if (plan.deferred || !plan.voiceChannel) return false;

  // Output restore still awaits network, so it stays outside the lock.
  if (serverQueue.currentSong) {
    await MusicPlayer.ensurePlaybackOutput(guildId, 'startup-restore', { force: true });
    if (!isCurrent()) return false;
    await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue).catch(error => {
      console.warn(`[Recovery] guild ${guildId} panel refresh after playback restore failed:`, error.message);
    });
  } else if (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled) {
    await MusicPlayer.playSong(guildId, serverQueue.textChannel || null);
  }
  return true;
}

export async function execute(client) {
  console.log(`✅ ${client.user.tag} 已上线!`);
  console.log(`📊 服务数量: ${client.guilds.cache.size}`);
  console.log(`👥 用户数量: ${client.users.cache.size}`);
  client.user.setActivity('🎵 音乐 | /play', { type: ActivityType.Listening });

  let lavalinkReady = true;
  if (isLavalinkEnabled()) {
    try {
      await initLavalink(client);
      console.log('✅ Lavalink 客户端已初始化');
      lavalinkReady = await waitForLavalinkReady(30_000);
      if (!lavalinkReady) console.warn('[Lavalink] 节点连接超时，跳过启动恢复播放');
    } catch (error) {
      console.error('[Lavalink] 初始化失败:', error.message);
      lavalinkReady = false;
    }
  }

  const states = PlaybackState.getAll();
  for (const [guildId, state] of Object.entries(states)) {
    await restoreStartupState(client, guildId, state, { lavalinkReady });
  }
}
