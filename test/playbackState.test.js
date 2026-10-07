import test from 'node:test';
import assert from 'node:assert/strict';
import { GuildSettings, PlaybackState } from '../src/models/database.js';
import {
  MAX_QUEUE_SIZE,
  cancelPendingPlaybackSave,
  cancelPendingPlaybackSaves,
  getQueueCapacity,
  getQueueLimit,
  hydrateQueue,
  savePlaybackState,
  serializeQueue,
} from '../src/utils/playbackState.js';

test('exports a queue limit and clips persisted queue arrays', () => {
  const songs = Array.from({ length: MAX_QUEUE_SIZE + 5 }, (_, index) => ({ id: `song-${index}` }));
  const radioQueue = Array.from({ length: MAX_QUEUE_SIZE + 5 }, (_, index) => ({ id: `radio-${index}` }));
  const history = Array.from({ length: 105 }, (_, index) => ({ id: `history-${index}` }));
  const state = serializeQueue('guild', { songs, radioQueue, history });

  assert.equal(getQueueLimit(), MAX_QUEUE_SIZE);
  assert.equal(getQueueCapacity({ songs: songs.slice(0, 3) }), MAX_QUEUE_SIZE - 3);
  assert.equal(state.songs.length, MAX_QUEUE_SIZE);
  assert.equal(state.radioQueue.length, MAX_QUEUE_SIZE);
  assert.equal(state.history.length, 100);
  assert.equal(state.songs[0].id, 'song-0');
  assert.equal(state.history[0].id, 'history-5');

  const queue = {};
  hydrateQueue(queue, state);
  assert.equal(queue.songs.length, MAX_QUEUE_SIZE);
  assert.equal(queue.radioQueue.length, MAX_QUEUE_SIZE);
  assert.equal(queue.history.length, 100);
});

test('delayed saves reject callbacks for a replaced queue and support cancellation', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSet = PlaybackState.set;
  const callbacks = [];
  const saved = [];
  const guildId = `pending-${Date.now()}`;

  globalThis.setTimeout = callback => {
    const timer = { callback };
    callbacks.push(timer);
    return timer;
  };
  globalThis.clearTimeout = () => {};
  PlaybackState.set = (_guildId, state) => saved.push(state);

  try {
    const firstQueue = { songs: [{ id: 'first' }] };
    const secondQueue = { songs: [{ id: 'second' }] };
    savePlaybackState(guildId, firstQueue);
    const firstTimer = callbacks.at(-1);
    savePlaybackState(guildId, secondQueue);
    const secondTimer = callbacks.at(-1);

    firstTimer.callback();
    assert.equal(saved.length, 0);
    secondTimer.callback();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].songs[0].id, 'second');

    savePlaybackState(guildId, firstQueue);
    const cancelledTimer = callbacks.at(-1);
    assert.equal(cancelPendingPlaybackSave(guildId), true);
    cancelledTimer.callback();
    assert.equal(saved.length, 1);
    assert.equal(cancelPendingPlaybackSave(guildId), false);
  } finally {
    cancelPendingPlaybackSaves();
    PlaybackState.set = originalSet;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('hydrates legacy playback settings from GuildSettings', () => {
  const guildId = `settings-${Date.now()}`;
  GuildSettings.update(guildId, {
    defaultVolume: 23,
    notificationMode: 'panel',
    versionPreference: 'normal',
  });
  const queue = { guildId };

  hydrateQueue(queue, { songs: [], radioQueue: [] });

  assert.equal(queue.volume, 23);
  assert.equal(queue.notificationMode, 'panel');
  assert.equal(queue.versionPreference, 'normal');
});
