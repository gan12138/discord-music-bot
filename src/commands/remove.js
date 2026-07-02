import { SlashCommandBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { savePlaybackState } from '../utils/playbackState.js';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('从队列中移除歌曲')
  .addIntegerOption(option =>
    option.setName('position')
      .setDescription('歌曲在队列中的位置')
      .setMinValue(1)
      .setRequired(true)
  );

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || serverQueue.songs.length === 0) {
    return interaction.reply('❌ 队列为空！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  const position = interaction.options.getInteger('position');

  if (position > serverQueue.songs.length) {
    return interaction.reply(`❌ 位置超出范围！队列中只有 ${serverQueue.songs.length} 首歌曲`);
  }

  const removedSong = serverQueue.songs.splice(position - 1, 1)[0];
  savePlaybackState(interaction.guild.id, serverQueue);
  await interaction.reply(`🗑️ 已从队列移除: **${removedSong.title}**`);
}
