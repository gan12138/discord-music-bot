import { Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { savePlaybackState } from '../utils/playbackState.js';

export const name = Events.VoiceStateUpdate;
export const once = false;

export function execute(oldState, newState) {
  const guildId = newState.guild.id;
  const serverQueue = musicQueue.peek(guildId);

  if (!serverQueue) return;

  const botMember = newState.guild.members.me;
  if (!botMember) return;

  const isBotVoiceUpdate = oldState.member?.id === botMember.id;

  // Bot 被踢出语音频道
  if (isBotVoiceUpdate && oldState.channelId && !newState.channelId) {
    if (serverQueue.is247) {
      serverQueue.connection = null;
      serverQueue.player = null;
      serverQueue.playing = false;
      serverQueue.advancing = false;
      serverQueue.audioResource = null;
      serverQueue.seekOffsetSeconds = 0;
      serverQueue.startedAt = null;
      serverQueue.pausedAt = null;
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + 15_000;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      return;
    }

    MusicPlayer.clearQueueAndLeave(guildId, 'bot-disconnected', { notify: false }).catch(error => {
      console.error('[VoiceState] failed to clear queue after bot disconnect:', error.message);
    });
    return;
  }

  // Bot 被手动移动到其他语音频道：管理员操作优先，更新 24/7 目标频道但不强制回原频道。
  if (isBotVoiceUpdate && oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    if (serverQueue.is247) {
      serverQueue.voiceChannelId = newState.channelId;
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + 15_000;
      savePlaybackState(guildId, serverQueue, { immediate: true });
    }
    return;
  }

  if (!serverQueue.connection) return;

  const botChannel = botMember.voice.channel;
  if (!botChannel) return;

  const humanCount = botChannel.members.filter(m => !m.user.bot).size;

  // 语音频道空人时：非 24/7 模式安排空闲离开；24/7 模式标记暂停 radio
  if (humanCount === 0) {
    if (serverQueue.is247) {
      if (!serverQueue.pausedByEmptyChannel) {
        serverQueue.pausedByEmptyChannel = true;
        savePlaybackState(guildId, serverQueue);
      }
    } else {
      MusicPlayer.scheduleIdleLeave(guildId, 'empty-channel');
    }
    return;
  }

  // 有人回来
  if (!serverQueue.is247) MusicPlayer.markActivity(guildId);

  if (serverQueue.pausedByEmptyChannel) {
    serverQueue.pausedByEmptyChannel = false;
    savePlaybackState(guildId, serverQueue);

    // 当前没在播放时，优先恢复待播队列，再回退到历史最后一首歌
    if (!serverQueue.playing && !serverQueue.currentSong && serverQueue.connection) {
      if (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled) {
        MusicPlayer.playSong(guildId, serverQueue.textChannel).catch(error => {
          console.error('[VoiceState] auto-resume from queue failed:', error.message);
        });
      } else {
        const lastSong = serverQueue.history?.at(-1);
        if (lastSong) {
          MusicPlayer.playSong(guildId, serverQueue.textChannel, lastSong, lastSong.source || 'manual').catch(error => {
            console.error('[VoiceState] auto-resume from history failed:', error.message);
          });
        }
      }
    }
  }

  if (serverQueue.currentSong && serverQueue.playing) {
    MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned').catch(error => {
      console.error('[VoiceState] playback output recovery failed:', error.message);
    });
  }
}
