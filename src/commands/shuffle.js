import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('随机打乱队列');

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || serverQueue.songs.length <= 1) {
    return interaction.reply('❌ 队列中没有足够的歌曲可以打乱！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  if (MusicPlayer.shuffle(interaction.guild.id)) {
    savePlaybackState(interaction.guild.id, serverQueue);
    await interaction.reply('🔀 队列已随机打乱');
  } else {
    await interaction.reply('❌ 打乱失败！');
  }
}
