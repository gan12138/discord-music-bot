import { SlashCommandBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

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
  if (!(await requireMusicAccess(interaction, { requireVoice: true, requireBotInVoice: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || !serverQueue.playing) {
    return interaction.editReply('❌ 当前没有正在播放的歌曲！');
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || voiceChannel.id !== interaction.guild.members.me.voice.channel?.id) {
    return interaction.editReply('❌ 你需要和我在同一个语音频道！');
  }

  const mode = interaction.options.getString('mode');
  if (!MusicPlayer.setLoop(interaction.guild.id, mode)) {
    return interaction.editReply('❌ 循环模式设置失败。');
  }
  await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);

  const modeNames = {
    'off': '关闭',
    'single': '单曲循环',
    'queue': '列表循环'
  };

  await interaction.editReply(`🔁 循环模式已设置为: ${modeNames[mode]}`);
}
