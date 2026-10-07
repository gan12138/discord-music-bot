import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { isLavalinkEnabled, destroyLavalinkPlayer } from '../utils/lavalink.js';
import { findAIMusic } from '../utils/aiMusic.js';
import { addSongsToPlayback } from '../utils/playback.js';
import { getAIConfigStatus } from '../utils/aiClient.js';
import { versionPreferenceLabel } from '../utils/versionPreference.js';
import { describeStyle, invalidateRadioGeneration } from '../utils/radio.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('ai-music')
  .setDescription('用普通语言告诉 AI 你想听什么歌')
  .addStringOption(option =>
    option
      .setName('prompt')
      .setDescription('例如：想听适合晚上开车的粤语老歌，不要太吵')
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName('count')
      .setDescription('加入几首歌，默认 3 首')
      .setMinValue(1)
      .setMaxValue(5)
      .setRequired(false)
  );

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { requireVoice: true }))) return;
  const prompt = interaction.options.getString('prompt');
  const count = interaction.options.getInteger('count') || 3;
  const serverQueue = musicQueue.peek(interaction.guild.id);
  const preference = serverQueue?.versionPreference || 'any';

  await interaction.deferReply({ flags: 64 });

  let queuedSongs = [];
  let queuedItemIds = [];

  const aiConfig = getAIConfigStatus();
  if (!aiConfig.ok) {
    return interaction.editReply(
      `❌ AI 点歌未启用：${aiConfig.reason}。\n` +
      '请在 .env 设置 AI_ENABLED=true 和真实 AI_API_KEY 后重启机器人。'
    );
  }

  await interaction.editReply(`🤖 正在理解你的需求并找歌...\n版本偏好：${versionPreferenceLabel(preference)}`);

  try {
    const result = await findAIMusic(prompt, { preference, limit: count });
    if (!result.usedAI) {
      return interaction.editReply('❌ AI 请求失败，请检查 AI_BASE_URL、AI_API_KEY、AI_MODEL 或稍后再试。');
    }
    if (result.songs.length === 0) {
      return interaction.editReply('❌ AI 已返回点歌建议，但 YouTube 没找到可播放结果，请换个说法再试。');
    }

    const activeQueue = musicQueue.get(interaction.guild.id);
    queuedSongs = result.songs;
    queuedItemIds = queuedSongs
      .map(song => MusicPlayer.ensureQueueItemId(song)?.queueItemId)
      .filter(Boolean);
    let radioNote = '';
    if (result.radioStyle) {
      invalidateRadioGeneration(activeQueue, 'ai-radio-style');
      activeQueue.radio.enabled = true;
      activeQueue.radio.currentStyle = result.radioStyle;
      activeQueue.radio.pendingStyle = null;
      activeQueue.radio.seedSong = result.songs[0] || activeQueue.currentSong || null;
      activeQueue.radioQueue = [];
      savePlaybackState(interaction.guild.id, activeQueue);
      radioNote = `\n\n已同步到自动续播：${describeStyle(result.radioStyle)}`;
    }
    const titles = result.songs.map((song, index) => `${index + 1}. ${song.title}`).join('\n');
    const note = result.reason ? `\n\nAI 理解：${result.reason}` : '';
    return addSongsToPlayback(interaction, result.songs, {
      editReply: true,
      successNote: `AI 已加入：\n${titles}${note}${radioNote}`,
    });
  } catch (error) {
    console.error('[ai-music] command failed:', error);
    const activeQueue = musicQueue.peek(interaction.guild.id);
    if (activeQueue && queuedItemIds.length) {
      MusicPlayer.removeQueueItemsById(activeQueue, queuedItemIds);
      savePlaybackState(interaction.guild.id, activeQueue, { immediate: true });
    }
    if (activeQueue && !activeQueue.playing && activeQueue.songs.length === 0) {
      if (activeQueue.is247) {
        activeQueue.currentSong = null;
        activeQueue.audioResource = null;
        activeQueue.seekOffsetSeconds = 0;
        activeQueue.startedAt = null;
        activeQueue.pausedAt = null;
        savePlaybackState(interaction.guild.id, activeQueue, { immediate: true });
      } else {
        if (activeQueue.connection) {
          if (isLavalinkEnabled()) {
            await destroyLavalinkPlayer(interaction.guild.id, 'ai-music-command-error');
          } else {
            activeQueue.connection.destroy();
          }
        }
        musicQueue.delete(interaction.guild.id);
      }
    }
    const message = error.message?.includes('语音') || error.message?.includes('连接')
      ? `❌ ${error.message}`
      : '❌ AI 点歌执行失败，请稍后再试。';
    return interaction.editReply(message);
  }
}
