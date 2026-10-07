import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyPlaybackError, playbackErrorText, withPlaybackSignal } from '../src/utils/playbackErrors.js';
import { PlaybackAvailability, playbackAvailability } from '../src/utils/playbackAvailability.js';
import { Semaphore } from '../src/utils/shared.js';
import { isRadioAlternative, findRadioAlternatives } from '../src/utils/radio.js';
import { YouTube } from '../src/utils/youtube.js';
import { MusicPlayer, musicQueue } from '../src/utils/player.js';

const url = id => `https://www.youtube.com/watch?v=${id}`;
const timeoutMessage = `All clients failed to load the item.
Client [TVHTML5] failed: java.net.SocketTimeoutException: Read timed out
Client [ANDROID_VR] failed: This video is not available
Client [TVHTML5_SIMPLY] failed: Sign in to confirm you’re not a bot
Client [MWEB] failed: Not success status code: 403`;
const unreachableMessage = `(yts.version: f45bbb7aebfcbc1c553769e04af6cd43afa8b7c3) All clients failed to load the item.
Client [TVHTML5] failed: java.net.SocketException: Network is unreachable
    at com.sedmelluq.discord.lavaplayer.container.mpeg.MpegFileLoader.parseHeaders(MpegFileLoader.java:70)
Client [ANDROID_VR] failed: This video requires login.
Client [TVHTML5_SIMPLY] failed: Sign in to confirm you’re not a bot
Client [WEB_EMBEDDED_PLAYER] failed: This video is unavailable
Client [WEB] failed: No supported audio streams available, available types:
Client [MWEB] failed: Not success status code: 403`;

function queueFor(t, song = {}) {
  const id = `policy-${t.name}`;
  const queue = musicQueue.get(id);
  queue.currentSong = { title: 'Example Artist Song', url: url('abcdefghijk'), duration: '4:00', source: 'manual', queueItemId: id, ...song };
  queue.playbackId = 10;
  queue.is247 = true;
  queue.streamDiagnostics = { playbackId: 10 };
  t.after(() => {
    MusicPlayer.cancelRecoveryTimers(queue);
    MusicPlayer.disarmStallWatchdog(id);
    musicQueue.delete(id);
    playbackAvailability.entries.clear();
  });
  return queue;
}

test('TV timeout takes precedence over secondary 403 and login failures', () => {
  const policy = classifyPlaybackError(timeoutMessage, 'lavalink');
  assert.equal(policy.category, 'network-timeout');
  assert.equal(policy.transient, true);
  assert.equal(policy.clients.length, 4);
  assert.equal(classifyPlaybackError(timeoutMessage.replace('java.net.SocketTimeoutException: Read timed out', 'This video requires login.')).transient, false);
  assert.match(playbackErrorText(timeoutMessage), /读取超时/);
});

test('the Nyan Cat aggregate error preserves the TV network failure and accurate notice', () => {
  const policy = classifyPlaybackError(unreachableMessage, 'lavalink');
  assert.equal(policy.category, 'network-unreachable');
  assert.equal(policy.primaryClient, 'TVHTML5');
  assert.equal(policy.transient, true);
  assert.equal(policy.localRetries, 2);
  assert.equal(policy.clients.length, 6);
  assert.match(playbackErrorText(unreachableMessage), /音源网络不可达/);
  const reordered = `Client [MWEB] failed: Not success status code: 403\n${unreachableMessage}`;
  assert.equal(classifyPlaybackError(reordered).category, 'network-unreachable');
  const login = unreachableMessage.replace('java.net.SocketException: Network is unreachable', 'This video requires login.');
  const restricted = unreachableMessage.replace('java.net.SocketException: Network is unreachable', 'Video is private');
  assert.equal(classifyPlaybackError(login).transient, false);
  assert.equal(classifyPlaybackError(restricted).transient, false);
});

test('unreachable routes are recognized from Java text and system error codes', () => {
  for (const message of ['Network is unreachable', 'No route to host', 'java.net.NoRouteToHostException', 'connect ENETUNREACH', 'connect EHOSTUNREACH']) {
    assert.equal(classifyPlaybackError(message).category, 'network-unreachable');
  }
  assert.equal(classifyPlaybackError({ code: 'ENETUNREACH', message: 'connect failed' }).category, 'network-unreachable');
  assert.equal(classifyPlaybackError('This video is unavailable').category, 'content-unavailable');
});

test('unavailable is ambiguous and preceding yt-dlp warnings cannot mask its error', () => {
  const policy = classifyPlaybackError('WARNING: challenge timeout\nERROR: [youtube] abcdefghijk: This video is not available', 'yt-dlp');
  assert.equal(policy.category, 'content-unavailable');
  assert.equal(policy.localRetries, 1);
  assert.doesNotMatch(playbackErrorText(policy), /删除|私有/);
  assert.equal(classifyPlaybackError('Video is private').localRetries, 0);
  assert.equal(classifyPlaybackError('Requested format is not available').category, 'no-supported-stream');
  assert.equal(classifyPlaybackError('bytes read but more expected').localRetries, 2);
});

test('availability cools only exhausted videos and recovers after success or TTL', () => {
  let now = 100;
  const cache = new PlaybackAvailability({ now: () => now, capacity: 2 });
  const song = { url: url('abcdefghijk') };
  cache.failure(song, 'lavalink', 'network-timeout');
  assert.equal(cache.isCoolingDown(song), false);
  cache.failure(song, 'local', 'content-unavailable', { exhausted: true });
  assert.equal(cache.isCoolingDown(`https://youtu.be/abcdefghijk`), true);
  assert.equal(cache.isCoolingDown(url('bcdefghijkl')), false);
  now += 10 * 60_000;
  assert.equal(cache.isCoolingDown(song), false);
  cache.failure(song, 'local', 'content-unavailable', { exhausted: true });
  assert.equal(cache.isCoolingDown(song), true);
  cache.success(song, 'local');
  assert.equal(cache.isCoolingDown(song), false);
  assert.ok(cache.entries.values().next().value.paths.lavalink);
  for (const category of ['backend-unavailable', 'environment', 'process-crash', 'recovery-deadline']) {
    cache.failure(song, 'local', category, { exhausted: true });
    assert.equal(cache.isCoolingDown(song), false);
  }
  for (const id of ['bcdefghijkl', 'cdefghijklm', 'defghijklmn']) cache.failure(url(id), 'local', 'content-unavailable', { exhausted: true });
  assert.equal(cache.entries.size, 2);
});

test('aborting a queued metadata permit does not leak semaphore capacity', async () => {
  const semaphore = new Semaphore(1);
  await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(semaphore.queue.length, 0);
  semaphore.release();
  await semaphore.acquire();
  assert.equal(semaphore.current, 1);
  semaphore.release();
});

test('same-song matching rejects cover, live, wrong artist, duration and cooled links', t => {
  const original = { title: '一辈子的孤单 刘若英', duration: '4:53', url: url('rhNRCvyii0Q') };
  const candidate = { title: '刘若英 一辈子的孤单 Official Audio', duration: '4:52', url: url('bcdefghijkl') };
  assert.equal(isRadioAlternative(original, candidate, 'normal'), true);
  for (const changes of [{ title: `${candidate.title} cover` }, { title: `${candidate.title} LIVE` }, { title: '一辈子的孤单 周杰伦' }, { duration: '1:00' }]) {
    assert.equal(isRadioAlternative(original, { ...candidate, ...changes }, 'normal'), false);
  }
  assert.equal(isRadioAlternative({ ...original, title: '單車', author: 'unrelated uploader' }, { ...candidate, title: '單車', duration: '4:53' }), false);
  playbackAvailability.failure(candidate, 'local', 'content-unavailable', { exhausted: true });
  assert.equal(isRadioAlternative(original, candidate), false);
  t.after(() => playbackAvailability.entries.clear());
});

test('TV retries once without consuming queue; late old terminal events do not advance', async t => {
  const queue = queueFor(t);
  const next = { title: 'Next', url: url('bcdefghijkl') };
  queue.songs = [next];
  const played = [];
  const fallbacks = [];
  t.mock.method(MusicPlayer, 'playSongLavalink', async (_guild, _channel, song, _source, options) => {
    played.push(options);
    queue.playbackId += 1;
    queue.terminalHandledPlaybackId = null;
    queue.currentSong = song;
    MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, song, options);
    MusicPlayer.handleLavalinkTrackStart(queue.guildId, null, { userData: { musicBotPlaybackId: queue.playbackId } });
  });
  t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async (...args) => { fallbacks.push(args); return true; });
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, timeoutMessage);
  assert.equal(queue.playbackRecovery.lavalinkRetries, 1);
  assert.ok(queue.pendingPlaybackRecovery);
  MusicPlayer.handleLavalinkTrackEnd(queue.guildId, null, { userData: { musicBotPlaybackId: 10 } }, { reason: 'finished' });
  await delay(1250);
  await queue.transitionTail;
  assert.equal(played.length, 1);
  assert.deepEqual(queue.songs, [next]);
  assert.equal(queue.playbackRecovery.lavalinkRetries, 1);
  assert.ok(queue.playbackDeadlineTimer, 'trackStart alone must not disable output deadline');
  await MusicPlayer.handleLavalinkFailure(queue.guildId, queue.playbackId, timeoutMessage);
  assert.equal(fallbacks.length, 1);
  assert.equal(played.length, 1);
});

test('unreachable TV retries once with a bounded start budget, then falls back once', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const song = queue.currentSong;
  const next = { title: 'Next', url: url('bcdefghijkl') };
  queue.songs = [next];
  const played = [];
  const fallbacks = [];
  t.mock.method(MusicPlayer, 'playSongLavalink', async (_guild, _channel, item, _source, options) => {
    played.push(options);
    queue.playbackId += 1;
    queue.terminalHandledPlaybackId = null;
    queue.streamDiagnostics = { playbackId: queue.playbackId, startPositionSeconds: options.seekSeconds };
    MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, item, options);
    MusicPlayer.handleLavalinkTrackStart(queue.guildId, null, { userData: { musicBotPlaybackId: queue.playbackId } });
  });
  t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async (...args) => { fallbacks.push(args); });
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, unreachableMessage);
  const session = queue.playbackRecovery;
  t.mock.timers.tick(1200);
  await new Promise(resolve => setImmediate(resolve));
  await queue.transitionTail;
  assert.equal(played.length, 1);
  assert.equal(played[0].lavalinkRetryTimeoutMs, 8000);
  assert.equal(played[0].recoverySession, session);
  assert.equal(session.lavalinkRetries, 1);
  assert.equal(queue.playbackAttemptDeadline, Date.now() + 8000);
  const retryId = queue.playbackId;
  await MusicPlayer.handleLavalinkFailure(queue.guildId, retryId, unreachableMessage);
  await MusicPlayer.handleLavalinkFailure(queue.guildId, retryId, unreachableMessage);
  t.mock.timers.tick(8000);
  await queue.transitionTail;
  assert.equal(fallbacks.length, 1);
  assert.deepEqual(queue.songs, [next]);
  assert.equal(queue.currentSong, song);
});

test('insufficient recovery budget goes directly to local without spending a retry', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = MusicPlayer.recoverySession(queue);
  session.deadline = Date.now() + 18_000;
  const played = t.mock.method(MusicPlayer, 'playSongLavalink', async () => {});
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, unreachableMessage);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(played.mock.callCount(), 0);
  assert.equal(session.lavalinkRetries, 0);
  assert.equal(queue.pendingPlaybackRecovery, null);
});

test('retry budget is rechecked after waiting for the guild lock', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = MusicPlayer.recoverySession(queue);
  session.deadline = Date.now() + 24_000;
  const played = t.mock.method(MusicPlayer, 'playSongLavalink', async () => {});
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, unreachableMessage);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const busy = MusicPlayer.runTransition(queue.guildId, () => gate);
  t.mock.timers.tick(1200);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  release();
  await busy;
  await new Promise(resolve => setImmediate(resolve));
  await queue.transitionTail;
  assert.equal(played.mock.callCount(), 0);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(session.deadline - Date.now(), 17_800);
});

test('retry timeout aborts hanging work before acquiring the lock and falls back once', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const next = { title: 'Next', url: url('bcdefghijkl') };
  queue.songs = [next];
  const session = MusicPlayer.recoverySession(queue);
  session.lavalinkRetries = 1;
  session.deadline = Date.now() + 23_000;
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  const advance = t.mock.method(MusicPlayer, 'advance', async () => {});
  let signal;
  const blocked = MusicPlayer.runTransition(queue.guildId, async () => {
    signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, {
      recoverySession: session,
      lavalinkRetryTimeoutMs: 8000,
    });
    await assert.rejects(withPlaybackSignal(() => new Promise(() => {}), signal), /重试.*超时/);
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'LAVALINK_RETRY_START_TIMEOUT');
  await blocked;
  await queue.transitionTail;
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(advance.mock.callCount(), 0);
  assert.equal(session.deadline - Date.now(), 15_000);
  assert.equal(queue.backendUnavailable, false);
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, unreachableMessage);
  MusicPlayer.handleLavalinkTrackEnd(queue.guildId, null, { userData: { musicBotPlaybackId: 10 } }, { reason: 'finished' });
  assert.equal(fallback.mock.callCount(), 1);
  assert.deepEqual(queue.songs, [next]);
});

test('pausing preserves the shorter retry deadline rather than the shared deadline', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = MusicPlayer.recoverySession(queue);
  session.lavalinkRetries = 1;
  const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, {
    recoverySession: session,
    lavalinkRetryTimeoutMs: 8000,
  });
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  t.mock.timers.tick(2000);
  MusicPlayer.setSongPausedState(queue, true);
  t.mock.timers.tick(20_000);
  assert.equal(signal.aborted, false);
  MusicPlayer.setSongPausedState(queue, false);
  t.mock.timers.tick(5999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await queue.transitionTail;
  assert.equal(signal.aborted, true);
  assert.equal(fallback.mock.callCount(), 1);
});

test('stop aborts paused retry work even while its deadline timer is suspended', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = MusicPlayer.recoverySession(queue);
  session.lavalinkRetries = 1;
  const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, {
    recoverySession: session,
    lavalinkRetryTimeoutMs: 8000,
  });
  MusicPlayer.setSongPausedState(queue, true);
  assert.equal(queue.playbackDeadlineTimer, null);
  const blocked = MusicPlayer.runTransition(queue.guildId, () => withPlaybackSignal(() => new Promise(() => {}), signal).catch(() => {}));
  await new Promise(resolve => setImmediate(resolve));
  await MusicPlayer.stop(queue.guildId);
  await blocked;
  assert.equal(signal.aborted, true);
  assert.equal(queue.playbackDeadlineExpire, null);
  assert.equal(queue.currentSong, null);
});

test('confirmed retry output clears its deadline and stable local output clears recovery', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = MusicPlayer.recoverySession(queue);
  session.lavalinkRetries = 1;
  const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, {
    recoverySession: session,
    lavalinkRetryTimeoutMs: 8000,
  });
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  queue.activeBackend = 'lavalink';
  const player = { queue: { current: { userData: { musicBotPlaybackId: 10 } } }, lastPosition: 5000 };
  MusicPlayer.handleLavalinkPlayerUpdate(queue.guildId, player);
  assert.equal(queue.playbackDeadlineTimer, null);
  t.mock.timers.tick(8000);
  assert.equal(signal.aborted, false);
  assert.equal(fallback.mock.callCount(), 0);

  MusicPlayer.invalidateCurrentPlayback(queue.guildId, queue);
  queue.streamDiagnostics = { playbackId: queue.playbackId };
  MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, { recoverySession: session });
  queue.playing = true;
  queue.audioResource = { playbackDuration: 30_000 };
  queue.playbackRetryCount = 1;
  MusicPlayer.confirmPlaybackOutput(queue.guildId, queue, queue.playbackId, 'local');
  t.mock.timers.tick(30_000);
  assert.equal(queue.playbackRecovery, null);
  assert.equal(queue.playbackRetryCount, 0);
  assert.equal(queue.playbackStableTimer, null);
});

for (const action of ['stop', 'skip', 'replace']) {
  test(`${action} cancels a pending bounded retry and cannot resurrect the old song`, async t => {
    const queue = queueFor(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const next = { title: 'Next', url: url('bcdefghijkl'), source: 'manual' };
    queue.songs = [next];
    const session = MusicPlayer.recoverySession(queue);
    session.lavalinkRetries = 1;
    const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
    const calls = [];
    t.mock.method(MusicPlayer, 'shouldUseLavalink', () => true);
    t.mock.method(MusicPlayer, 'playSongLavalink', async (_guild, _channel, song) => { calls.push(song); queue.currentSong = song; });
    const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, {
      recoverySession: session,
      lavalinkRetryTimeoutMs: 8000,
    });
    const blocked = MusicPlayer.runTransition(queue.guildId, () => withPlaybackSignal(() => new Promise(() => {}), signal).catch(() => {}));
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'stop') await MusicPlayer.stop(queue.guildId);
    else if (action === 'skip') await MusicPlayer.skip(queue.guildId);
    else await MusicPlayer.playSong(queue.guildId, null, next);
    await blocked;
    t.mock.timers.tick(8000);
    await queue.transitionTail;
    assert.equal(signal.aborted, true);
    assert.equal(fallback.mock.callCount(), 0);
    assert.equal(queue.playbackDeadlineTimer, null);
    assert.deepEqual(calls, action === 'stop' ? [] : [next]);
  });
}

test('Lavalink recovery uses confirmed server progress or original seek, never an extrapolated clock', async t => {
  const queue = queueFor(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  queue.seekOffsetSeconds = 12;
  queue.startedAt = Date.now() - 21_000;
  queue.streamDiagnostics = { playbackId: 10, startPositionSeconds: 12 };
  assert.equal(MusicPlayer.lavalinkProgressSeconds(queue, { position: 33000, lastPosition: 0 }), 12);
  queue.seekOffsetSeconds = 33; // A frozen extrapolated clock must not replace the attempt's initial seek.
  assert.equal(MusicPlayer.lavalinkProgressSeconds(queue), 12);
  MusicPlayer.recoverySession(queue).deadline = Date.now() + 18_000;
  const fallback = t.mock.method(MusicPlayer, 'fallbackLavalinkToLocal', async () => {});
  await MusicPlayer.handleLavalinkFailure(queue.guildId, 10, unreachableMessage);
  assert.equal(fallback.mock.calls[0].arguments[4].progressSeconds, 12);
  assert.equal(queue.lastPlaybackError.progressSeconds, 12);
  queue.streamDiagnostics.outputConfirmed = true;
  queue.streamDiagnostics.confirmedPositionMs = 17000;
  assert.equal(MusicPlayer.lavalinkProgressSeconds(queue, { position: 80000, lastPosition: 19000 }), 19);
  assert.equal(MusicPlayer.lavalinkProgressSeconds(queue), 17);
});

test('stop cancels recovery while preparation runs outside the guild lock', async t => {
  const queue = queueFor(t);
  let prepareSignal;
  let executed = 0;
  await MusicPlayer.runTransition(queue.guildId, () => MusicPlayer.schedulePlaybackWork(queue.guildId, queue, {
    prepare: signal => { prepareSignal = signal; return new Promise(() => {}); },
    execute: () => { executed += 1; },
  }));
  await delay(10);
  assert.ok(prepareSignal);
  await MusicPlayer.stop(queue.guildId);
  assert.equal(prepareSignal.aborted, true);
  assert.equal(queue.currentSong, null);
  await delay(10);
  assert.equal(executed, 0);
});

test('skip interrupts an in-flight attempt and cannot resurrect the failed track', async t => {
  const queue = queueFor(t);
  const next = { title: 'Next', url: url('bcdefghijkl'), source: 'manual' };
  queue.songs = [queue.currentSong, next];
  queue.reservedNext = { itemId: queue.currentSong.queueItemId, song: queue.currentSong, source: 'manual' };
  const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong);
  const blocked = MusicPlayer.runTransition(queue.guildId, () => withPlaybackSignal(() => new Promise(() => {}), signal).catch(() => {}));
  await delay(1);
  const calls = [];
  t.mock.method(MusicPlayer, 'playSong', async (_guild, _channel, song) => { calls.push(song); queue.currentSong = song; });
  const result = await MusicPlayer.skip(queue.guildId);
  await blocked;
  assert.equal(signal.aborted, true);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [next]);
});

test('callbacks inherited from completed transitions still honor the current guild lock', async t => {
  const queue = queueFor(t);
  let entered;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  await MusicPlayer.runTransition(queue.guildId, () => {
    setTimeout(() => {
      entered = MusicPlayer.runTransition(queue.guildId, () => order.push('late-callback'));
    }, 5);
  });
  const busy = MusicPlayer.runTransition(queue.guildId, async () => {
    order.push('busy-start');
    await gate;
    order.push('busy-end');
  });
  await delay(15);
  assert.deepEqual(order, ['busy-start']);
  release();
  await busy;
  await entered;
  assert.deepEqual(order, ['busy-start', 'busy-end', 'late-callback']);
});

test('server-reported audio progress confirms output but an extrapolated clock does not', t => {
  const queue = queueFor(t);
  MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong);
  queue.activeBackend = 'lavalink';
  queue.seekOffsetSeconds = 0;
  const player = { queue: { current: { userData: { musicBotPlaybackId: queue.playbackId } } }, position: 9000, lastPosition: 0 };
  MusicPlayer.handleLavalinkPlayerUpdate(queue.guildId, player);
  assert.ok(queue.playbackDeadlineTimer);
  player.lastPosition = 5000;
  MusicPlayer.handleLavalinkPlayerUpdate(queue.guildId, player);
  assert.equal(queue.playbackDeadlineTimer, null);
  assert.ok(queue.playbackStableTimer);
});

test('pausing before the first server progress suspends the output deadline', async t => {
  const queue = queueFor(t);
  const session = MusicPlayer.recoverySession(queue);
  session.deadline = Date.now() + 40;
  MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, { recoverySession: session });
  const originalDeadline = session.deadline;
  MusicPlayer.setSongPausedState(queue, true);
  await delay(60);
  assert.equal(queue.playbackDeadlineTimer, null);
  assert.equal(queue.playbackAttemptController.signal.aborted, false);
  MusicPlayer.setSongPausedState(queue, false);
  assert.ok(session.deadline > originalDeadline);
  assert.ok(queue.playbackDeadlineTimer);
});

test('an empty channel cancels scheduled recovery without consuming queued music', async t => {
  const queue = queueFor(t);
  const next = { title: 'Next', url: url('bcdefghijkl'), source: 'manual' };
  queue.songs = [next];
  let executed = false;
  MusicPlayer.schedulePlaybackWork(queue.guildId, queue, {
    delayMs: 10,
    execute: () => { executed = true; },
  });
  queue.pausedByEmptyChannel = true;
  await delay(30);
  await queue.transitionTail;
  assert.equal(executed, false);
  assert.equal(queue.queueEnded, true);
  assert.deepEqual(queue.songs, [next]);
});

test('expired recovery skips once rather than retrying or cooling unrelated next items', async t => {
  const queue = queueFor(t);
  queue.playbackError = true;
  queue.lastPlaybackError = { source: 'yt-dlp', message: 'This video is not available', category: 'content-unavailable' };
  MusicPlayer.recoverySession(queue).deadline = Date.now() - 1;
  const next = { title: 'Next', url: url('bcdefghijkl'), source: 'manual' };
  queue.songs = [next];
  const calls = [];
  t.mock.method(MusicPlayer, 'playSong', async (_guild, _channel, song) => { calls.push(song); });
  await MusicPlayer.advance(queue.guildId, queue);
  assert.deepEqual(calls, [next]);
  assert.equal(queue.pendingPlaybackRecovery, null);
  assert.equal(playbackAvailability.isCoolingDown(next), false);
});

test('recovery deadline aborts hanging work, cleans processes and advances exactly once', async t => {
  const queue = queueFor(t);
  const session = MusicPlayer.recoverySession(queue);
  session.deadline = Date.now() + 20;
  const signals = [];
  queue.ytdlpProcess = { exitCode: null, signalCode: null, kill(signal) { signals.push(signal || 'SIGTERM'); this.exitCode = 1; } };
  let advances = 0;
  t.mock.method(MusicPlayer, 'advance', async () => { advances += 1; });
  const signal = MusicPlayer.beginPlaybackAttempt(queue.guildId, queue, queue.currentSong, { recoverySession: session });
  await assert.rejects(withPlaybackSignal(() => new Promise(() => {}), signal), /deadline/);
  await delay(10);
  assert.equal(advances, 1);
  assert.equal(queue.ytdlpProcess, null);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('Radio alternatives share the deadline and stop at two candidates; manual URLs never replace', async t => {
  const queue = queueFor(t, { source: 'radio' });
  queue.radio.enabled = true;
  const session = MusicPlayer.recoverySession(queue);
  session.alternatives = [
    { title: 'Example Artist Song', duration: '4:00', url: url('bcdefghijkl') },
    { title: 'Example Artist Song', duration: '4:00', url: url('cdefghijklm') },
  ];
  const calls = [];
  t.mock.method(MusicPlayer, 'playSong', async (_guild, _channel, song, _source, options) => {
    calls.push({ song, options });
    queue.currentSong = song;
  });
  const policy = classifyPlaybackError('This video is not available');
  assert.equal(MusicPlayer.tryRadioAlternative(queue.guildId, queue, session, policy), true);
  await delay(10);
  await queue.transitionTail;
  assert.equal(MusicPlayer.tryRadioAlternative(queue.guildId, queue, session, policy), true);
  await delay(10);
  await queue.transitionTail;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.recoverySession, session);
  assert.equal(calls[1].song.queueItemId, session.itemId);
  assert.equal(MusicPlayer.tryRadioAlternative(queue.guildId, queue, session, policy), false);
  queue.currentSong.source = 'manual';
  session.alternativeAttempts = 0;
  assert.equal(MusicPlayer.tryRadioAlternative(queue.guildId, queue, session, policy), false);
});

test('Radio checks cooldown again for reserved items; manual queue remains playable', t => {
  const queue = queueFor(t);
  const failed = queue.currentSong;
  const good = { title: 'Same song other upload', url: url('bcdefghijkl') };
  queue.songs = [failed];
  queue.radioQueue = [failed, good];
  queue.reservedNext = { source: 'radio', song: failed };
  playbackAvailability.failure(failed, 'local', 'content-unavailable', { exhausted: true });
  MusicPlayer.pruneUnavailableRadio(queue);
  assert.deepEqual(queue.radioQueue, [good]);
  assert.deepEqual(queue.songs, [failed]);
  assert.equal(queue.reservedNext, null);
});

test('alternative search passes cancellation and caps matching results', async t => {
  const original = { title: 'Artist Song', duration: '4:00', url: url('abcdefghijk') };
  const controller = new AbortController();
  t.mock.method(YouTube, 'search', async (_query, _limit, options) => {
    assert.equal(options.signal, controller.signal);
    return ['bcdefghijkl', 'cdefghijklm', 'defghijklmn'].map(id => ({ ...original, url: url(id) }));
  });
  assert.equal((await findRadioAlternatives(original, 'normal', { signal: controller.signal })).length, 2);
});
