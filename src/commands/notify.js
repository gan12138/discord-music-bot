import { SlashCommandBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { GuildSettings } from '../models/database.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

const LABELS = {
  private: '私人面板模式（推荐）',
  panel: '单面板模式（推荐）',
  off: '关闭提示',
  on: '每首歌发新消息',
};

export const data = new SlashCommandBuilder()
  .setName('notify')
  .setDescription('设置正在播放提示方式')
  .addStringOption(option =>
    option
      .setName('mode')
      .setDescription('提示方式')
      .setRequired(true)
      .addChoices(
        { name: LABELS.private, value: 'private' },
        { name: LABELS.panel, value: 'panel' },
        { name: LABELS.off, value: 'off' },
        { name: LABELS.on, value: 'on' }
      )
  );

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { manageGuildOnly: true }))) return;
  await interaction.deferReply({ flags: 64 });
  const mode = interaction.options.getString('mode');
  GuildSettings.update(interaction.guild.id, { notificationMode: mode });
  const serverQueue = musicQueue.peek(interaction.guild.id);
  if (!serverQueue) {
    return interaction.editReply({ content: `✅ 正在播放提示已设置为：${LABELS[mode]}。下次播放时生效。` });
  }
  serverQueue.notificationMode = mode;
  if (mode !== 'panel') {
    serverQueue.nowPlayingMessageId = null;
    serverQueue.nowPlayingChannelId = null;
  }
  savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
  return interaction.editReply(`✅ 正在播放提示已设置为：${LABELS[mode]}。`);
}
