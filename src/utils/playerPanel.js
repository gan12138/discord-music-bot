import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomUUID } from 'crypto';
import { GuildSettings } from '../models/database.js';
import { describeStyle } from './radio.js';
import { voiceLanguageLabel, voiceUnderstandingLabel } from './voiceCommandParser.js';
import { getVoiceControlManager } from './voiceControlRuntime.js';

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

function voiceListenerConnected(guildId) {
  if (!guildId) return false;
  try {
    return getVoiceControlManager()?.diagnostics(guildId)?.guildConnected === true;
  } catch {
    return false;
  }
}

function voiceListenerReady(guildId) {
  if (!guildId) return false;
  try {
    return getVoiceControlManager()?.diagnostics(guildId)?.listenerReady === true;
  } catch {
    return false;
  }
}

export function voiceListenerPanelState(serverQueue) {
  const voice = serverQueue?.guildId
    ? GuildSettings.get(serverQueue.guildId).voiceControl
    : null;
  const connected = voiceListenerConnected(serverQueue?.guildId);
  const ready = voiceListenerReady(serverQueue?.guildId);
  const autoJoin = voice?.enabled === true && voice?.listenerAutoJoin !== false;
  return {
    voice,
    connected,
    ready,
    autoJoin,
  };
}

export function songPanelId(song) {
  const value = song?.url || song?.title || 'unknown';
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function ensurePanelRevision(serverQueue, song = serverQueue?.currentSong) {
  if (!serverQueue) return { revision: 0, token: null };
  const key = song
    ? `${song.queueItemId || song.itemId || song.url || song.title || 'unknown'}:${serverQueue.playbackId || 0}`
    : null;

  if (serverQueue.panelRevisionKey !== key) {
    serverQueue.panelRevision = (Number(serverQueue.panelRevision) || 0) + 1;
    serverQueue.panelRevisionKey = key;
    serverQueue.panelPlaybackToken = song ? randomUUID() : null;
  }

  return {
    revision: Number(serverQueue.panelRevision) || 0,
    token: serverQueue.panelPlaybackToken,
  };
}

export function playerPanelToken(serverQueue, song = serverQueue?.currentSong) {
  const { revision, token } = ensurePanelRevision(serverQueue, song);
  return `${revision}.${token || 'empty'}`;
}

export function buildNowPlayingPayload(serverQueue, song) {
  const panelId = playerPanelToken(serverQueue, song);
  const currentTitle = song?.title || '当前没有正在播放的歌曲';
  const {
    voice,
    connected: listenerConnected,
    ready: listenerReady,
    autoJoin: listenerAutoJoin,
  } = voiceListenerPanelState(serverQueue);
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
        {
          name: '语音控制',
          value: voice?.enabled
            ? `开启｜STT ${voice.sttAccessMode === 'everyone' ? '全员' : '关闭'}｜${voiceLanguageLabel(voice.language)}｜${voiceUnderstandingLabel(voice.understandingMode)}｜监听 Bot ${listenerConnected ? '已连接' : !listenerReady ? '未上线' : listenerAutoJoin ? '待连接' : '已离开'}`
            : `关闭｜监听 Bot ${listenerConnected ? '已连接' : !listenerReady ? '未上线' : listenerAutoJoin ? '待连接' : '已离开'}`,
          inline: true,
        },
        {
          name: '唤醒词',
          value: voice?.wakeWords?.map(word => `\`${word}\``).join('、') || '无',
          inline: false,
        },
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

  const lifecycleGeneration = serverQueue.lifecycleGeneration;
  const panelToken = playerPanelToken(serverQueue, song);
  const publishSequence = (Number(serverQueue.panelPublishSequence) || 0) + 1;
  serverQueue.panelPublishSequence = publishSequence;
  const publish = async () => {
    const isLatest = () => serverQueue.lifecycleGeneration === lifecycleGeneration
      && serverQueue.panelPublishSequence === publishSequence
      && playerPanelToken(serverQueue, serverQueue.currentSong) === panelToken;

    if (!isLatest()) return null;
    const payload = buildNowPlayingPayload(serverQueue, song);
    let message = null;
    let messageCreatedByPublish = false;

    if (mode === 'on') {
      message = await textChannel.send(payload).catch(error => {
        console.warn('[PlayerPanel] failed to send now-playing message:', error.message);
        return null;
      });
      messageCreatedByPublish = Boolean(message);
    } else if (serverQueue.nowPlayingMessageId && serverQueue.nowPlayingChannelId) {
      try {
        const channel = serverQueue.nowPlayingChannelId === textChannel.id
          ? textChannel
          : await textChannel.client.channels.fetch(serverQueue.nowPlayingChannelId);
        message = await channel.messages.fetch(serverQueue.nowPlayingMessageId);
        await message.edit(payload);
      } catch {
        serverQueue.nowPlayingMessageId = null;
        serverQueue.nowPlayingChannelId = null;
      }
    }

    if (!message && mode === 'panel') {
      message = await textChannel.send(payload).catch(error => {
        console.warn('[PlayerPanel] failed to send now-playing panel:', error.message);
        return null;
      });
      messageCreatedByPublish = Boolean(message);
    }

    if (!message) return null;
    if (!isLatest()) {
      // Never delete the persistent panel another refresh just edited. Only
      // remove a message created by this stale publish attempt.
      if (messageCreatedByPublish) await Promise.resolve(message.delete?.()).catch(() => {});
      return null;
    }
    if (mode === 'panel') {
      serverQueue.nowPlayingMessageId = message.id;
      serverQueue.nowPlayingChannelId = textChannel.id;
    }
    return message;
  };

  const previous = serverQueue.panelPublishTail || Promise.resolve();
  const current = previous.catch(() => {}).then(publish);
  serverQueue.panelPublishTail = current.catch(() => {});
  return current;
}

export async function refreshNowPlayingPanel(guildId, textChannel, serverQueue) {
  if (!serverQueue || serverQueue.notificationMode !== 'panel') return null;
  const channel = textChannel || serverQueue.textChannel;
  if (!channel) return null;
  return publishNowPlaying(guildId, channel, serverQueue, serverQueue.currentSong);
}

export function buildPlayerControls(panelId, serverQueue) {
  const {
    voice,
    connected: listenerConnected,
    ready: listenerReady,
  } = voiceListenerPanelState(serverQueue);
  const listenerLabel = !listenerReady
    ? '语音Bot未上线'
    : !voice?.enabled
      ? '先开启语音控制'
      : listenerConnected
        ? '语音Bot离开'
        : '语音Bot加入';
  const listenerButtonStyle = listenerConnected
    ? ButtonStyle.Danger
    : voice?.enabled && listenerReady
      ? ButtonStyle.Success
      : ButtonStyle.Secondary;
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
        .setCustomId(`player:voice:${panelId}`)
        .setLabel(listenerLabel)
        .setStyle(listenerButtonStyle),
      new ButtonBuilder()
        .setCustomId(`player:queue:${panelId}`)
        .setLabel('队列')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

export function isPanelCurrent(serverQueue, panelId) {
  return Boolean(panelId) && playerPanelToken(serverQueue, serverQueue.currentSong) === panelId;
}
