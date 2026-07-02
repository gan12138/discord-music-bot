import { SlashCommandBuilder } from 'discord.js';
import { MusicPlayer, musicQueue } from '../utils/player.js';
import { durationToSeconds, formatSeekTime, parseSeekTime } from '../utils/time.js';

export const data = new SlashCommandBuilder()
  .setName('seek')
  .setDescription('跳转到当前歌曲的指定时间')
  .addStringOption(option =>
    option
      .setName('time')
      .setDescription('时间，例如 90、1:30、01:02:03')
      .setRequired(true)
  );

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);
  if (!serverQueue?.currentSong) {
    return interaction.reply({ content: '❌ 当前没有正在播放的歌曲。', flags: 64 });
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply({ content: '❌ 你需要和我在同一个语音频道！', flags: 64 });
  }

  const seconds = parseSeekTime(interaction.options.getString('time'));
  if (seconds === null) {
    return interaction.reply({ content: '❌ 时间格式无效，请使用 90、1:30 或 01:02:03。', flags: 64 });
  }

  const duration = durationToSeconds(serverQueue.currentSong.duration);
  if (duration !== null && seconds >= duration) {
    return interaction.reply({ content: `❌ 跳转时间不能超过歌曲时长 ${formatSeekTime(duration)}。`, flags: 64 });
  }

  await interaction.deferReply();
  try {
    await MusicPlayer.seek(interaction.guild.id, seconds);
    return interaction.editReply(`✅ 已跳转到 ${formatSeekTime(seconds)}。`);
  } catch (error) {
    console.error('[Seek] error:', error.message);
    return interaction.editReply('❌ 跳转失败，请稍后再试。');
  }
}
