import { Events } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { freezePlaybackProgress, savePlaybackState } from '../utils/playbackState.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';

export const name = Events.VoiceStateUpdate;
export const once = false;
const BOT_DISCONNECT_RECOVERY_DELAY_MS = 3_000;

export function execute(oldState, newState) {
  const guildId = newState.guild.id;
  const serverQueue = musicQueue.peek(guildId);

  if (!serverQueue) return;

  const botMember = newState.guild.members.me;
  if (!botMember) return;

  const isBotVoiceUpdate = oldState.member?.id === botMember.id;

  // Bot 被踢出语音频道
  if (isBotVoiceUpdate && oldState.channelId && !newState.channelId) {
    if (serverQueue.backendTransitioning || Date.now() < (serverQueue.suppressVoiceRecoveryUntil || 0)) return;
    if (serverQueue.is247) {
      const backend = MusicPlayer.activeBackend(serverQueue);
      if (serverQueue.currentSong) freezePlaybackProgress(serverQueue);
      serverQueue.connection = null;
      serverQueue.player = null;
      serverQueue.playing = false;
      serverQueue.advancing = false;
      serverQueue.audioResource = null;
      serverQueue.activeBackend = backend;
      if (backend === 'lavalink') {
        serverQueue.backendUnavailable = true;
        serverQueue.playbackBlocked = true;
        serverQueue.lavalinkInterrupted = true;
      }
      serverQueue.pendingRecovery = {
        guildId,
        playbackId: serverQueue.playbackId,
        songId: serverQueue.currentSong?.queueItemId || null,
        reason: 'Bot 离开语音频道',
        at: Date.now(),
      };
      serverQueue.suppressVoiceRecoveryUntil = Date.now() + BOT_DISCONNECT_RECOVERY_DELAY_MS;
      savePlaybackState(guildId, serverQueue, { immediate: true });
      setTimeout(() => {
        const queue = musicQueue.peek(guildId);
        if (queue !== serverQueue || !queue.is247 || queue.connection) return;
        MusicPlayer.recoverVoiceConnection(guildId, 'bot-disconnected').catch(error => {
          console.error('[VoiceState] 24/7 reconnect failed:', MusicPlayer.safeErrorMessage(error));
        });
      }, BOT_DISCONNECT_RECOVERY_DELAY_MS).unref?.();
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

  // Backend switches suppress only the Bot's own synthetic voice events. Human
  // joins/leaves must still update idle/24/7 state during a backend switch.
  if (isBotVoiceUpdate) return;

  if (!serverQueue.connection) return;

  const botChannel = botMember.voice.channel;
  if (!botChannel) return;

  const humanCount = botChannel.members.filter(m => !m.user.bot).size;

  // 24/7 空频道让当前歌曲播完，但阻止后续队列和 Radio 推进。
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

    if (!MusicPlayer.isPlaybackActuallyActive(serverQueue) && serverQueue.connection) {
      if (serverQueue.currentSong) {
        MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned', { force: true })
          .then(() => refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue))
          .catch(error => {
            console.error('[VoiceState] current song recovery failed:', error.message);
          });
      } else if (serverQueue.songs.length > 0 || serverQueue.radioQueue.length > 0 || serverQueue.radio?.enabled) {
        MusicPlayer.playSong(guildId, serverQueue.textChannel).catch(error => {
          console.error('[VoiceState] auto-resume from queue failed:', error.message);
        });
      }
    }
  }

  if (serverQueue.currentSong && serverQueue.playing) {
    MusicPlayer.ensurePlaybackOutput(guildId, 'human-returned')
      .then(() => refreshNowPlayingPanel(guildId, serverQueue.textChannel, serverQueue))
      .catch(error => {
        console.error('[VoiceState] playback output recovery failed:', error.message);
      });
  }
}
