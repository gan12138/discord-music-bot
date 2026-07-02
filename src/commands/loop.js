import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';

export const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('设置循环模式')
  .addStringOption(option =>
    option.setName('mode')
      .setDescription('循环模式')
      .setRequired(true)
      .addChoices(
        { name: '关闭循环', value: 'off' },
        { name: '单曲循环', value: 'single' },
        { name: '列表循环', value: 'queue' }
      )
  );

export async function execute(interaction) {
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.reply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.reply('❌ 你需要和我在同一个语音频道！');
  }

  const mode = interaction.options.getString('mode');
  MusicPlayer.setLoop(interaction.guild.id, mode);
  await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);

  const modeNames = {
    'off': '关闭',
    'single': '单曲循环',
    'queue': '列表循环'
  };

  await interaction.reply(`🔁 循环模式已设置为: ${modeNames[mode]}`);
}
