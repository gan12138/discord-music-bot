import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { GuildSettings } from '../src/models/database.js';
import {
  grantVoiceConsent,
  isVoiceSttAllowed,
  revokeVoiceConsent,
  setCloudSttEnabled,
  setVoiceSttAccessMode,
  voiceConsentStatus,
} from '../src/utils/voiceConsent.js';
import { VoiceListenerManager } from '../src/utils/voiceListenerManager.js';

const guildId = `consent-${Date.now()}`;
const userId = '123456789012345678';

test('cloud STT allows every human by default with personal opt-out', () => {
  assert.deepEqual(voiceConsentStatus(guildId, userId), {
    sttAccessMode: 'everyone',
    cloudSttEnabled: true,
    consented: false,
    optedOut: false,
    effectiveAllowed: true,
    consentedUserCount: 0,
    optedOutUserCount: 0,
  });
  assert.equal(grantVoiceConsent(guildId, userId).ok, true);

  assert.equal(voiceConsentStatus(guildId, userId).effectiveAllowed, true);
  assert.deepEqual(GuildSettings.get(guildId).voiceControl.consentedUserIds, []);

  const revoked = revokeVoiceConsent(guildId, userId);
  assert.equal(revoked.changed, true);
  assert.equal(voiceConsentStatus(guildId, userId).effectiveAllowed, false);
});

test('disabling cloud STT clears stored user consent', () => {
  setCloudSttEnabled(guildId, true);
  assert.equal(grantVoiceConsent(guildId, userId).ok, true);
  setCloudSttEnabled(guildId, false);
  assert.deepEqual(voiceConsentStatus(guildId, userId), {
    sttAccessMode: 'off',
    cloudSttEnabled: false,
    consented: false,
    optedOut: false,
    effectiveAllowed: false,
    consentedUserCount: 0,
    optedOutUserCount: 0,
  });
});

test('STT access modes support everyone with a per-user opt-out', () => {
  const guildId = `consent-modes-${Date.now()}`;
  const settingsFor = () => GuildSettings.get(guildId).voiceControl;

  setVoiceSttAccessMode(guildId, 'off');
  assert.equal(isVoiceSttAllowed(settingsFor(), userId), false);

  setVoiceSttAccessMode(guildId, 'everyone');
  assert.equal(isVoiceSttAllowed(settingsFor(), userId), true);
  assert.equal(revokeVoiceConsent(guildId, userId).changed, true);
  assert.equal(isVoiceSttAllowed(settingsFor(), userId), false);
  assert.equal(voiceConsentStatus(guildId, userId).optedOut, true);

  const rejoined = grantVoiceConsent(guildId, userId);
  assert.equal(rejoined.mode, 'everyone');
  assert.equal(rejoined.changed, true);
  assert.equal(isVoiceSttAllowed(settingsFor(), userId), true);
});

test('invalid STT access modes fail closed', () => {
  assert.equal(isVoiceSttAllowed({ sttAccessMode: 'invalid' }, userId), false);
});

test('listener gate allows everyone until they opt out', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      provider: 'test',
      model: 'test',
      configured: () => true,
      audioFormat: () => ({ type: 'audio/pcm', sampleRate: 24_000, channels: 1, bytesPerSample: 2, frameSize: 480 }),
    },
  });
  setCloudSttEnabled(guildId, true);
  assert.equal(manager.hasVoiceConsent(guildId, userId), true);
  revokeVoiceConsent(guildId, userId);
  assert.equal(manager.hasVoiceConsent(guildId, userId), false);
});

test('listener does not subscribe to audio for an opted-out member', async () => {
  const guildId = `subscribe-consent-${Date.now()}`;
  const userId = '123456789012345678';
  GuildSettings.update(guildId, {
    voiceControl: {
      enabled: true,
      cloudSttEnabled: true,
      permissionMode: 'everyone',
      sttOptOutUserIds: [userId],
    },
  });

  let subscriptions = 0;
  const member = {
    id: userId,
    user: { bot: false },
    voice: { channelId: 'voice' },
    roles: { cache: [] },
  };
  const mainGuild = {
    members: {
      me: { voice: { channelId: 'voice' } },
      cache: new Map([[userId, member]]),
    },
  };
  const listenerChannel = {
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const listenerGuild = {
    channels: { cache: new Map([['voice', listenerChannel]]) },
  };
  const manager = new VoiceListenerManager({
    user: { id: 'main' },
    guilds: { cache: new Map([[guildId, mainGuild]]) },
  }, {
    stt: {
      provider: 'test',
      model: 'test',
      configured: () => true,
      audioFormat: () => ({ type: 'audio/pcm', sampleRate: 24_000, channels: 1, bytesPerSample: 2, frameSize: 480 }),
    },
  });
  manager.started = true;
  manager.client = {
    user: { id: 'listener' },
    guilds: { cache: new Map([[guildId, listenerGuild]]) },
  };
  manager.connections.set(guildId, {
    channelId: 'voice',
    connection: {
      state: { status: 'ready' },
      receiver: {
        speaking: { on() {}, off() {} },
        subscribe() { subscriptions += 1; },
      },
    },
    speakingHandler: () => {},
  });

  await manager.onSpeakingStart(guildId, userId);
  assert.equal(subscriptions, 0);
});

test('listener subscribes to an eligible member in everyone mode', async () => {
  const guildId = `subscribe-everyone-${Date.now()}`;
  const userId = '123456789012345678';
  GuildSettings.update(guildId, {
    voiceControl: {
      enabled: true,
      sttAccessMode: 'everyone',
      permissionMode: 'everyone',
      sttOptOutUserIds: [],
    },
  });

  let subscriptions = 0;
  const member = {
    id: userId,
    user: { bot: false },
    voice: { channelId: 'voice' },
    roles: { cache: [] },
  };
  const mainGuild = {
    members: {
      me: { voice: { channelId: 'voice' } },
      cache: new Map([[userId, member]]),
    },
  };
  const listenerChannel = {
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const listenerGuild = {
    channels: { cache: new Map([['voice', listenerChannel]]) },
  };
  const manager = new VoiceListenerManager({
    user: { id: 'main' },
    guilds: { cache: new Map([[guildId, mainGuild]]) },
  }, {
    stt: {
      provider: 'test',
      model: 'test',
      configured: () => true,
      audioFormat: () => ({ type: 'audio/pcm', sampleRate: 24_000, channels: 1, bytesPerSample: 2, frameSize: 480 }),
      transcribe: async () => '',
    },
  });
  manager.started = true;
  manager.client = {
    user: { id: 'listener' },
    guilds: { cache: new Map([[guildId, listenerGuild]]) },
  };
  manager.connections.set(guildId, {
    channelId: 'voice',
    connection: {
      state: { status: 'ready' },
      receiver: {
        speaking: { on() {}, off() {} },
        subscribe() {
          subscriptions += 1;
          return new PassThrough();
        },
      },
    },
    speakingHandler: () => {},
  });

  await manager.onSpeakingStart(guildId, userId);
  assert.equal(subscriptions, 1);
  manager.abortGuildRecordings(guildId);
});

test('listener can remain connected while cloud STT is disabled', () => {
  const guildId = `listener-connection-${Date.now()}`;
  GuildSettings.update(guildId, {
    voiceControl: {
      enabled: true,
      listenerAutoJoin: true,
      cloudSttEnabled: false,
      consentedUserIds: [],
    },
  });
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      provider: 'test',
      model: 'test',
      configured: () => true,
      audioFormat: () => ({ type: 'audio/pcm', sampleRate: 24_000, channels: 1, bytesPerSample: 2, frameSize: 480 }),
    },
  });

  assert.equal(manager.hasVoiceConsent(guildId, userId), false);
  assert.equal(GuildSettings.get(guildId).voiceControl.listenerAutoJoin, true);
});
