import { SlashCommandBuilder } from 'discord.js';
import { musicQueue } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { normalizeVersionPreference, versionPreferenceLabel } from '../utils/versionPreference.js';

export const data = new SlashCommandBuilder()
  .setName('version')
  .setDescription('设置 AI/Radio 尽量播放 Live 或普通版')
  .addStringOption(option =>
    option
      .setName('preference')
      .setDescription('版本偏好，不影响 /play')
      .setRequired(true)
      .addChoices(
        { name: '不限制', value: 'any' },
        { name: '尽量 Live / 现场版', value: 'live' },
        { name: '尽量普通 / 官方版', value: 'normal' }
      )
  );

export async function execute(interaction) {
  const preference = normalizeVersionPreference(interaction.options.getString('preference'));
  if (!preference) return interaction.reply({ content: '❌ 未知版本偏好。', flags: 64 });

  const serverQueue = musicQueue.peek(interaction.guild.id);
  if (!serverQueue) {
    return interaction.reply(`✅ AI/Radio 版本偏好已设置为：${versionPreferenceLabel(preference)}。下次播放时生效。\n这个设置不会影响 /play。`);
  }
  serverQueue.versionPreference = preference;
  savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
  await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
  return interaction.reply(`✅ AI/Radio 版本偏好已设置为：${versionPreferenceLabel(preference)}。\n这个设置不会影响 /play。`);
}
