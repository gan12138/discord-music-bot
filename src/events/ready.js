import { ActivityType, Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { PlaybackState } from '../models/database.js';
import { initLavalink, isLavalinkEnabled, waitForLavalinkReady } from '../utils/lavalink.js';
import { hydrateQueue, savePlaybackState } from '../utils/playbackState.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';

export const name = Events.ClientReady;
export const once = true;

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
    const serverQueue = musicQueue.get(guildId);
    hydrateQueue(serverQueue, state);

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    serverQueue.textChannel = state.textChannelId ? await guild.channels.fetch(state.textChannelId).catch(() => null) : null;

    if (serverQueue.notificationMode === 'panel' && serverQueue.currentSong) {
      await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue).catch(error => {
        console.warn(`[Recovery] guild ${guildId} panel refresh failed:`, error.message);
      });
    }

    const voiceChannel = state.voiceChannelId ? await guild.channels.fetch(state.voiceChannelId).catch(() => null) : null;
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
      if (!serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0 && !serverQueue.is247) {
        musicQueue.delete(guildId);
        PlaybackState.delete(guildId);
      }
      continue;
    }

    try {
      const humanCount = voiceChannel.members.filter(m => !m.user.bot).size;
      serverQueue.voiceChannelId = voiceChannel.id;
      serverQueue.voiceChannelRef = voiceChannel;
      serverQueue.guildRef = guild;

      if (!serverQueue.is247 && humanCount === 0) {
        serverQueue.pausedByEmptyChannel = true;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        continue;
      }

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
        continue;
      }

      serverQueue.connection = await MusicPlayer.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator);

      serverQueue.pausedByEmptyChannel = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      if (serverQueue.currentSong && (!isLavalinkEnabled() || lavalinkReady)) {
        await MusicPlayer.ensurePlaybackOutput(guildId, 'startup-restore', { force: true });
        await refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue).catch(error => {
          console.warn(`[Recovery] guild ${guildId} panel refresh after playback restore failed:`, error.message);
        });
      } else if (!serverQueue.currentSong
        && (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled)
        && (!isLavalinkEnabled() || lavalinkReady)) {
        await MusicPlayer.playSong(guildId, serverQueue.textChannel || null);
      }
    } catch (error) {
      console.error(`[Recovery] guild ${guildId} 恢复失败:`, error.message);
      if (serverQueue.is247 && !serverQueue.connection) {
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
          MusicPlayer.scheduleVoiceRecovery(
            guildId,
            serverQueue,
            'communication-timeout-expired',
            retryAt - Date.now() + 1_000,
          );
        } else {
          MusicPlayer.scheduleLavalinkRecovery(guildId, serverQueue, 60_000);
        }
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
    }
  }
}
