import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayerStatus } from '@discordjs/voice';
import { PlaybackState } from '../src/models/database.js';
import { musicQueue, MusicPlayer } from '../src/utils/player.js';
import {
  getPlaybackProgressSeconds,
  getPlaybackResumeSeconds,
} from '../src/utils/playbackState.js';

test('playback progress is capped and expired recovery does not seek past the song', () => {
  const queue = {
    currentSong: { duration: '5:19' },
    seekOffsetSeconds: 10_738,
    startedAt: null,
    pausedAt: null,
  };
  assert.equal(getPlaybackProgressSeconds(queue), 319);
  assert.equal(getPlaybackResumeSeconds(queue), null);
});

test('a backend start attempt is not treated as confirmed playback', () => {
  const guildId = `test-starting-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  serverQueue.startingBackend = 'lavalink';
  serverQueue.lavalinkStarting = true;
  try {
    assert.equal(MusicPlayer.isPlaybackActuallyActive(serverQueue), false);
  } finally {
    musicQueue.delete(guildId);
  }
});

test('stuck local child cleanup escalates from SIGTERM to SIGKILL', async () => {
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal = 'SIGTERM') {
      signals.push(signal);
      return true;
    },
  };

  MusicPlayer.terminateChildProcess(child);
  assert.deepEqual(signals, ['SIGTERM']);
  await new Promise(resolve => setTimeout(resolve, 2_100));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Lavalink cleanup claims the current playback and advances once', async () => {
  const guildId = `test-cleanup-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = { title: 'Current', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' };
  serverQueue.playbackId = 7;
  serverQueue.playing = true;
  serverQueue.activeBackend = 'lavalink';
  const originalAdvance = MusicPlayer.advance;
  let advances = 0;
  MusicPlayer.advance = async () => { advances += 1; };

  try {
    const track = { userData: { musicBotPlaybackId: 7 } };
    MusicPlayer.handleLavalinkQueueEnd(guildId, null, track, { reason: 'cleanup' });
    MusicPlayer.handleLavalinkTrackEnd(guildId, null, track, { reason: 'cleanup' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(advances, 1);
    assert.equal(serverQueue.playing, false);
    assert.equal(serverQueue.terminalHandledPlaybackId, 7);
  } finally {
    MusicPlayer.advance = originalAdvance;
    musicQueue.delete(guildId);
  }
});

test('Lavalink finished waits briefly for a late track error', async () => {
  const guildId = `test-finished-error-race-${Date.now()}`;
  const song = {
    title: 'Fallback song',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    source: 'manual',
  };
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = song;
  serverQueue.playbackId = 8;
  serverQueue.playing = true;
  serverQueue.activeBackend = 'lavalink';
  const track = { userData: { musicBotPlaybackId: 8 } };
  const originalAdvance = MusicPlayer.advance;
  const originalFallback = MusicPlayer.fallbackLavalinkToLocal;
  let advances = 0;
  let fallbacks = 0;
  MusicPlayer.advance = async () => { advances += 1; };
  MusicPlayer.fallbackLavalinkToLocal = async () => {
    fallbacks += 1;
    return true;
  };

  try {
    MusicPlayer.handleLavalinkQueueEnd(guildId, null, track, { reason: 'finished' });
    assert.equal(advances, 0);
    assert.equal(serverQueue.lavalinkPendingFinish?.playbackId, 8);

    MusicPlayer.handleLavalinkTrackError(guildId, null, track, {
      exception: { message: 'All clients failed to load the item' },
    });
    await serverQueue.transitionTail;

    assert.equal(fallbacks, 1);
    assert.equal(advances, 0);
    assert.equal(serverQueue.lavalinkPendingFinish, null);
  } finally {
    MusicPlayer.clearLavalinkFinishTimer(serverQueue);
    MusicPlayer.advance = originalAdvance;
    MusicPlayer.fallbackLavalinkToLocal = originalFallback;
    musicQueue.delete(guildId);
  }
});

test('backend connection switches preserve the playback id assigned by the caller', async () => {
  const guildId = `test-backend-switch-id-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  const voiceChannel = { id: 'voice-1', isVoiceBased: () => true };
  const guild = {
    voiceAdapterCreator: {},
    channels: {
      cache: new Map([[voiceChannel.id, voiceChannel]]),
      fetch: async () => voiceChannel,
    },
  };
  serverQueue.guildRef = guild;
  serverQueue.voiceChannelId = voiceChannel.id;
  serverQueue.connection = { type: 'lavalink', joinConfig: { channelId: voiceChannel.id } };
  serverQueue.playbackId = 12;
  const originalJoinVoice = MusicPlayer.joinVoice;
  MusicPlayer.joinVoice = async () => ({ type: 'local', state: { status: 'ready' } });

  try {
    await MusicPlayer.ensureLocalVoiceConnection(guildId, serverQueue);
    assert.equal(serverQueue.playbackId, 12);

    serverQueue.connection = {
      type: 'local',
      destroy() {},
    };
    serverQueue.player = { stop() {} };
    serverQueue.playbackId = 13;
    await MusicPlayer.ensureLavalinkVoiceConnection(guildId, serverQueue);
    assert.equal(serverQueue.playbackId, 13);
  } finally {
    MusicPlayer.joinVoice = originalJoinVoice;
    musicQueue.delete(guildId);
  }
});

test('24/7 empty channel finishes the current song without consuming the queue', async () => {
  const guildId = `test-empty-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  const currentSong = { title: 'Current', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', source: 'manual' };
  const nextSong = { title: 'Next', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', source: 'manual' };
  serverQueue.currentSong = currentSong;
  serverQueue.songs = [nextSong];
  serverQueue.is247 = true;
  serverQueue.pausedByEmptyChannel = true;
  serverQueue.queueEnded = false;
  const originalPlaybackStateSet = PlaybackState.set;
  PlaybackState.set = () => {};

  try {
    await MusicPlayer.advance(guildId, serverQueue);
    assert.equal(serverQueue.currentSong, null);
    assert.deepEqual(serverQueue.songs, [nextSong]);
    assert.deepEqual(serverQueue.history, [currentSong]);
    assert.equal(serverQueue.queueEnded, true);
  } finally {
    MusicPlayer.disarmStallWatchdog(guildId);
    PlaybackState.set = originalPlaybackStateSet;
    musicQueue.delete(guildId);
  }
});

test('Lavalink disconnect marks an idle 24/7 connection for backend recovery', () => {
  const guildId = `test-idle-lavalink-disconnect-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  serverQueue.is247 = true;
  serverQueue.connection = { type: 'lavalink', joinConfig: { channelId: 'voice-1' } };
  serverQueue.lavalinkPlayer = { connected: true };
  serverQueue.voiceChannelId = 'voice-1';

  try {
    MusicPlayer.handleLavalinkNodeDisconnect();

    assert.equal(serverQueue.connection, null);
    assert.equal(serverQueue.lavalinkPlayer, null);
    assert.equal(serverQueue.backendUnavailable, true);
    assert.equal(serverQueue.playbackBlocked, true);
    assert.equal(serverQueue.lavalinkInterrupted, true);
    assert.ok(serverQueue.recoveryTimer);
  } finally {
    MusicPlayer.cancelRecoveryTimers(serverQueue);
    musicQueue.delete(guildId);
  }
});

test('idle 24/7 backend recovery rejoins voice without starting an empty queue', async () => {
  const guildId = `test-idle-lavalink-recovery-${Date.now()}`;
  const serverQueue = musicQueue.get(guildId);
  serverQueue.is247 = true;
  serverQueue.pausedByEmptyChannel = true;
  serverQueue.backendUnavailable = true;
  serverQueue.voiceChannelRef = { id: 'voice-1' };
  serverQueue.guildRef = { voiceAdapterCreator: {} };
  const connection = { type: 'lavalink', joinConfig: { channelId: 'voice-1' } };
  const originalJoinVoice = MusicPlayer.joinVoice;
  const originalPlaySong = MusicPlayer.playSong;
  let playCalls = 0;
  MusicPlayer.joinVoice = async () => connection;
  MusicPlayer.playSong = async () => {
    playCalls += 1;
    return true;
  };

  try {
    const restored = await MusicPlayer.recoverBackendUnavailable(guildId, serverQueue);

    assert.equal(restored, true);
    assert.equal(serverQueue.connection, connection);
    assert.equal(playCalls, 0);
  } finally {
    MusicPlayer.joinVoice = originalJoinVoice;
    MusicPlayer.playSong = originalPlaySong;
    musicQueue.delete(guildId);
  }
});

test('Lavalink backend outages do not enter Discord voice recovery', async () => {
  const guildId = `test-backend-recovery-routing-${Date.now()}`;
  const previousBackend = process.env.PLAYER_BACKEND;
  process.env.PLAYER_BACKEND = 'lavalink';
  const serverQueue = musicQueue.get(guildId);
  serverQueue.is247 = true;
  serverQueue.backendUnavailable = true;
  const originalSchedule = MusicPlayer.scheduleLavalinkRecovery;
  let schedules = 0;
  MusicPlayer.scheduleLavalinkRecovery = () => {
    schedules += 1;
    return true;
  };

  try {
    const result = await MusicPlayer.recoverVoiceConnection(guildId, 'test');

    assert.equal(result, false);
    assert.equal(schedules, 1);
    assert.equal(serverQueue.voiceReconnectAttempts, 0);
  } finally {
    MusicPlayer.scheduleLavalinkRecovery = originalSchedule;
    if (previousBackend === undefined) delete process.env.PLAYER_BACKEND;
    else process.env.PLAYER_BACKEND = previousBackend;
    musicQueue.delete(guildId);
  }
});

test('24/7 voice recovery warning is sent once per continuous outage', async () => {
  const guildId = `test-recovery-notice-${Date.now()}`;
  const previousBackend = process.env.PLAYER_BACKEND;
  process.env.PLAYER_BACKEND = 'local';
  const sent = [];
  const voiceChannel = { id: 'voice-1', isVoiceBased: () => true };
  const guild = {
    voiceAdapterCreator: {},
    channels: {
      cache: new Map([['voice-1', voiceChannel]]),
      fetch: async () => voiceChannel,
    },
  };
  const serverQueue = musicQueue.get(guildId);
  serverQueue.is247 = true;
  serverQueue.voiceChannelId = voiceChannel.id;
  serverQueue.voiceChannelRef = voiceChannel;
  serverQueue.guildRef = guild;
  serverQueue.textChannel = { send: async payload => sent.push(payload) };

  try {
    serverQueue.voiceReconnectAttempts = 3;
    await MusicPlayer.recoverVoiceConnection(guildId, 'test-first');
    serverQueue.voiceReconnectAttempts = 3;
    await MusicPlayer.recoverVoiceConnection(guildId, 'test-second');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(sent.length, 1);
    assert.equal(serverQueue.voiceRecoveryNotified, true);
  } finally {
    MusicPlayer.cancelRecoveryTimers(serverQueue);
    if (previousBackend === undefined) delete process.env.PLAYER_BACKEND;
    else process.env.PLAYER_BACKEND = previousBackend;
    musicQueue.delete(guildId);
  }
});

test('a guild with Lavalink voice fallback routes playback locally', () => {
  const guildId = `test-lavalink-voice-local-${Date.now()}`;
  const previousBackend = process.env.PLAYER_BACKEND;
  process.env.PLAYER_BACKEND = 'lavalink';
  const serverQueue = musicQueue.get(guildId);
  serverQueue.lavalinkVoiceFallback = true;

  try {
    assert.equal(MusicPlayer.shouldUseLavalink({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }), true);
    const forceLocal = Boolean(serverQueue.lavalinkVoiceFallback);
    assert.equal(forceLocal, true);
  } finally {
    if (previousBackend === undefined) delete process.env.PLAYER_BACKEND;
    else process.env.PLAYER_BACKEND = previousBackend;
    musicQueue.delete(guildId);
  }
});

test('YouTube Lavalink track errors fall back to local yt-dlp once', async () => {
  const guildId = `test-youtube-lavalink-fallback-${Date.now()}`;
  const song = {
    title: 'Fallback song',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    source: 'manual',
    queueItemId: 'fallback-song',
  };
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = song;
  serverQueue.playbackId = 9;
  serverQueue.playing = true;
  serverQueue.activeBackend = 'lavalink';
  const originalPlaySong = MusicPlayer.playSong;
  const calls = [];
  MusicPlayer.playSong = async (...args) => {
    calls.push(args);
    return true;
  };

  try {
    assert.equal(MusicPlayer.shouldFallbackLavalinkToLocal(song, false), true);
    assert.equal(MusicPlayer.shouldFallbackLavalinkToLocal(song, true), false);
    const result = await MusicPlayer.handleLavalinkFailure(
      guildId,
      9,
      'All clients failed: Sign in to confirm you are not a bot; Must find sig function from script',
      'track-error',
    );

    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], song);
    assert.equal(calls[0][4].forceLocal, true);
    assert.equal(calls[0][4].forceYtdlpPipe, true);
    assert.equal(calls[0][4].localFallbackTried, true);
    assert.equal(serverQueue.localFallbackTried, true);
    assert.equal(serverQueue.playbackError, false);
  } finally {
    MusicPlayer.playSong = originalPlaySong;
    musicQueue.delete(guildId);
  }
});

test('Discord playback notices are truncated to the content limit', async () => {
  const guildId = `test-discord-content-limit-${Date.now()}`;
  const sent = [];
  const serverQueue = musicQueue.get(guildId);
  serverQueue.textChannel = { send: async payload => sent.push(payload) };

  try {
    MusicPlayer.stopRadioAfterFailures(guildId, serverQueue, 'x'.repeat(4_000));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.length, 2_000);
    assert.match(sent[0].content, /\.\.\.$/);
  } finally {
    musicQueue.delete(guildId);
  }
});

function stallWatchdogQueue(guildId, diagnostics) {
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = { title: 'Song', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', duration: '3:55' };
  serverQueue.playbackId = 3;
  serverQueue.playing = true;
  serverQueue.activeBackend = 'local';
  serverQueue.player = { state: { status: AudioPlayerStatus.Playing }, stop() {} };
  serverQueue.streamDiagnostics = {
    playbackId: 3,
    bytesStreamed: 3_701_286,
    lastBytesAt: Date.now() - 600_000,
    sourceEnded: false,
    audioStream: null,
    ...diagnostics,
  };
  return serverQueue;
}

test('stream-stall watchdog ignores a fully transcoded source that ffmpeg already finished', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const guildId = `test-stall-source-ended-${Date.now()}`;
  const serverQueue = stallWatchdogQueue(guildId, { sourceEnded: true });

  try {
    MusicPlayer.armStreamStallWatchdog(guildId, serverQueue, 3);
    t.mock.timers.tick(5_000);

    assert.equal(serverQueue.playbackError, false);
    assert.equal(serverQueue.lastPlaybackError, null);
    assert.equal(serverQueue.streamStallTimer, null);
  } finally {
    MusicPlayer.clearStreamStallWatchdog(serverQueue);
    musicQueue.delete(guildId);
  }
});

test('stream-stall watchdog ignores a drained producer while the buffer still holds audio', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const guildId = `test-stall-buffered-${Date.now()}`;
  const serverQueue = stallWatchdogQueue(guildId, { audioStream: { readableLength: 1_048_576 } });

  try {
    MusicPlayer.armStreamStallWatchdog(guildId, serverQueue, 3);
    t.mock.timers.tick(5_000);

    assert.equal(serverQueue.playbackError, false);
    assert.equal(serverQueue.lastPlaybackError, null);
    assert.ok(serverQueue.streamStallTimer);
    assert.ok(Date.now() - serverQueue.streamDiagnostics.lastBytesAt < 5_000);
  } finally {
    MusicPlayer.clearStreamStallWatchdog(serverQueue);
    musicQueue.delete(guildId);
  }
});

test('stream-stall watchdog still fires when the source is alive and the buffer is drained', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const guildId = `test-stall-real-${Date.now()}`;
  const serverQueue = stallWatchdogQueue(guildId, { audioStream: { readableLength: 0 } });
  const originalAdvance = MusicPlayer.advance;
  let advances = 0;
  MusicPlayer.advance = async () => { advances += 1; };

  try {
    MusicPlayer.armStreamStallWatchdog(guildId, serverQueue, 3);
    t.mock.timers.tick(5_000);

    assert.equal(serverQueue.playbackError, true);
    assert.equal(serverQueue.lastPlaybackError?.source, 'stream-stall');
    assert.equal(advances, 1);
    assert.equal(serverQueue.streamStallTimer, null);
  } finally {
    MusicPlayer.advance = originalAdvance;
    MusicPlayer.clearStreamStallWatchdog(serverQueue);
    musicQueue.delete(guildId);
  }
});

test('a playback-error skip clears the failed reserved song so it is not replayed', async () => {
  const guildId = `test-skip-cleanup-${Date.now()}`;
  const song = {
    title: 'Crashed',
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    source: 'manual',
    queueItemId: 'crashed-song',
  };
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = song;
  serverQueue.songs = [song];
  serverQueue.reservedNext = { itemId: song.queueItemId, song, source: 'manual' };
  serverQueue.playbackError = true;
  serverQueue.playbackRetryCount = 2;
  serverQueue.lastPlaybackError = {
    source: 'ffmpeg',
    message: '[ffmpeg] exited with code null, signal SIGSEGV',
    songTitle: song.title,
    songUrl: song.url,
    playbackId: 1,
    progressSeconds: 0,
    occurredAt: Date.now(),
  };
  const originalPlaySong = MusicPlayer.playSong;
  const originalPlaybackStateSet = PlaybackState.set;
  MusicPlayer.playSong = async () => ({ ok: true });
  PlaybackState.set = () => {};

  try {
    await MusicPlayer.advance(guildId, serverQueue);
    assert.deepEqual(serverQueue.songs, []);
    assert.equal(serverQueue.reservedNext, null);
    assert.equal(serverQueue.playbackError, false);
  } finally {
    MusicPlayer.playSong = originalPlaySong;
    PlaybackState.set = originalPlaybackStateSet;
    MusicPlayer.disarmStallWatchdog(guildId);
    musicQueue.delete(guildId);
  }
});

test('a communication timeout blocks voice join without starting a connection', async () => {
  const guildId = `test-voice-timeout-${Date.now()}`;
  const retryAt = Date.now() + 60_000;
  const voiceChannel = {
    id: 'voice-1',
    name: 'voice',
    guild: {
      members: {
        me: { communicationDisabledUntilTimestamp: retryAt },
      },
    },
  };

  try {
    await assert.rejects(
      MusicPlayer.joinVoice(voiceChannel, guildId, {}),
      error => error.code === 'VOICE_JOIN_BLOCKED' && error.retryAt === retryAt,
    );
  } finally {
    musicQueue.delete(guildId);
  }
});
