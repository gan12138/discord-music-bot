import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { describeStyle } from '../utils/radio.js';
import { requireGuild } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('显示当前播放队列')
  .addIntegerOption(option =>
    option.setName('page')
      .setDescription('页码')
      .setMinValue(1)
      .setRequired(false)
  );

export async function execute(interaction) {
  if (!(await requireGuild(interaction))) return;
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || (!serverQueue.currentSong && serverQueue.songs.length === 0 && serverQueue.radioQueue.length === 0)) {
    return interaction.reply('📭 队列为空！');
  }

  const page = interaction.options.getInteger('page') || 1;
  const songsPerPage = 10;
  const totalItems = serverQueue.songs.length + serverQueue.radioQueue.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / songsPerPage));

  if (page > totalPages) {
    return interaction.reply(`❌ 页码超出范围！总共 ${totalPages} 页`);
  }

  const startIndex = (page - 1) * songsPerPage;
  const endIndex = startIndex + songsPerPage;
  // 先计算需要的范围，再创建对象，避免大队列时的内存浪费
  const allSongs = [];
  const manualLen = serverQueue.songs.length;
  for (let i = Math.max(0, startIndex); i < Math.min(manualLen, endIndex); i++) {
    allSongs.push({ ...serverQueue.songs[i], queueType: '手动队列' });
  }
  const radioStart = Math.max(0, startIndex - manualLen);
  const radioEnd = endIndex - manualLen;
  if (radioEnd > 0) {
    for (let i = Math.max(0, radioStart); i < Math.min(serverQueue.radioQueue.length, radioEnd); i++) {
      allSongs.push({ ...serverQueue.radioQueue[i], queueType: '自动续播' });
    }
  }
  const currentSongs = allSongs;

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('🎵 播放队列')
    .setDescription(
      [
        serverQueue.currentSong ? `▶️ **正在播放:** ${serverQueue.currentSong.title}\n   来源: ${serverQueue.currentSong.source === 'radio' ? '自动续播' : '用户点播'}` : null,
        ...currentSongs.map((song, index) => {
          const actualIndex = startIndex + index + 1;
          return `**${actualIndex}.** ${song.title}\n` +
                 `   ${song.queueType} | 时长: ${song.duration} | 请求者: ${song.requestedBy}`;
        })
      ].filter(Boolean).join('\n\n')
    )
    .addFields(
      { name: '手动队列', value: `${serverQueue.songs.length} 首`, inline: true },
      { name: '自动续播', value: `${serverQueue.radioQueue.length} 首`, inline: true },
      { name: '页码', value: `${page}/${totalPages}`, inline: true },
      { name: '循环模式', value: serverQueue.loop === 'off' ? '关闭' : 
                serverQueue.loop === 'single' ? '单曲循环' : '列表循环', inline: true },
      { name: 'Radio 风格', value: describeStyle(serverQueue.radio.currentStyle), inline: false }
    )
    .setFooter({ text: '使用 /skip 跳过歌曲 | /remove 移除歌曲' });

  await interaction.reply({ embeds: [embed] });
}
