import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  hasVoiceListenerIdentityConflict,
  isVoiceListenerEnabled,
  isSafeVoicePlayQuery,
  looksLikeSttPromptLeak,
  mainBotVoiceChannelId,
  shouldVoiceListenerJoin,
  VoiceListenerManager,
} from '../src/utils/voiceListenerManager.js';
import { musicQueue } from '../src/utils/player.js';
import { GuildSettings } from '../src/models/database.js';
import { canUseVoiceControl } from '../src/utils/voicePermissions.js';
import { revokeVoiceConsent } from '../src/utils/voiceConsent.js';

function fakeStt() {
  return {
    provider: 'test',
    model: 'test',
    configured: () => true,
    audioFormat: () => ({ type: 'audio/pcm', sampleRate: 24_000, channels: 1, bytesPerSample: 2, frameSize: 480 }),
    supportsStreamingInput: () => false,
    transcribe: async () => ({ text: '', language: null }),
  };
}

function testGuildSettings(guildId) {
  GuildSettings.update(guildId, {
    voiceControl: {
      enabled: true,
      sttAccessMode: 'everyone',
      sttOptOutUserIds: [],
    },
  });
  return GuildSettings.get(guildId).voiceControl;
}

function fakePacketDecoder({ fatalOnBad = false } = {}) {
  const stats = {
    backend: 'test-opus',
    totalPackets: 0,
    decodedPackets: 0,
    droppedPackets: 0,
    consecutiveErrors: 0,
    lastError: null,
  };
  return {
    backend: stats.backend,
    decode(packet) {
      stats.totalPackets += 1;
      if (packet[0] === 0xff) {
        stats.droppedPackets += 1;
        stats.consecutiveErrors += 1;
        stats.lastError = 'invalid-packet';
        return { ok: false, reason: 'invalid-packet', fatal: fatalOnBad };
      }
      stats.decodedPackets += 1;
      stats.consecutiveErrors = 0;
      return { ok: true, pcm: Buffer.alloc(9_600, packet[0]) };
    },
    diagnostics: () => ({ ...stats }),
    destroy() {},
  };
}

test('a fuzzy wake-only window still requires AI for the follow-up command', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: fakeStt(),
    intentParser: async () => ({ matched: true, command: 'skip', query: null, confidence: 0.95 }),
  });
  const guildId = 'guild';
  const userId = 'user';
  const key = `${guildId}:${userId}`;
  manager.wakeWindows.set(key, Date.now() + 8_000);
  manager.fuzzyWakeWindows.add(key);
  manager.focuses.set(guildId, {
    token: Symbol('focus'),
    userId,
    expiresAt: Date.now() + 8_000,
    timer: null,
    ducked: false,
    executing: false,
    acceptingFollowup: false,
  });
  let aiInput = null;
  let executed = null;
  manager.parseWithAI = async (_guildId, _userId, text, parsed) => {
    aiInput = { text, parsed };
    return {
      matched: true,
      command: 'skip',
      query: null,
      usedAI: true,
      focusToken: manager.focuses.get(guildId).token,
    };
  };
  manager.handleParsedCommand = async (_guildId, _userId, parsed) => {
    executed = parsed;
  };

  await manager.handleTranscript(guildId, userId, '下一首', {
    enabled: true,
    wakeWords: ['音乐助手'],
    language: 'mixed',
    understandingMode: 'balanced',
    enabledCommands: ['skip'],
  });

  assert.equal(aiInput.parsed.reason, 'fuzzy-wake-needs-ai');
  assert.equal(aiInput.parsed.fuzzyWake, true);
  assert.equal(executed.usedAI, true);
});

test('an AI result cannot execute after its original focus expires', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const guildId = 'guild';
  const userId = 'user';
  const oldToken = Symbol('old-focus');
  manager.focuses.set(guildId, {
    token: oldToken,
    userId,
    expiresAt: Date.now() - 1,
    timer: null,
    ducked: false,
    executing: false,
    acceptingFollowup: false,
  });
  let executed = false;
  manager.executeCommand = async () => { executed = true; };

  await manager.handleParsedCommand(guildId, userId, {
    matched: true,
    command: 'skip',
    query: null,
    usedAI: true,
    focusToken: oldToken,
  }, { enabledCommands: ['skip'] });

  assert.equal(executed, false);
  assert.equal(manager.focuses.has(guildId), false);
});

test('STT keyterms only bias long wake words', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  assert.deepEqual(manager.sttKeyterms({
    wakeWords: ['音乐助手', '曼波', '小音箱'],
    language: 'mixed',
  }), ['音乐助手', '音樂助手']);
});

test('partial transcripts cannot activate focus before the final transcript', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  manager.observeTranscript('guild', 'user', '音乐助手播放童年', {
    wakeWords: ['音乐助手'],
    language: 'mixed',
    understandingMode: 'balanced',
  }, { type: 'transcript-partial' });

  assert.equal(manager.focuses.size, 0);
  assert.equal(manager.wakeWindows.size, 0);
});

test('rejects STT prompt leakage before search or AI classification', async () => {
  const leaked = '音乐助手播放放一下点播暂停停一下继续恢复播放上一首下一首跳过切歌';
  assert.equal(looksLikeSttPromptLeak(leaked), true);
  assert.equal(isSafeVoicePlayQuery('放一下 点播 暂停 停一下 继续 恢复播放 上一首 下一首 跳过 切歌'), false);
  assert.equal(isSafeVoicePlayQuery('罗大佑童年'), true);

  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  let parsed = false;
  manager.handleParsedCommand = async () => { parsed = true; };
  await manager.handleTranscript('guild', 'user', leaked, {
    enabled: true,
    wakeWords: ['音乐助手'],
    language: 'mixed',
    understandingMode: 'balanced',
    enabledCommands: ['play'],
  });

  assert.equal(parsed, false);
  assert.equal(manager.diagnostics('guild').sttStatus.promptLeakRejected, 1);
});

test('only an explicit true enables the listener flag', () => {
  assert.equal(isVoiceListenerEnabled('true'), true);
  assert.equal(isVoiceListenerEnabled('TRUE'), false);
  assert.equal(isVoiceListenerEnabled('1'), false);
  assert.equal(isVoiceListenerEnabled('false'), false);
  assert.equal(isVoiceListenerEnabled('invalid'), false);
  assert.equal(isVoiceListenerEnabled(undefined), false);
});

test('invalid configured provider leaves the manager disabled instead of throwing', () => {
  const previousProvider = process.env.VOICE_STT_PROVIDER;
  process.env.VOICE_STT_PROVIDER = 'invalid-provider';
  try {
    const manager = new VoiceListenerManager({ guilds: { cache: new Map() } });
    assert.equal(manager.stt.configured(), false);
  } finally {
    if (previousProvider === undefined) delete process.env.VOICE_STT_PROVIDER;
    else process.env.VOICE_STT_PROVIDER = previousProvider;
  }
});

test('rejects a listener identity equal to the main Bot identity', () => {
  assert.equal(hasVoiceListenerIdentityConflict('123', '123'), true);
  assert.equal(hasVoiceListenerIdentityConflict('123', '456'), false);
  assert.equal(hasVoiceListenerIdentityConflict('123', null), false);
});

test('uses only the main Bot current voice channel as the listener target', () => {
  assert.equal(mainBotVoiceChannelId({ members: { me: { voice: { channelId: 'current' } } } }), 'current');
  assert.equal(mainBotVoiceChannelId({ members: { me: { voice: { channelId: null } } } }), null);
  assert.equal(mainBotVoiceChannelId({}), null);
});

test('listener connection follows the server toggle but does not require cloud STT consent', () => {
  const listenerGuild = {};
  assert.equal(shouldVoiceListenerJoin({ enabled: true }, 'voice', listenerGuild), true);
  assert.equal(shouldVoiceListenerJoin({ enabled: true, listenerAutoJoin: true }, 'voice', listenerGuild), true);
  assert.equal(shouldVoiceListenerJoin({ enabled: true, listenerAutoJoin: true, cloudSttEnabled: false, consentedUserIds: [] }, 'voice', listenerGuild), true);
  assert.equal(shouldVoiceListenerJoin({ enabled: false, listenerAutoJoin: true }, 'voice', listenerGuild), false);
  assert.equal(shouldVoiceListenerJoin({ enabled: true, listenerAutoJoin: false }, 'voice', listenerGuild), false);
  assert.equal(shouldVoiceListenerJoin({ enabled: false, listenerAutoJoin: false }, 'voice', listenerGuild), false);
  assert.equal(shouldVoiceListenerJoin({ enabled: true }, null, listenerGuild), false);
});

test('fuzzy wake metrics count each wake window once', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const settings = {
    enabled: true,
    wakeWords: ['音乐助手'],
    language: 'mixed',
    understandingMode: 'balanced',
    enabledCommands: ['skip'],
  };
  manager.parseWithAI = async () => null;
  await manager.handleTranscript('guild', 'user', '音樂手下一首', settings);
  await manager.handleTranscript('guild', 'user', '音樂手下一首', settings);
  assert.equal(manager.diagnostics('guild').sttStatus.fuzzyWakeCount, 1);
});

test('late STT results are rejected after operation generation changes', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const controller = new AbortController();
  const operation = manager.createOperationContext('guild', 'user', { enabled: true }, controller.signal);
  let handled = false;
  manager.handleTranscript = async () => { handled = true; };
  manager.invalidateOperation('guild:user');
  await manager.processAudio('guild', 'user', Buffer.alloc(24_000), controller, operation);
  assert.equal(handled, false);
});

test('settings revision rejects late results after disabling voice control', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const controller = new AbortController();
  const operation = manager.createOperationContext('guild', 'user', { enabled: true }, controller.signal);
  manager.settingsRevisionSignatures.set('guild', JSON.stringify({ enabled: false }));
  assert.equal(manager.isOperationCurrent(operation, { requireEnabled: true }), false);
});

test('late command work cannot publish an audit result after its deadline', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const focus = {
    token: Symbol('focus'),
    userId: 'user',
    expiresAt: Date.now() + 1000,
    timer: null,
    hardDeadlineAt: Date.now() + 1000,
    ducked: false,
    executing: false,
    acceptingFollowup: false,
  };
  manager.focuses.set('guild', focus);
  manager.executeCommand = async () => {};
  let audited = false;
  manager.sendAudit = async () => { audited = true; };
  await manager.handleParsedCommand('guild', 'user', {
    matched: true,
    command: 'skip',
    query: null,
    usedAI: false,
  }, { enabled: true, enabledCommands: ['skip'] });
  assert.equal(audited, false);
});

test('AI follow-up keeps its operation context for the command re-check', async () => {
  const previousEnabled = process.env.AI_ENABLED;
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_ENABLED = 'true';
  process.env.AI_API_KEY = 'test-key';
  GuildSettings.update('guild', {
    voiceControl: {
      enabled: true,
      understandingMode: 'balanced',
      enabledCommands: ['skip'],
    },
  });
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const token = Symbol('focus');
  manager.focuses.set('guild', {
    token,
    userId: 'user',
    expiresAt: Date.now() + 5000,
    timer: null,
    hardDeadlineAt: Date.now() + 5000,
    ducked: false,
    executing: false,
    acceptingFollowup: false,
  });
  try {
    manager.intentParser = async () => ({
      matched: true,
      command: 'skip',
      query: null,
      confidence: 0.99,
      evidence: '下一首',
    });
    const result = await manager.parseWithAI('guild', 'user', '下一首', {
      commandText: '下一首',
      fuzzyWake: false,
      usedWakeWindow: true,
    }, GuildSettings.get('guild').voiceControl);
    assert.ok(result.operation);
    assert.equal(manager.isOperationCurrent(result.operation, { requireEnabled: true }), true);
  } finally {
    GuildSettings.update('guild', { voiceControl: { enabled: false } });
    if (previousEnabled === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = previousEnabled;
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
});

test('feedback and audit fall back to the ordinary music text channel', async () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const payloads = [];
  const textChannel = { send: async payload => { payloads.push(payload); } };
  const guild = { channels: { cache: new Map(), fetch: async () => null } };
  manager.mainClient.guilds.cache.set('guild', guild);
  musicQueue.get('guild').textChannel = textChannel;
  try {
    await manager.sendAudit('guild', 'user', 'skip', 'ok');
    await manager.sendUnderstandingFeedback('guild', 'user', '', '未识别');
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].content, /语音命令/);
    assert.match(payloads[1].content, /语音指令未执行/);
    assert.deepEqual(payloads[0].allowedMentions, { users: [], roles: [], parse: [] });
  } finally {
    musicQueue.delete('guild');
  }
});

test('voice command permissions allow every human regardless of legacy mode', () => {
  const member = { id: 'user', user: { bot: false }, roles: { cache: [] } };
  assert.equal(canUseVoiceControl(member, { permissionMode: 'unknown' }), true);
  assert.equal(canUseVoiceControl({ user: { bot: true } }, { permissionMode: 'everyone' }), false);
});

test('voice listener supports everyone STT while preserving opt-out', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const guildId = `listener-consent-${Date.now()}`;
  const userId = '123456789012345678';
  const settings = GuildSettings.get(guildId).voiceControl;
  assert.equal(manager.hasVoiceConsent(guildId, userId, settings), true);

  GuildSettings.update(guildId, {
    voiceControl: {
      cloudSttEnabled: true,
      consentedUserIds: [userId],
    },
  });
  assert.equal(manager.hasVoiceConsent(guildId, userId), true);
  revokeVoiceConsent(guildId, userId);
  manager.revokeUserConsent(guildId, userId);
  assert.equal(manager.hasVoiceConsent(guildId, userId), false);

  GuildSettings.update(guildId, {
    voiceControl: {
      sttAccessMode: 'everyone',
      sttOptOutUserIds: [],
    },
  });
  assert.equal(manager.hasVoiceConsent(guildId, userId), true);
  revokeVoiceConsent(guildId, userId);
  assert.equal(manager.hasVoiceConsent(guildId, userId), false);
});

test('legacy voice command permissions cannot restrict human members', () => {
  const member = { id: 'user', user: { bot: false }, roles: { cache: [] } };
  assert.equal(canUseVoiceControl(member, {
    sttAccessMode: 'everyone',
    permissionMode: 'roles',
    allowedRoleIds: [],
  }), true);
  assert.equal(canUseVoiceControl(member, {
    sttAccessMode: 'everyone',
    permissionMode: 'everyone',
  }), true);
});

test('settings revisions include STT mode and opt-out changes', () => {
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const base = manager.settingsSignature({
    sttAccessMode: 'everyone',
    sttOptOutUserIds: [],
  });
  assert.notEqual(base, manager.settingsSignature({
    sttAccessMode: 'off',
    sttOptOutUserIds: [],
  }));
  assert.notEqual(base, manager.settingsSignature({
    sttAccessMode: 'everyone',
    sttOptOutUserIds: ['123456789012345678'],
  }));
});

test('streaming STT receives buffered PCM through a finite stream that closes', async () => {
  const guildId = `finite-stream-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const received = [];
  let streamClosed = false;
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async audio => {
        const reader = audio.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            streamClosed = true;
            break;
          }
          received.push(Buffer.from(value));
        }
        return { text: '语音助手', language: 'zh' };
      },
    },
  });
  let transcript = null;
  manager.handleTranscript = async (_guildId, _userId, text) => { transcript = text; };
  const pcm = Buffer.alloc(24_000, 1);

  await manager.processAudio(guildId, userId, pcm, new AbortController());

  assert.equal(streamClosed, true);
  assert.deepEqual(Buffer.concat(received), pcm);
  assert.equal(transcript, '语音助手');
  assert.equal(manager.diagnostics(guildId).sttStatus.lastOutcome, 'success');
});

test('recording finalization concatenates decoder chunks before starting STT', async () => {
  const guildId = `buffered-recording-${Date.now()}`;
  const userId = '123456789012345678';
  const key = `${guildId}:${userId}`;
  testGuildSettings(guildId);
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });
  const controller = new AbortController();
  const operation = manager.createOperationContext(guildId, userId, GuildSettings.get(guildId).voiceControl, controller.signal);
  const chunks = [Buffer.alloc(9_600, 1), Buffer.alloc(9_600, 2)];
  let received = null;
  manager.processAudio = async (_guildId, _userId, pcm) => { received = Buffer.from(pcm); };
  const recording = {
    key,
    guildId,
    userId,
    pending: false,
    controller,
    chunks,
    pcmBytes: 19_200,
    pcmChunks: 2,
    inputError: null,
    finalized: false,
    operation,
    maxTimer: null,
  };
  manager.recordings.set(key, recording);

  await manager.finalizeRecording(recording);

  assert.deepEqual(received, Buffer.concat(chunks));
  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.lastAudioDurationMs, 400);
  assert.equal(status.lastAudioBytes, 19_200);
  assert.equal(status.lastAudioChunks, 2);
});

test('recording skips one bad Opus packet and sends later PCM to STT', async () => {
  const guildId = `packet-recovery-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const stream = new PassThrough({ objectMode: true });
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: fakeStt(),
    opusDecoderFactory: () => fakePacketDecoder(),
  });
  let received = null;
  let resolveProcessed;
  const processed = new Promise(resolve => { resolveProcessed = resolve; });
  manager.processAudio = async (_guildId, _userId, pcm) => {
    received = Buffer.from(pcm);
    resolveProcessed();
  };
  const entry = {
    channelId: 'voice',
    connection: { receiver: { subscribe: () => stream } },
  };

  assert.equal(manager.startRecording(guildId, userId, entry, GuildSettings.get(guildId).voiceControl), true);
  stream.write(Buffer.from([1]));
  stream.write(Buffer.from([0xff]));
  stream.end(Buffer.from([2]));
  await processed;

  assert.deepEqual(received, Buffer.concat([Buffer.alloc(9_600, 1), Buffer.alloc(9_600, 2)]));
  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.opusDecoderBackend, 'test-opus');
  assert.equal(status.lastOpusPackets, 3);
  assert.equal(status.lastOpusDecodedPackets, 2);
  assert.equal(status.lastOpusDroppedPackets, 1);
  assert.equal(status.lastOpusError, 'invalid-packet');
});

test('fatal Opus packet failure records decode-error and asks the user to retry', async () => {
  const guildId = `packet-fatal-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const stream = new PassThrough({ objectMode: true });
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: fakeStt(),
    opusDecoderFactory: () => fakePacketDecoder({ fatalOnBad: true }),
  });
  const feedback = [];
  let sttCalls = 0;
  manager.processAudio = async () => { sttCalls += 1; };
  manager.sendUnderstandingFeedback = async (...args) => { feedback.push(args); };
  const entry = {
    channelId: 'voice',
    connection: { receiver: { subscribe: () => stream } },
  };

  assert.equal(manager.startRecording(guildId, userId, entry, GuildSettings.get(guildId).voiceControl), true);
  stream.write(Buffer.from([0xff]));
  await new Promise(resolve => stream.once('close', resolve));
  await new Promise(resolve => setImmediate(resolve));

  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(sttCalls, 0);
  assert.equal(status.lastOutcome, 'decode-error');
  assert.equal(status.lastOutcomeDetail, 'invalid-packet');
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0][3], '收到的语音音频损坏，请再说一次');
});

test('an all-invalid Opus segment becomes decode-error even before error limits', async () => {
  const guildId = `packet-all-invalid-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const stream = new PassThrough({ objectMode: true });
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: fakeStt(),
    opusDecoderFactory: () => fakePacketDecoder(),
  });
  let sttCalls = 0;
  manager.processAudio = async () => { sttCalls += 1; };
  manager.sendUnderstandingFeedback = async () => {};
  const entry = {
    channelId: 'voice',
    connection: { receiver: { subscribe: () => stream } },
  };

  assert.equal(manager.startRecording(guildId, userId, entry, GuildSettings.get(guildId).voiceControl), true);
  stream.end(Buffer.from([0xff]));
  await new Promise(resolve => stream.once('close', resolve));
  await new Promise(resolve => setImmediate(resolve));

  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(sttCalls, 0);
  assert.equal(status.lastOutcome, 'decode-error');
  assert.equal(status.lastOpusPackets, 1);
  assert.equal(status.lastOpusDecodedPackets, 0);
  assert.equal(status.lastOpusDroppedPackets, 1);
});

test('empty STT result records empty and sends the existing understanding feedback', async () => {
  const guildId = `empty-stt-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async audio => {
        for await (const _chunk of audio) {
          // Consume the finite PCM input.
        }
        return { text: '   ', language: null };
      },
    },
  });
  const feedback = [];
  manager.sendUnderstandingFeedback = async (...args) => { feedback.push(args); };

  await manager.processAudio(guildId, userId, Buffer.alloc(24_000), new AbortController());

  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.lastOutcome, 'empty');
  assert.equal(status.lastSuccessAt, null);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0][3], '语音已收到，但没有识别到清晰内容，请再说一次');
});

test('zero and too-short PCM have terminal diagnostics without entering STT', async () => {
  const guildId = `short-pcm-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  let calls = 0;
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      transcribe: async () => {
        calls += 1;
        return { text: 'unexpected', language: null };
      },
    },
  });

  await manager.processAudio(guildId, userId, Buffer.alloc(0), new AbortController());
  let status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.lastOutcome, 'zero-pcm');
  assert.equal(status.lastAudioBytes, 0);
  assert.equal(status.lastAudioChunks, 0);

  await manager.processAudio(guildId, userId, Buffer.alloc(4_800), new AbortController());
  status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.lastOutcome, 'too-short');
  assert.equal(status.lastAudioDurationMs, 100);
  assert.equal(status.lastAudioBytes, 4_800);
  assert.equal(status.lastAudioChunks, 1);
  assert.equal(calls, 0);
});

test('provider input cancellation and ordinary errors have explicit terminal diagnostics', async () => {
  const guildId = `provider-failures-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const cancellingManager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async audio => {
        await audio.cancel(new Error('provider stopped reading'));
        return { text: '', language: null };
      },
    },
  });
  await cancellingManager.processAudio(guildId, userId, Buffer.alloc(24_000), new AbortController());
  assert.equal(cancellingManager.diagnostics(guildId).sttStatus.lastOutcome, 'input-cancelled');

  const errorManager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async () => { throw new Error('provider failed'); },
    },
  });
  await errorManager.processAudio(guildId, userId, Buffer.alloc(24_000), new AbortController());
  const status = errorManager.diagnostics(guildId).sttStatus;
  assert.equal(status.lastOutcome, 'error');
  assert.equal(status.lastError, 'Error');
});

test('provider timeout and external abort are distinguished without abort feedback', async () => {
  const guildId = `abort-stt-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildId);
  const timeoutManager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async () => {
        const error = new Error('STT timeout');
        error.name = 'TimeoutError';
        throw error;
      },
    },
  });
  await timeoutManager.processAudio(guildId, userId, Buffer.alloc(24_000), new AbortController());
  assert.equal(timeoutManager.diagnostics(guildId).sttStatus.lastOutcome, 'timeout');

  const abortManager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: (_audio, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    },
  });
  let feedbackCount = 0;
  abortManager.sendUnderstandingFeedback = async () => { feedbackCount += 1; };
  const controller = new AbortController();
  const processing = abortManager.processAudio(guildId, userId, Buffer.alloc(24_000), controller);
  controller.abort(new DOMException('settings changed', 'AbortError'));
  await processing;

  assert.equal(abortManager.diagnostics(guildId).sttStatus.lastOutcome, 'aborted');
  assert.equal(feedbackCount, 0);
});

test('STT diagnostics are isolated by guild', async () => {
  const guildA = `guild-a-${Date.now()}`;
  const guildB = `guild-b-${Date.now()}`;
  const userId = '123456789012345678';
  testGuildSettings(guildA);
  testGuildSettings(guildB);
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, { stt: fakeStt() });

  await manager.processAudio(guildA, userId, Buffer.alloc(0), new AbortController());
  await manager.processAudio(guildB, userId, Buffer.alloc(4_800), new AbortController());

  assert.equal(manager.diagnostics(guildA).sttStatus.lastOutcome, 'zero-pcm');
  assert.equal(manager.diagnostics(guildA).sttStatus.lastAudioBytes, 0);
  assert.equal(manager.diagnostics(guildB).sttStatus.lastOutcome, 'too-short');
  assert.equal(manager.diagnostics(guildB).sttStatus.lastAudioBytes, 4_800);
});

test('one pending segment is processed after the active STT operation finishes', async () => {
  const guildId = `pending-stt-${Date.now()}`;
  const userId = '123456789012345678';
  const key = `${guildId}:${userId}`;
  testGuildSettings(guildId);
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const manager = new VoiceListenerManager({ guilds: { cache: new Map() } }, {
    stt: {
      ...fakeStt(),
      supportsStreamingInput: () => true,
      transcribeStream: async audio => {
        for await (const _chunk of audio) {
          // Consume the complete finite input before returning.
        }
        calls += 1;
        if (calls === 1) await firstBlocked;
        return { text: `segment-${calls}`, language: null };
      },
    },
  });
  manager.started = true;
  manager.handleTranscript = async () => {};
  const first = manager.processAudio(guildId, userId, Buffer.alloc(24_000), new AbortController());
  await new Promise(resolve => setImmediate(resolve));
  manager.pendingSegments.set(key, {
    guildId,
    userId,
    channelId: null,
    pcm: Buffer.alloc(24_000, 1),
  });
  manager.sttStatusFor(guildId).pendingQueued += 1;
  releaseFirst();
  await first;

  assert.equal(calls, 2);
  assert.equal(manager.pendingSegments.has(key), false);
  const status = manager.diagnostics(guildId).sttStatus;
  assert.equal(status.pendingProcessed, 1);
  assert.equal(status.lastPendingState, 'processed');
});
