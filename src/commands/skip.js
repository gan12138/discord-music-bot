import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('跳过当前播放的歌曲');

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.reply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  const result = await MusicPlayer.skip(interaction.guild.id);
  if (result.ok) {
    await interaction.reply(`⏭️ 已跳过当前歌曲，正在播放：**${result.song.title}**`);
    return;
  }

  if (result.reason === 'no-radio-recommendation') {
    await interaction.reply('📻 Radio 暂时没有找到下一首，当前歌曲会继续播放。请稍后再试或使用 `/radio style` 调整风格。');
    return;
  }

  if (result.reason === 'no-next-song') {
    await interaction.reply('📭 队列里没有下一首。');
    return;
  }

  await interaction.reply('❌ 跳过失败！');
}
