import { ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { Bilibili } from '../utils/bilibili.js';
import { YouTube } from '../utils/youtube.js';
import { SpotifyHandler } from '../utils/spotify.js';
import { addSongsToPlayback } from '../utils/playback.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

const PLAY_TIMING = process.env.PLAY_TIMING === '1';

function timingLog(startedAt, step) {
  if (PLAY_TIMING) console.log(`[play timing] ${step}: ${Date.now() - startedAt}ms`);
}

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('播放YouTube、Bilibili或Spotify音乐')
  .addStringOption(option =>
    option.setName('query')
      .setDescription('YouTube链接、Bilibili BV/av/链接、Spotify链接或搜索关键词')
      .setRequired(true)
  );

export async function execute(interaction) {
  const t0 = Date.now();
  console.log(`[play] execute start, interaction age: ${t0 - interaction.createdTimestamp}ms`);
  if (!(await requireMusicAccess(interaction, { requireVoice: true }))) return;
  try {
    await interaction.deferReply({ flags: 64 });
    console.log(`[play] deferReply ok, took: ${Date.now() - t0}ms`);
  } catch (error) {
    console.error(`[play] deferReply failed (age: ${Date.now() - interaction.createdTimestamp}ms):`, error.message);
    return;
  }

  const query = interaction.options.getString('query');
  const voiceChannel = interaction.member.voice.channel;

  if (!voiceChannel) {
    return interaction.editReply('❌ 你需要先加入语音频道！');
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return interaction.editReply('❌ 我没有权限加入或在该语音频道说话！');
  }

  let songs = [];
  let queuedItemIds = [];
  let enqueueQueue = null;
  let enqueueGeneration = null;

  try {
    if (SpotifyHandler.isSpotifyUrl(query)) {
      await interaction.editReply('🔍 正在解析Spotify链接...');
      
      let spotifyData;
      if (query.includes('/track/')) {
        spotifyData = await SpotifyHandler.getTrack(query);
        timingLog(t0, 'spotify track parsed');
        if (spotifyData) {
          const ytSong = await SpotifyHandler.convertToYouTube(spotifyData);
          timingLog(t0, 'spotify track converted');
          if (ytSong) songs.push(ytSong);
        }
      } else if (query.includes('/album/') || query.includes('/playlist/')) {
        spotifyData = query.includes('/album/') 
          ? await SpotifyHandler.getAlbum(query)
          : await SpotifyHandler.getPlaylist(query);
        timingLog(t0, 'spotify collection parsed');
        if (spotifyData) {
          songs = await SpotifyHandler.convertToYouTube(spotifyData);
          timingLog(t0, 'spotify collection converted');
        }
      }
    } else if (Bilibili.isBilibiliInput(query)) {
      await interaction.editReply('🔍 正在解析Bilibili视频...');
      const video = await Bilibili.getVideoInfo(query);
      timingLog(t0, 'bilibili video info loaded');
      if (video) {
        songs.push(video);
      }
    } else if (YouTube.isYouTubeUrl(query)) {
      if (YouTube.isPlaylist(query)) {
        await interaction.editReply('🔍 正在加载YouTube播放列表...');
        const playlist = await YouTube.getPlaylist(query);
        timingLog(t0, 'youtube playlist loaded');
        if (playlist) {
          songs = playlist;
        }
      } else {
        // Join only after metadata succeeds, through the shared enqueue transition.
        // A failed lookup must not leave an unowned, idle voice connection.
        const video = await YouTube.getVideoInfo(query);
        timingLog(t0, 'youtube video info loaded');
        if (video) {
          songs.push(video);
        }
      }
    } else {
      await interaction.editReply('🔍 正在搜索...');
      const searchResults = await YouTube.search(query, 5);
      timingLog(t0, 'youtube search loaded');
      if (searchResults.length === 0) {
        return interaction.editReply('❌ 未找到任何歌曲！');
      }

      const sessionId = `${interaction.id}_${Date.now()}`;
      const now = Date.now();
      for (const [id, session] of interaction.client.searchSessions) {
        if (now - session.createdAt > 3 * 60 * 1000) {
          interaction.client.searchSessions.delete(id);
        }
      }

      interaction.client.searchSessions.set(sessionId, {
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        voiceChannelId: voiceChannel.id,
        query,
        results: searchResults,
        createdAt: now,
      });

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`play_search:${sessionId}`)
        .setPlaceholder('选择要播放的歌曲')
        .addOptions(searchResults.map((song, index) => ({
          label: song.title.slice(0, 100),
          description: `${song.duration || 'N/A'} | ${song.author || 'Unknown'}`.slice(0, 100),
          value: String(index),
        })));

      return interaction.editReply({
        content: `🔍 搜索结果：**${query}**\n请选择要播放的歌曲（3 分钟内有效）。`,
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    if (songs.length === 0) {
      return interaction.editReply('❌ 未找到任何歌曲！');
    }

    enqueueQueue = musicQueue.get(interaction.guild.id);
    enqueueGeneration = enqueueQueue.lifecycleGeneration;
    queuedItemIds = songs
      .map(song => MusicPlayer.ensureQueueItemId(song)?.queueItemId)
      .filter(Boolean);
    await addSongsToPlayback(interaction, songs, { editReply: true });
    timingLog(t0, 'play command completed');
  } catch (error) {
    console.error('Play command error:', error);
    // Metadata failures have not acquired any playback resources. Only roll back
    // the queue this command actually used, never a replacement/current session.
    if (enqueueQueue && queuedItemIds.length) {
      await MusicPlayer.runTransition(interaction.guild.id, async () => {
        const serverQueue = musicQueue.peek(interaction.guild.id);
        if (serverQueue !== enqueueQueue || serverQueue.lifecycleGeneration !== enqueueGeneration
          || serverQueue.disposed || serverQueue.clearingQueue) return;
        MusicPlayer.removeQueueItemsById(serverQueue, queuedItemIds);
        savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
        if (!serverQueue.playing && !serverQueue.currentSong && serverQueue.songs.length === 0
          && serverQueue.radioQueue.length === 0 && !serverQueue.radio?.enabled && !serverQueue.is247) {
          // Shared cleanup also destroys a real local connection when Lavalink
          // is configured, and cancels delayed state saves/recovery work.
          await MusicPlayer.clearQueueAndLeave(interaction.guild.id, 'play-command-error', { notify: false });
        }
      }, { createQueue: false }).catch(cleanupError => {
        console.error('Play command cleanup error:', cleanupError);
      });
    }

    const message = error.message?.includes('语音') || error.message?.includes('连接') || error.message?.includes('Bilibili')
      ? `❌ ${error.message}`
      : '❌ 播放时出现错误，请稍后再试！';
    return interaction.editReply(message);
  }
}
