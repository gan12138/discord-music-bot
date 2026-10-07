import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNowPlayingPayload,
  isPanelCurrent,
  refreshNowPlayingPanel,
} from '../src/utils/playerPanel.js';

function makeQueue(guildId) {
  return {
    guildId,
    currentSong: {
      title: 'Current',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      duration: '3:00',
      requestedBy: 'Tester',
      source: 'manual',
    },
    songs: [],
    radioQueue: [],
    radio: { enabled: false, currentStyle: {} },
    volume: 50,
    loop: 'off',
    versionPreference: 'any',
    notificationMode: 'panel',
    lifecycleGeneration: 'lifecycle',
    panelPublishSequence: 0,
    panelPublishTail: Promise.resolve(),
    nowPlayingMessageId: 'panel-message',
    nowPlayingChannelId: 'panel-channel',
  };
}

test('refreshes a persisted panel with a token valid after a restart', async () => {
  const guildId = `panel-${Date.now()}`;
  const oldQueue = makeQueue(guildId);
  const oldPayload = buildNowPlayingPayload(oldQueue, oldQueue.currentSong);
  const oldButtonId = oldPayload.components[0].components[0].data.custom_id;
  let editedPayload = null;
  const message = {
    id: 'panel-message',
    edit: async payload => {
      editedPayload = payload;
      return message;
    },
  };
  const channel = {
    id: 'panel-channel',
    messages: {
      fetch: async id => {
        assert.equal(id, 'panel-message');
        return message;
      },
    },
  };
  const restoredQueue = makeQueue(guildId);

  await refreshNowPlayingPanel(guildId, channel, restoredQueue);

  assert.ok(editedPayload);
  const newButtonId = editedPayload.components[0].components[0].data.custom_id;
  assert.notEqual(newButtonId, oldButtonId);
  assert.equal(isPanelCurrent(restoredQueue, newButtonId.split(':').at(-1)), true);
  assert.equal(isPanelCurrent(restoredQueue, oldButtonId.split(':').at(-1)), false);
});

test('does not delete the persistent panel when a newer refresh supersedes an edit', async () => {
  const guildId = `panel-race-${Date.now()}`;
  const queue = makeQueue(guildId);
  const nextSong = {
    ...queue.currentSong,
    title: 'Next',
    url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
  };
  let releaseFirstEdit;
  let firstEditStarted;
  const firstEditReady = new Promise(resolve => {
    firstEditStarted = resolve;
  });
  const firstEditFinished = new Promise(resolve => {
    releaseFirstEdit = resolve;
  });
  let editCount = 0;
  let deleteCount = 0;
  const message = {
    id: 'panel-message',
    edit: async () => {
      editCount += 1;
      if (editCount === 1) {
        firstEditStarted();
        await firstEditFinished;
      }
      return message;
    },
    delete: async () => {
      deleteCount += 1;
    },
  };
  const channel = {
    id: 'panel-channel',
    messages: {
      fetch: async id => {
        assert.equal(id, 'panel-message');
        return message;
      },
    },
  };

  const firstRefresh = refreshNowPlayingPanel(guildId, channel, queue);
  await firstEditReady;
  queue.currentSong = nextSong;
  const secondRefresh = refreshNowPlayingPanel(guildId, channel, queue);
  releaseFirstEdit();

  await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(deleteCount, 0);
  assert.equal(editCount, 2);
  assert.equal(queue.nowPlayingMessageId, 'panel-message');
});
