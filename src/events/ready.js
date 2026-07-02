import { ActivityType, Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { PlaybackState } from '../models/database.js';
import { initLavalink, isLavalinkEnabled, waitForLavalinkReady } from '../utils/lavalink.js';
import { hydrateQueue, savePlaybackState } from '../utils/playbackState.js';

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

    if (isLavalinkEnabled() && serverQueue.currentSong?.source === 'radio') {
      serverQueue.currentSong = null;
      serverQueue.playing = false;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      serverQueue.suppressRadioUntilManualPlay = true;
      savePlaybackState(guildId, serverQueue, { immediate: true });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    serverQueue.textChannel = state.textChannelId ? await guild.channels.fetch(state.textChannelId).catch(() => null) : null;

    const voiceChannel = state.voiceChannelId ? await guild.channels.fetch(state.voiceChannelId).catch(() => null) : null;
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
      if (!serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0 && !serverQueue.is247) {
        musicQueue.delete(guildId);
        PlaybackState.delete(guildId);
      }
      continue;
    }

    try {
      serverQueue.connection = await MusicPlayer.joinVoice(voiceChannel, guildId, guild.voiceAdapterCreator);

      // 频道无人时只保持连接，不播放，不触发 radio/AI
      const humanCount = voiceChannel.members.filter(m => !m.user.bot).size;
      if (humanCount === 0) {
        serverQueue.pausedByEmptyChannel = true;
        savePlaybackState(guildId, serverQueue, { immediate: true });
        continue;
      }

      serverQueue.pausedByEmptyChannel = false;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      if (serverQueue.currentSong && serverQueue.textChannel && (!isLavalinkEnabled() || lavalinkReady)) {
        await MusicPlayer.playSong(guildId, serverQueue.textChannel, serverQueue.currentSong, serverQueue.currentSong.source || 'manual', {
          seekSeconds: serverQueue.seekOffsetSeconds || 0,
        });
      } else if (serverQueue.currentSong && isLavalinkEnabled() && !lavalinkReady) {
        serverQueue.playing = false;
        savePlaybackState(guildId, serverQueue, { immediate: true });
      }
    } catch (error) {
      console.error(`[Recovery] guild ${guildId} 恢复失败:`, error.message);
    }
  }
}
