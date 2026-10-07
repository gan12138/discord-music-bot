import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_LAVALINK_NODE_CODE,
  NoLavalinkNodeError,
  getLavalinkNodeHealth,
  ensureLavalinkNodePresent,
  isLavalinkNodeHealthy,
  isValidLavalinkInfo,
  reconnectLavalinkPlayerVoice,
  waitForHealthyLavalinkNode,
} from '../src/utils/lavalink.js';

function managerWith(node) {
  return {
    useable: true,
    nodeManager: { nodes: new Map([[node.id || 'main', node]]) },
  };
}

test('node health does not trust manager.useable when info is missing', () => {
  const node = { id: 'main', connected: true, info: null, sessionId: 'session-1' };

  assert.deepEqual(getLavalinkNodeHealth(node), {
    connected: true,
    hasInfo: false,
    hasSessionId: true,
    healthy: false,
    missing: ['info'],
  });
  assert.equal(isLavalinkNodeHealthy(node), false);
});

test('empty info is not considered valid node metadata', () => {
  const node = { connected: true, info: {}, sessionId: 'session-1' };

  assert.equal(getLavalinkNodeHealth(node).healthy, false);
  assert.deepEqual(getLavalinkNodeHealth(node).missing, ['info']);
});

test('an error-shaped /v4/info response is not accepted as node info', () => {
  const node = {
    connected: true,
    info: { message: 'Unauthorized' },
    sessionId: 'session-1',
  };

  assert.equal(getLavalinkNodeHealth(node).healthy, false);
  assert.equal(isValidLavalinkInfo(node.info), false);
});

test('healthy-node wait refreshes /v4/info and stores the returned info', async () => {
  let fetches = 0;
  const sleeps = [];
  const node = {
    id: 'main',
    connected: true,
    info: null,
    sessionId: 'session-1',
    async fetchInfo() {
      fetches += 1;
      if (fetches === 1) throw new Error('temporary /v4/info failure');
      return { version: { semver: '4.0.0' }, sourceManagers: ['youtube'] };
    },
  };

  const result = await waitForHealthyLavalinkNode(managerWith(node), {
    timeoutMs: 50,
    requestTimeoutMs: 20,
    retryDelaysMs: [1],
    sleep: async ms => sleeps.push(ms),
  });

  assert.equal(result, node);
  assert.equal(fetches, 2);
  assert.deepEqual(sleeps, [1]);
  assert.equal(node.info.version.semver, '4.0.0');
});

test('disconnected nodes are retried with bounded backoff', async () => {
  let connectCalls = 0;
  const sleeps = [];
  const node = {
    id: 'main',
    connected: false,
    info: null,
    sessionId: null,
    connect() {
      connectCalls += 1;
    },
    async fetchInfo() {
      return { version: { semver: '4.0.0' }, sourceManagers: ['youtube'] };
    },
  };

  const resultPromise = waitForHealthyLavalinkNode(managerWith(node), {
    timeoutMs: 100,
    retryDelaysMs: [1, 2, 4],
    sleep: async ms => {
      sleeps.push(ms);
      if (sleeps.length === 1) {
        node.connected = true;
        node.sessionId = 'session-2';
      }
    },
  });

  const result = await resultPromise;
  assert.equal(result, node);
  assert.equal(connectCalls, 1);
  assert.deepEqual(sleeps, [1]);
});

test('reconnect uses lavalink-client reconnect when available', async () => {
  let reconnectCalls = 0;
  let connectCalls = 0;
  const node = {
    id: 'main',
    connected: false,
    info: null,
    sessionId: null,
    reconnect(force) {
      reconnectCalls += 1;
      assert.equal(force, true);
      node.reconnectionState = 'PENDING';
    },
    connect() {
      connectCalls += 1;
    },
  };

  await waitForHealthyLavalinkNode(managerWith(node), {
    timeoutMs: 1,
    retryDelaysMs: [0],
    sleep: async () => {},
  });

  assert.equal(reconnectCalls, 1);
  assert.equal(connectCalls, 0);
});

test('missing nodes are recreated once and reconnected', () => {
  let creates = 0;
  let reconnects = 0;
  const nodes = new Map();
  const lavalinkManager = {
    nodeManager: {
      nodes,
      createNode(options) {
        creates += 1;
        const node = {
          id: options.id,
          connected: false,
          reconnectionState: 'IDLE',
          reconnect(force) {
            assert.equal(force, true);
            reconnects += 1;
            node.reconnectionState = 'PENDING';
          },
        };
        nodes.set(node.id, node);
        return node;
      },
    },
  };
  const options = {
    id: 'main',
    host: '127.0.0.1',
    port: 2333,
    authorization: 'secret',
  };

  const first = ensureLavalinkNodePresent(lavalinkManager, options);
  const second = ensureLavalinkNodePresent(lavalinkManager, options);

  assert.equal(first, second);
  assert.equal(creates, 1);
  assert.equal(reconnects, 1);
});

test('stale Discord voice state is disconnected and connected once', async () => {
  const events = [];
  const node = {
    connected: true,
    info: { version: { semver: '4.0.0' }, sourceManagers: ['youtube'] },
    sessionId: 'session-1',
  };
  const player = {
    node,
    connected: false,
    voiceChannelId: 'voice-1',
    options: { voiceChannelId: 'voice-1' },
    voice: { endpoint: null, sessionId: null, token: null },
    async disconnect(force) {
      events.push(['disconnect', force]);
      player.voiceChannelId = null;
    },
    async connect() {
      events.push(['connect']);
      player.voiceChannelId = player.options.voiceChannelId;
      player.connected = true;
      player.voice = { endpoint: 'discord.media', sessionId: 'voice-session', token: 'voice-token' };
    },
  };

  const ready = await reconnectLavalinkPlayerVoice(player, node, 'voice-1', {
    timeoutMs: 10,
    reconnectDelayMs: 0,
    sleep: async () => {},
  });

  assert.equal(ready, true);
  assert.deepEqual(events, [['disconnect', true], ['connect']]);
});

test('No Lavalink Node errors have a stable category and redact passwords', () => {
  const password = 'test-secret';
  const error = new NoLavalinkNodeError(`authorization=${password}`);

  assert.equal(error.code, NO_LAVALINK_NODE_CODE);
  assert.equal(error.category, NO_LAVALINK_NODE_CODE);
  assert.match(error.message, /No Lavalink Node is ready/);
  assert.doesNotMatch(error.message, new RegExp(password));
});
