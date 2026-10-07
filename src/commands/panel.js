import { SlashCommandBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { buildNowPlayingPayload, refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { GuildSettings } from '../models/database.js';
import { requireGuild, requireMusicAccess } from '../utils/commandSafety.js';

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
  if (!(await requireGuild(interaction))) return;
  if (['public', 'off'].includes(subcommand)
    && !(await requireMusicAccess(interaction, { manageGuildOnly: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const serverQueue = musicQueue.peek(interaction.guild.id);

  if (!serverQueue && subcommand === 'off') {
    GuildSettings.update(interaction.guild.id, { notificationMode: 'private' });
    return interaction.editReply('✅ 已关闭公开播放状态栏，之后默认使用私密面板。');
  }

  if (!serverQueue || (!serverQueue.currentSong && subcommand !== 'off')) {
    return interaction.editReply('❌ 当前没有正在播放的歌曲。');
  }

  if (subcommand === 'public') {
    GuildSettings.update(interaction.guild.id, { notificationMode: 'panel' });
    serverQueue.notificationMode = 'panel';
    serverQueue.textChannel = interaction.channel;
    serverQueue.textChannelId = interaction.channel.id;
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    return interaction.editReply('✅ 已在当前聊天室开启公开播放状态栏，之后会随歌曲自动刷新。');
  }

  if (subcommand === 'off') {
    GuildSettings.update(interaction.guild.id, { notificationMode: 'private' });
    serverQueue.notificationMode = 'private';
    serverQueue.nowPlayingMessageId = null;
    serverQueue.nowPlayingChannelId = null;
    savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
    return interaction.editReply('✅ 已关闭公开播放状态栏，之后默认使用私密面板。');
  }

  return interaction.editReply({
    ...buildNowPlayingPayload(serverQueue, serverQueue.currentSong),
  });
}
