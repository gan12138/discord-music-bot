import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { describeStyle } from './radio.js';

const VERSION_LABELS = {
  any: '任意',
  live: '现场优先',
  normal: '普通/MV 优先',
};

const NOTIFICATION_LABELS = {
  private: '私密面板',
  panel: '公开状态栏',
  on: '每首歌发新消息',
  off: '关闭',
};

export function songPanelId(song) {
  const value = song?.url || song?.title || 'unknown';
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function buildNowPlayingPayload(serverQueue, song) {
  const panelId = songPanelId(song);
  const currentTitle = song?.title || '当前没有正在播放的歌曲';
  const embed = {
      color: 0x00ff00,
      title: song ? '🎵 正在播放' : '🎵 播放状态栏',
      description: `**${currentTitle}**`,
      fields: [
        { name: '时长', value: song?.duration || 'N/A', inline: true },
        { name: '请求者', value: song?.requestedBy || 'Unknown', inline: true },
        { name: '来源', value: song?.source === 'radio' ? '自动续播' : '用户点播', inline: true },
        { name: '音量', value: `${serverQueue.volume ?? 50}%`, inline: true },
        { name: '循环', value: serverQueue.loop === 'off' ? '关闭' : serverQueue.loop === 'single' ? '单曲' : '队列', inline: true },
        { name: 'Radio', value: serverQueue.radio.enabled ? `开启｜${describeStyle(serverQueue.radio.currentStyle)}` : '关闭', inline: true },
        { name: '24/7', value: serverQueue.is247 ? '开启' : '关闭', inline: true },
        { name: '队列', value: `${serverQueue.songs?.length || 0} 首`, inline: true },
        { name: '版本偏好', value: VERSION_LABELS[serverQueue.versionPreference] || '任意', inline: true },
        { name: '状态栏', value: NOTIFICATION_LABELS[serverQueue.notificationMode] || serverQueue.notificationMode || '私密面板', inline: true },
      ],
    };
  if (song?.thumbnail) embed.thumbnail = { url: song.thumbnail };
  return {
    embeds: [embed],
    components: buildPlayerControls(panelId, serverQueue),
  };
}

export async function publishNowPlaying(guildId, textChannel, serverQueue, song) {
  const mode = serverQueue.notificationMode || 'private';
  if (mode === 'off' || mode === 'private' || !textChannel) return null;

  const payload = buildNowPlayingPayload(serverQueue, song);
  if (mode === 'on') {
    return textChannel.send(payload).catch(error => {
      console.warn('[PlayerPanel] failed to send now-playing message:', error.message);
      return null;
    });
  }

  if (serverQueue.nowPlayingMessageId && serverQueue.nowPlayingChannelId) {
    try {
      const channel = serverQueue.nowPlayingChannelId === textChannel.id
        ? textChannel
        : await textChannel.client.channels.fetch(serverQueue.nowPlayingChannelId);
      const message = await channel.messages.fetch(serverQueue.nowPlayingMessageId);
      await message.edit(payload);
      return message;
    } catch {
      serverQueue.nowPlayingMessageId = null;
      serverQueue.nowPlayingChannelId = null;
    }
  }

  const message = await textChannel.send(payload).catch(error => {
    console.warn('[PlayerPanel] failed to send now-playing panel:', error.message);
    return null;
  });
  if (!message) return null;
  serverQueue.nowPlayingMessageId = message.id;
  serverQueue.nowPlayingChannelId = textChannel.id;
  return message;
}

export async function refreshNowPlayingPanel(guildId, textChannel, serverQueue) {
  if (!serverQueue || serverQueue.notificationMode !== 'panel') return null;
  const channel = textChannel || serverQueue.textChannel;
  if (!channel) return null;
  return publishNowPlaying(guildId, channel, serverQueue, serverQueue.currentSong);
}

export function buildPlayerControls(panelId, serverQueue) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`player:previous:${panelId}`)
        .setLabel('上一首')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`player:pause:${panelId}`)
        .setLabel('暂停/继续')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`player:next:${panelId}`)
        .setLabel('下一首')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`player:stop:${panelId}`)
        .setLabel('停止')
        .setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`player:loop:${panelId}`)
        .setLabel(`循环: ${serverQueue.loop === 'off' ? '关' : serverQueue.loop === 'single' ? '单曲' : '队列'}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`player:radio:${panelId}`)
        .setLabel(serverQueue.radio.enabled ? '关闭Radio' : '开启Radio')
        .setStyle(serverQueue.radio.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`player:queue:${panelId}`)
        .setLabel('队列')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

export function isPanelCurrent(serverQueue, panelId) {
  return songPanelId(serverQueue.currentSong) === panelId;
}
