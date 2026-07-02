import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { describeStyle } from '../utils/radio.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('显示当前播放的歌曲');

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing || !serverQueue.currentSong) {
    return interaction.reply('❌ 当前没有正在播放的歌曲！');
  }

  const song = serverQueue.currentSong;

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle('🎵 正在播放')
    .setDescription(`**${song.title}**`)
    .addFields(
      { name: '时长', value: song.duration || '未知', inline: true },
      { name: '请求者', value: song.requestedBy || '未知', inline: true },
      { name: '来源', value: song.source === 'radio' ? '自动续播' : '用户点播', inline: true },
      { name: '音量', value: `${serverQueue.volume}%`, inline: true },
      { name: '循环模式', value: serverQueue.loop === 'off' ? '关闭' : 
                serverQueue.loop === 'single' ? '单曲循环' : '列表循环', inline: true },
      { name: '手动队列', value: `${serverQueue.songs.length} 首`, inline: true },
      { name: '自动续播队列', value: `${serverQueue.radioQueue.length} 首`, inline: true },
      { name: '自动续播', value: serverQueue.radio.enabled ? '开启' : '关闭', inline: true },
      { name: 'AI 自动识别', value: serverQueue.radio.autodetect ? '开启' : '关闭', inline: true },
      { name: 'Radio 风格', value: describeStyle(serverQueue.radio.currentStyle), inline: false },
      { name: '待生效风格', value: serverQueue.radio.pendingStyle ? describeStyle(serverQueue.radio.pendingStyle) : '无', inline: false }
    );

  if (song.thumbnail) embed.setThumbnail(song.thumbnail);

  await interaction.reply({ embeds: [embed] });
}
