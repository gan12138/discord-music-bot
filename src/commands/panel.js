import { SlashCommandBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { buildNowPlayingPayload, refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { savePlaybackState } from '../utils/playbackState.js';

export const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('播放控制面板和公开状态栏')
  .addSubcommand(subcommand =>
    subcommand
      .setName('private')
      .setDescription('私密显示当前播放控制面板')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('public')
      .setDescription('在当前聊天室发布公开播放状态栏并自动刷新')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('off')
      .setDescription('关闭公开播放状态栏')
  );

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue || (!serverQueue.currentSong && subcommand !== 'off')) {
    return interaction.reply({ content: '❌ 当前没有正在播放的歌曲。', flags: 64 });
  }

  if (subcommand === 'public') {
    serverQueue.notificationMode = 'panel';
    serverQueue.textChannel = interaction.channel;
    serverQueue.textChannelId = interaction.channel.id;
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    return interaction.reply('✅ 已在当前聊天室开启公开播放状态栏，之后会随歌曲自动刷新。');
  }

  if (subcommand === 'off') {
    serverQueue.notificationMode = 'private';
    serverQueue.nowPlayingMessageId = null;
    serverQueue.nowPlayingChannelId = null;
    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    return interaction.reply('✅ 已关闭公开播放状态栏，之后默认使用私密面板。');
  }

  return interaction.reply({
    ...buildNowPlayingPayload(serverQueue, serverQueue.currentSong),
    flags: 64,
  });
}
