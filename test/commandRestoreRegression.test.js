import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

// Never load dotenv, log in, invoke yt-dlp, or touch the deployment database.
process.env.PLAYER_BACKEND = 'local';
const { DATABASE_PATH, PlaybackState } = await import('../src/models/database.js');
const { musicQueue, MusicPlayer } = await import('../src/utils/player.js');
const { cancelPendingPlaybackSave } = await import('../src/utils/playbackState.js');
const { YouTube } = await import('../src/utils/youtube.js');
const { execute: play } = await import('../src/commands/play.js');
const { restoreStartupState } = await import('../src/events/ready.js');
const { execute: voiceStateUpdate, restoreWhenHumansReturn } = await import('../src/events/voiceStateUpdate.js');

let sequence = 0;
const song = overrides => ({
  title: 'Regression song', url: 'https://www.youtube.com/watch?v=abcdefghijk',
  duration: '4:00', source: 'manual', queueItemId: 'regression-song', ...overrides,
});

function fixture(t, { humans = true } = {}) {
  const guildId = `command-restore-${++sequence}`;
  const human = { id: 'human', user: { bot: false } };
  const bot = { id: 'bot', user: { bot: true }, voice: { channel: null, channelId: null } };
  const allowed = new Set(['ViewChannel', 'Connect', 'Speak']);
  const members = new Collection(humans ? [[human.id, human]] : []);
  const voice = {
    id: 'saved-voice', members, isVoiceBased: () => true,
    permissionsFor: () => ({ has: permission => allowed.has(permission) }),
  };
  const text = { id: 'text' };
  const guild = {
    id: guildId, members: { me: bot }, voiceAdapterCreator: {},
    channels: {
      cache: new Collection([[voice.id, voice], [text.id, text]]),
      fetch: async id => guild.channels.cache.get(id) || null,
    },
  };
  voice.guild = guild;
  text.guild = guild;
  human.voice = { channel: humans ? voice : null, channelId: humans ? voice.id : null };
  const client = { user: bot.user, guilds: { cache: new Collection([[guildId, guild]]) }, searchSessions: new Map() };
  const replies = [];
  const interaction = {
    id: 'interaction', guildId, guild, member: human, client, user: human, channel: text,
    createdTimestamp: Date.now(), options: { getString: () => song().url },
    deferReply: async () => {}, editReply: async payload => { replies.push(payload); },
    reply: async payload => { replies.push(payload); },
  };
  const oldState = { guild, member: human, channelId: null };
  const newState = { guild, member: human, channelId: voice.id };
  const state = {
    guildId, voiceChannelId: voice.id, textChannelId: text.id,
    currentSong: song(), songs: [], radioQueue: [], history: [], is247: false,
    notificationMode: 'private', seekOffsetSeconds: 37, pausedByEmptyChannel: false,
  };
  t.after(() => {
    const queue = musicQueue.peek(guildId);
    if (queue) {
      MusicPlayer.clearIdleLeaveTimer(queue);
      MusicPlayer.cancelRecoveryTimers(queue);
      MusicPlayer.disarmStallWatchdog(guildId);
      MusicPlayer.cleanupProcesses(queue);
      queue.disposed = true;
    }
    cancelPendingPlaybackSave(guildId);
    musicQueue.delete(guildId);
    PlaybackState.delete(guildId);
    process.env.PLAYER_BACKEND = 'local';
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return { guildId, guild, voice, text, human, bot, allowed, client, interaction, replies, oldState, newState, state };
}

function restoredQueue(f) {
  const queue = musicQueue.get(f.guildId);
  queue.voiceChannelId = f.voice.id;
  queue.guildRef = f.guild;
  queue.voiceChannelRef = f.voice;
  queue.currentSong = song();
  queue.pausedByEmptyChannel = true;
  return queue;
}

function playbackStubs(t, f) {
  const calls = { joins: [], output: [], play: [], destroys: 0 };
  // Network work (join / output wait / play) must run OUTSIDE the guild lock.
  // Holding it there is what wedged every later /play after the first restart,
  // so assert the opposite of the old contract.
  t.mock.method(MusicPlayer, 'joinVoice', async (channel, guildId) => {
    assert.equal(MusicPlayer.inTransition(guildId), false, 'join must not hold the guild transition');
    calls.joins.push(channel.id);
    return {
      type: 'local', joinConfig: { channelId: channel.id }, state: { status: 'ready' },
      destroy() { calls.destroys += 1; },
    };
  });
  t.mock.method(MusicPlayer, 'ensurePlaybackOutput', async (guildId, reason, options) => {
    assert.equal(MusicPlayer.inTransition(guildId), false, 'output restore must not hold the guild transition');
    calls.output.push({ reason, options });
    return true;
  });
  t.mock.method(MusicPlayer, 'playSong', async guildId => {
    assert.equal(MusicPlayer.inTransition(guildId), false, 'queue restore must not hold the guild transition');
    calls.play.push(guildId);
    return true;
  });
  return calls;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('regressions use only a temporary database', () => {
  assert.match(DATABASE_PATH, /discord-music-bot-test-[^/]+\/musicbot\.json$/);
});

for (const outcome of ['empty', 'throw']) {
  test(`YouTube ${outcome} metadata does not create a queue or join voice`, async t => {
    const f = fixture(t);
    const calls = playbackStubs(t, f);
    t.mock.method(YouTube, 'getVideoInfo', async () => {
      if (outcome === 'throw') throw new Error('metadata unavailable');
      return null;
    });
    await play(f.interaction);
    assert.equal(musicQueue.peek(f.guildId), null);
    assert.deepEqual(calls.joins, []);
    assert.equal(PlaybackState.get(f.guildId), null);
    assert.match(f.replies.at(-1), /未找到|播放时出现错误/);
  });

  test(`YouTube ${outcome} metadata preserves an existing manually paused session`, async t => {
    const f = fixture(t);
    const queue = restoredQueue(f);
    const currentSong = song({ playbackPaused: true });
    queue.currentSong = currentSong;
    queue.connection = { destroy() { assert.fail('existing connection must not be destroyed'); } };
    queue.pausedAt = Date.now();
    const connection = queue.connection;
    const calls = playbackStubs(t, f);
    t.mock.method(YouTube, 'getVideoInfo', async () => {
      if (outcome === 'throw') throw new Error('metadata unavailable');
      return null;
    });
    await play(f.interaction);
    assert.equal(musicQueue.peek(f.guildId), queue);
    assert.equal(queue.currentSong, currentSong);
    assert.equal(queue.connection, connection);
    assert.equal(queue.currentSong.playbackPaused, true);
    assert.deepEqual(calls.joins, []);
  });
}

test('failed enqueue cleans its own empty local voice connection even with Lavalink configured', async t => {
  const f = fixture(t);
  process.env.PLAYER_BACKEND = 'lavalink';
  t.mock.method(YouTube, 'getVideoInfo', async () => song());
  let destroys = 0;
  t.mock.method(MusicPlayer, 'joinVoice', async () => {
    musicQueue.peek(f.guildId).connection = {
      type: 'local', joinConfig: { channelId: f.voice.id }, destroy() { destroys += 1; },
    };
    throw new Error('语音连接失败');
  });
  await play(f.interaction);
  assert.equal(destroys, 1);
  assert.equal(musicQueue.peek(f.guildId), null);
  assert.equal(PlaybackState.get(f.guildId), null);
  assert.match(f.replies.at(-1), /语音连接失败/);
});

test('failed enqueue cannot clean up a replacement guild queue', async t => {
  const f = fixture(t);
  t.mock.method(YouTube, 'getVideoInfo', async () => song());
  let replacement;
  t.mock.method(MusicPlayer, 'joinVoice', async () => {
    musicQueue.delete(f.guildId);
    replacement = restoredQueue(f);
    replacement.currentSong.playbackPaused = true;
    throw new Error('voice failed after replacement');
  });
  await play(f.interaction);
  assert.equal(musicQueue.peek(f.guildId), replacement);
  assert.equal(replacement.currentSong.playbackPaused, true);
});

test('startup with an empty non-24/7 channel persists deferred restore; a returning human restores once', async t => {
  const f = fixture(t, { humans: false });
  const calls = playbackStubs(t, f);
  assert.equal(await restoreStartupState(f.client, f.guildId, f.state), false);
  const queue = musicQueue.peek(f.guildId);
  assert.equal(queue.connection, null);
  assert.equal(queue.pausedByEmptyChannel, true);
  assert.equal(PlaybackState.get(f.guildId).pausedByEmptyChannel, true);
  assert.equal(PlaybackState.get(f.guildId).seekOffsetSeconds, 37);
  assert.deepEqual(calls.joins, []);

  f.voice.members.set(f.human.id, f.human);
  f.human.voice = { channel: f.voice, channelId: f.voice.id };
  await Promise.all([voiceStateUpdate(f.oldState, f.newState), voiceStateUpdate(f.oldState, f.newState)]);
  assert.deepEqual(calls.joins, [f.voice.id]);
  assert.equal(calls.output.length, 1);
  assert.equal(calls.output[0].reason, 'human-returned');
  assert.equal(queue.pausedByEmptyChannel, false);
  assert.equal(queue.seekOffsetSeconds, 37);
  assert.ok(queue.connection);
  assert.equal(PlaybackState.get(f.guildId).pausedByEmptyChannel, false);
});

test('deferred startup with queued songs starts the queue rather than output recovery', async t => {
  const f = fixture(t);
  const queue = restoredQueue(f);
  queue.currentSong = null;
  queue.songs = [song()];
  const calls = playbackStubs(t, f);
  await voiceStateUpdate(f.oldState, f.newState);
  assert.deepEqual(calls.joins, [f.voice.id]);
  assert.deepEqual(calls.play, [f.guildId]);
  assert.deepEqual(calls.output, []);
});

for (const pausedBy of ['song', 'timestamp']) {
  test(`human return does not start a manually paused ${pausedBy} session`, async t => {
    const f = fixture(t);
    const queue = restoredQueue(f);
    if (pausedBy === 'song') queue.currentSong.playbackPaused = true;
    else queue.pausedAt = Date.now();
    const calls = playbackStubs(t, f);
    await voiceStateUpdate(f.oldState, f.newState);
    assert.deepEqual(calls.joins, []);
    assert.deepEqual(calls.output, []);
    assert.deepEqual(calls.play, []);
    assert.equal(queue.pausedByEmptyChannel, true);
  });
}

test('human return with an existing paused connection also cannot restart output', async t => {
  const f = fixture(t);
  const queue = restoredQueue(f);
  queue.currentSong.playbackPaused = true;
  queue.playing = true; // Stale playing flag must not override the explicit pause.
  queue.connection = { joinConfig: { channelId: f.voice.id } };
  f.bot.voice = { channel: f.voice, channelId: f.voice.id };
  const calls = playbackStubs(t, f);
  await voiceStateUpdate(f.oldState, f.newState);
  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.play, []);
});

test('startup restore never briefly plays a manually paused persisted song', async t => {
  const f = fixture(t);
  f.state.currentSong.playbackPaused = true;
  const calls = playbackStubs(t, f);
  await restoreStartupState(f.client, f.guildId, f.state);
  assert.deepEqual(calls.joins, []);
  assert.deepEqual(calls.output, []);
  assert.deepEqual(calls.play, []);
  assert.equal(musicQueue.peek(f.guildId).currentSong.playbackPaused, true);
});

test('startup restore with humans joins and restores output without holding the guild lock', async t => {
  const f = fixture(t);
  const calls = playbackStubs(t, f);
  assert.equal(await restoreStartupState(f.client, f.guildId, f.state), true);
  assert.deepEqual(calls.joins, [f.voice.id]);
  assert.equal(calls.output[0].reason, 'startup-restore');
});

for (const denied of ['wrong-channel', 'bot-member', 'mute-only', 'no-humans', 'bot-moved', 'no-view', 'no-connect', 'no-speak', 'bot-timeout', 'deleted-channel']) {
  test(`deferred restore rejects ${denied} without clearing its retry marker`, async t => {
    const f = fixture(t);
    const queue = restoredQueue(f);
    const calls = playbackStubs(t, f);
    if (denied === 'wrong-channel') f.newState.channelId = 'unrelated';
    if (denied === 'bot-member') f.newState.member = { id: 'other-bot', user: { bot: true } };
    if (denied === 'mute-only') f.oldState.channelId = f.newState.channelId;
    if (denied === 'no-humans') f.voice.members.clear();
    if (denied === 'bot-moved') f.bot.voice = { channelId: 'admin-target' };
    if (denied === 'no-view') f.allowed.delete('ViewChannel');
    if (denied === 'no-connect') f.allowed.delete('Connect');
    if (denied === 'no-speak') f.allowed.delete('Speak');
    if (denied === 'bot-timeout') f.bot.communicationDisabledUntilTimestamp = Date.now() + 60_000;
    if (denied === 'deleted-channel') f.guild.channels.cache.delete(f.voice.id);
    await voiceStateUpdate(f.oldState, f.newState);
    assert.deepEqual(calls.joins, []);
    assert.deepEqual(calls.output, []);
    assert.equal(queue.pausedByEmptyChannel, true);
    assert.equal(queue.connection, null);
  });
}

for (const mutation of ['queue-replaced', 'target-changed', 'permissions-revoked', 'human-left']) {
  test(`deferred restore rechecks ${mutation} after asynchronous channel resolution`, async t => {
    const f = fixture(t);
    const queue = restoredQueue(f);
    const calls = playbackStubs(t, f);
    // The channel is cached, so the restore would resolve it without calling
    // fetch(). Drop the cache entry first so the asynchronous-resolution path
    // the test is about actually executes.
    f.guild.channels.cache.delete(f.voice.id);
    t.mock.method(f.guild.channels, 'fetch', async () => {
      if (mutation === 'queue-replaced') { musicQueue.delete(f.guildId); restoredQueue(f); }
      if (mutation === 'target-changed') queue.voiceChannelId = 'another-target';
      if (mutation === 'permissions-revoked') f.allowed.delete('Connect');
      if (mutation === 'human-left') f.voice.members.clear();
      return f.voice;
    });
    await voiceStateUpdate(f.oldState, f.newState);
    assert.deepEqual(calls.joins, []);
    assert.deepEqual(calls.output, []);
    assert.equal(queue.pausedByEmptyChannel, true);
  });
}

for (const mutation of ['queue-replaced', 'human-left', 'bot-moved', 'permissions-revoked', 'manual-pause']) {
  test(`deferred restore discards only its newly joined handle when ${mutation} during join`, async t => {
    const f = fixture(t);
    const queue = restoredQueue(f);
    const calls = playbackStubs(t, f);
    t.mock.method(MusicPlayer, 'joinVoice', async () => {
      if (mutation === 'queue-replaced') { musicQueue.delete(f.guildId); restoredQueue(f); }
      if (mutation === 'human-left') f.voice.members.clear();
      if (mutation === 'bot-moved') f.bot.voice = { channelId: 'admin-target' };
      if (mutation === 'permissions-revoked') f.allowed.delete('Connect');
      if (mutation === 'manual-pause') queue.currentSong.playbackPaused = true;
      const connection = { type: 'local', destroy() { calls.destroys += 1; } };
      queue.connection = connection;
      return connection;
    });
    await voiceStateUpdate(f.oldState, f.newState);
    assert.equal(calls.destroys, 1);
    assert.deepEqual(calls.output, []);
    assert.deepEqual(calls.play, []);
    assert.equal(queue.connection, null);
    assert.equal(queue.pausedByEmptyChannel, true);
  });
}

test('a queued return transition cannot revive a cleared/replaced queue', async t => {
  const f = fixture(t);
  const queue = restoredQueue(f);
  const calls = playbackStubs(t, f);
  const barrier = deferred();
  queue.transitionTail = barrier.promise;
  const restore = restoreWhenHumansReturn(f.oldState, f.newState, queue);
  musicQueue.delete(f.guildId);
  const replacement = restoredQueue(f);
  barrier.resolve();
  assert.equal(await restore, false);
  assert.equal(musicQueue.peek(f.guildId), replacement);
  assert.deepEqual(calls.joins, []);
});

test('startup restore rechecks membership after join and retains deferred state if everybody left', async t => {
  const f = fixture(t);
  const calls = playbackStubs(t, f);
  t.mock.method(MusicPlayer, 'joinVoice', async () => {
    f.voice.members.clear();
    return { type: 'local', destroy() { calls.destroys += 1; } };
  });
  assert.equal(await restoreStartupState(f.client, f.guildId, f.state), false);
  const queue = musicQueue.peek(f.guildId);
  assert.equal(queue.connection, null);
  assert.equal(queue.pausedByEmptyChannel, true);
  assert.equal(PlaybackState.get(f.guildId).pausedByEmptyChannel, true);
  assert.equal(calls.destroys, 1);
  assert.deepEqual(calls.output, []);
});
