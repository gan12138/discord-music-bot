import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function runDatabaseProcess(dataPath, source, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MUSICBOT_DATA_PATH: dataPath,
      ...extraEnv,
    },
  });
}

test('uses the isolated MUSICBOT_DATA_PATH and repairs top-level schema types', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-music-bot-schema-'));
  const dataPath = join(directory, 'state.json');
  writeFileSync(dataPath, JSON.stringify({
    playlists: {},
    guildSettings: null,
    playbackStates: [],
  }));

  try {
    const result = runDatabaseProcess(dataPath, `
      import { DATABASE_PATH, GuildSettings, PlaybackState, flushDB, loadDB } from './src/models/database.js';
      const db = loadDB();
      const settings = GuildSettings.get('guild');
      const playbackStates = PlaybackState.getAll();
      const flushed = flushDB();
      console.log(JSON.stringify({
        path: DATABASE_PATH,
        db,
        settings,
        playbackStates,
        flushed,
      }));
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.path, resolve(dataPath));
    assert.deepEqual(output.db, {
      playlists: [],
      guildSettings: {},
      playbackStates: {},
    });
    assert.equal(output.settings.defaultVolume, 50);
    assert.equal(output.settings.voiceControl.cloudSttEnabled, true);
    assert.equal(output.settings.voiceControl.enabled, true);
    assert.equal(output.settings.voiceControl.permissionMode, 'everyone');
    assert.equal(output.settings.voiceControl.sttAccessMode, 'everyone');
    assert.equal(output.settings.voiceControl.listenerAutoJoin, true);
    assert.deepEqual(output.settings.voiceControl.consentedUserIds, []);
    assert.deepEqual(output.settings.voiceControl.sttOptOutUserIds, []);
    assert.deepEqual(output.playbackStates, {});
    assert.equal(output.flushed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates all enabled legacy voice settings to unrestricted everyone mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-music-bot-stt-migration-'));
  const dataPath = join(directory, 'state.json');
  writeFileSync(dataPath, JSON.stringify({
    playlists: [],
    guildSettings: {
      enabled: { voiceControl: { cloudSttEnabled: true } },
      disabled: { voiceControl: { cloudSttEnabled: false } },
      invalid: { voiceControl: { sttAccessMode: 'invalid', cloudSttEnabled: true } },
    },
    playbackStates: {},
  }));

  try {
    const result = runDatabaseProcess(dataPath, `
      import { GuildSettings } from './src/models/database.js';
      console.log(JSON.stringify({
        enabled: GuildSettings.get('enabled').voiceControl,
        disabled: GuildSettings.get('disabled').voiceControl,
        invalid: GuildSettings.get('invalid').voiceControl,
      }));
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.enabled.sttAccessMode, 'everyone');
    assert.equal(output.enabled.permissionMode, 'everyone');
    assert.deepEqual(output.enabled.allowedRoleIds, []);
    assert.equal(output.enabled.cloudSttEnabled, true);
    assert.equal(output.disabled.sttAccessMode, 'off');
    assert.equal(output.disabled.cloudSttEnabled, false);
    assert.equal(output.invalid.sttAccessMode, 'everyone');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps the database dirty and retries a failed flush within a bound', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-music-bot-retry-'));
  const blocker = join(directory, 'blocker');
  const dataPath = join(blocker, 'state.json');
  writeFileSync(blocker, 'not a directory');

  try {
    const result = runDatabaseProcess(dataPath, `
      import { flushDB, getDatabaseStatus, saveDB } from './src/models/database.js';
      saveDB({ playlists: [], guildSettings: {}, playbackStates: {} });
      const flushed = flushDB();
      console.log(JSON.stringify({ flushed, status: getDatabaseStatus() }));
    `, {
      MUSICBOT_SAVE_RETRY_LIMIT: '2',
      MUSICBOT_SAVE_RETRY_DELAY_MS: '10',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.flushed, false);
    assert.equal(output.status.dirty, true);
    assert.equal(output.status.retryCount, 1);
    assert.equal(output.status.pendingFlush, true);
    assert.equal(output.status.maxRetries, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reads MAX_QUEUE_SIZE from the environment for playback helpers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-music-bot-limit-'));
  const dataPath = join(directory, 'state.json');

  try {
    const result = runDatabaseProcess(dataPath, `
      import { getQueueCapacity, getQueueLimit, MAX_QUEUE_SIZE } from './src/utils/playbackState.js';
      console.log(JSON.stringify({
        constant: MAX_QUEUE_SIZE,
        helper: getQueueLimit(),
        capacity: getQueueCapacity({ songs: [{ id: 'one' }] }),
      }));
    `, { MAX_QUEUE_SIZE: '7' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      constant: 7,
      helper: 7,
      capacity: 6,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists guild playback settings and seeds a new queue from them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-music-bot-settings-'));
  const dataPath = join(directory, 'state.json');

  try {
    const result = runDatabaseProcess(dataPath, `
      import { GuildSettings, flushDB } from './src/models/database.js';
      import { musicQueue } from './src/utils/player.js';
      GuildSettings.update('guild', {
        defaultVolume: 37,
        notificationMode: 'panel',
        versionPreference: 'live',
        djRole: '123456789012345678',
      });
      const queue = musicQueue.get('guild');
      flushDB();
      console.log(JSON.stringify({
        settings: GuildSettings.get('guild'),
        queue: {
          volume: queue.volume,
          notificationMode: queue.notificationMode,
          versionPreference: queue.versionPreference,
        },
      }));
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.settings.defaultVolume, 37);
    assert.equal(output.settings.notificationMode, 'panel');
    assert.equal(output.settings.versionPreference, 'live');
    assert.equal(output.settings.djRole, '123456789012345678');
    assert.deepEqual(output.queue, {
      volume: 37,
      notificationMode: 'panel',
      versionPreference: 'live',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
