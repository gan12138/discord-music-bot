import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GuildSettings } from '../models/database.js';
import { requireMusicAccess } from '../utils/commandSafety.js';

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('管理服务器音乐设置')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand => subcommand
    .setName('dj-role')
      .setDescription('设置音乐控制 DJ 角色；留空时清除')
    .addRoleOption(option => option
      .setName('role')
      .setDescription('留空以清除 DJ 角色')
      .setRequired(false)));

export async function execute(interaction) {
  if (!(await requireMusicAccess(interaction, { manageGuildOnly: true }))) return;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== 'dj-role') {
    return interaction.reply({ content: '❌ 未知服务器设置。', flags: 64 });
  }

  const role = interaction.options.getRole('role');
  GuildSettings.update(interaction.guild.id, { djRole: role?.id || null });
  return interaction.reply({
    content: role
      ? `✅ 音乐控制 DJ 角色已设置为 <@&${role.id}>。`
      : '✅ 音乐控制 DJ 角色已清除，未设置 DJ 角色时所有成员都可以使用播放控制。',
    flags: 64,
    allowedMentions: { parse: [] },
  });
}
