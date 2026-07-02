import { musicQueue, MusicPlayer } from './player.js';
import { buildNowPlayingPayload } from './playerPanel.js';
import { savePlaybackState } from './playbackState.js';

const PLAY_TIMING = process.env.PLAY_TIMING === '1';

function timingLog(startedAt, step) {
  if (PLAY_TIMING && startedAt) console.log(`[play timing] ${step}: ${Date.now() - startedAt}ms`);
}

export async function addSongsToPlayback(interaction, songs, { editReply = true, respond = true, successNote = '' } = {}) {
  const startedAt = PLAY_TIMING ? Date.now() : null;
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    const message = '❌ 你需要先加入语音频道！';
    return editReply ? interaction.editReply(message) : interaction.reply({ content: message, flags: 64 });
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    const message = '❌ 我没有权限加入或在该语音频道说话！';
    return editReply ? interaction.editReply(message) : interaction.reply({ content: message, flags: 64 });
  }

  const serverQueue = musicQueue.get(interaction.guild.id);
  MusicPlayer.clearIdleLeaveTimer(serverQueue);
  serverQueue.queueEnded = false;
  serverQueue.textChannel = interaction.channel;
  serverQueue.textChannelId = interaction.channel.id;

  const queuedSongs = songs.map(song => ({
    ...song,
    requestedBy: interaction.user.toString(),
    source: 'manual',
  }));
  const addedSongs = [...queuedSongs];

  // 健全性检查：如果标记为 playing 但实际上没有 player 和 connection，视为脏状态
  if (serverQueue.playing && !serverQueue.player && !serverQueue.connection) {
    console.warn(`[Playback] Detected stale playing=true for guild ${interaction.guild.id}, resetting`);
    serverQueue.playing = false;
    serverQueue.advancing = false;
  }

  // 检查是否需要启动播放（在 push 之前检查，避免并发竞态）。
  // 当前正在自动续播时，手动点歌只加入手动队列，等当前歌自然结束后优先播放。
  const shouldStartPlayback = !serverQueue.playing && !serverQueue.advancing;

  MusicPlayer.prepareManualPlayback(serverQueue);
  serverQueue.songs.push(...queuedSongs);
  savePlaybackState(interaction.guild.id, serverQueue);

  // joinVoice 与后续操作并行：如果需要连接语音，提前启动
  let joinPromise = null;
  if (!serverQueue.connection) {
    joinPromise = MusicPlayer.joinVoice(
      voiceChannel,
      interaction.guild.id,
      interaction.guild.voiceAdapterCreator
    );
  }

  if (joinPromise) {
    serverQueue.connection = await joinPromise;
    timingLog(startedAt, 'joinVoice completed');
  }

  if (shouldStartPlayback) {
    await MusicPlayer.playSong(interaction.guild.id, interaction.channel);
    timingLog(startedAt, 'playSong completed');
  }

  const currentSong = serverQueue.currentSong || addedSongs[0];
  const response = serverQueue.notificationMode === 'private' ? {
    content: addedSongs.length === 1
      ? (shouldStartPlayback ? '🎵 已添加并开始播放。' : '📝 已添加到队列。')
      : (shouldStartPlayback ? `🎵 已添加 ${addedSongs.length} 首歌并开始播放。` : `📝 已添加 ${addedSongs.length} 首歌到队列。`),
    ...buildNowPlayingPayload(serverQueue, currentSong),
  } : {
    content: addedSongs.length === 1
      ? (shouldStartPlayback ? '🎵 已添加并开始播放。' : '📝 已添加到队列。')
      : (shouldStartPlayback ? `🎵 已添加 ${addedSongs.length} 首歌并开始播放。` : `📝 已添加 ${addedSongs.length} 首歌到队列。`),
  };
  if (successNote) response.content += `\n${successNote}`;
  if (!respond) {
    // The caller already acknowledged the interaction.
  } else if (editReply) {
    await interaction.editReply(response);
  } else if (interaction.replied || interaction.deferred) {
    await interaction.editReply(response);
  } else {
    await interaction.reply(response);
  }
  timingLog(startedAt, 'playback response sent');

}
