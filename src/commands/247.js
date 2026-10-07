import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { requireGuild, requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('247')
  .setDescription('24/7 语音频道保持模式')
  .addSubcommand(subcommand =>
    subcommand
      .setName('on')
      .setDescription('开启 24/7 模式')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('off')
      .setDescription('关闭 24/7 模式')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('status')
      .setDescription('查看 24/7 状态')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'status') {
    if (!(await requireGuild(interaction))) return;
  } else if (!(await requireMusicAccess(interaction, {
    manageGuildOnly: true,
    requireVoice: subcommand === 'on',
  }))) return;
  const serverQueue = subcommand === 'status'
    ? musicQueue.peek(interaction.guild.id)
    : subcommand === 'on'
      ? musicQueue.get(interaction.guild.id)
      : musicQueue.peek(interaction.guild.id);

  if (!serverQueue) {
    return interaction.reply('ℹ️ 24/7 模式未开启。');
  }

  const updateTextChannel = subcommand !== 'status';
  if (updateTextChannel) {
    serverQueue.textChannel = interaction.channel;
    serverQueue.textChannelId = interaction.channel.id;
  }

  if (subcommand === 'on') {
    serverQueue.is247 = true;

    const voiceChannel = interaction.member.voice.channel;
    if (voiceChannel && !serverQueue.connection) {
      await interaction.deferReply();
      try {
        serverQueue.connection = await MusicPlayer.joinVoice(
          voiceChannel,
          interaction.guild.id,
          interaction.guild.voiceAdapterCreator
        );
        savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
        await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
        return interaction.editReply('✅ 24/7 模式已开启，我会尽量保持在当前语音频道。');
      } catch (error) {
        console.error('[247] joinVoice error:', error.message);
        savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
        return interaction.editReply('✅ 24/7 模式已开启，但加入语音频道失败。播放音乐时会自动重试。');
      }
    }

    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.reply('✅ 24/7 模式已开启。加入语音频道并播放音乐后，我会保持连接。');
  }

  if (subcommand === 'off') {
    serverQueue.is247 = false;
    serverQueue.pausedByEmptyChannel = false;
    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.reply('✅ 24/7 模式已关闭。语音频道无人时会按普通逻辑离开。');
  }

  const embed = new EmbedBuilder()
    .setColor(serverQueue.is247 ? 0x00ff00 : 0x999999)
    .setTitle('24/7 状态')
    .addFields(
      { name: '状态', value: serverQueue.is247 ? '开启' : '关闭', inline: true },
      { name: '语音频道', value: serverQueue.voiceChannelId ? `<#${serverQueue.voiceChannelId}>` : '未记录', inline: true },
      { name: '当前播放', value: serverQueue.currentSong?.title || '无', inline: false },
      { name: '队列', value: `${serverQueue.songs.length} 首`, inline: true }
    );

  return interaction.reply({ embeds: [embed] });
}
