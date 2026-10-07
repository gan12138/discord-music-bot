import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceStt,
  validateSttToken,
  validateSttTokenResponse,
  validateVoiceGatewayUrl,
} from '../src/utils/voiceStt.js';

test('configures Vercel Gateway grok-stt for 24 kHz PCM', () => {
  const stt = createVoiceStt({
    provider: 'vercel-ai-gateway',
    apiKey: 'test-key',
    model: 'grok-stt',
  });

  assert.equal(stt.provider, 'vercel-ai-gateway');
  assert.equal(stt.model, 'xai/grok-stt');
  assert.equal(stt.supportsStreamingInput(), true);
  assert.deepEqual(stt.audioFormat(), {
    type: 'audio/pcm',
    sampleRate: 24_000,
    channels: 1,
    bytesPerSample: 2,
    frameSize: 480,
  });
});

test('keeps OpenAI-compatible transcription on WAV-compatible PCM settings', () => {
  const stt = createVoiceStt({
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'whisper-1',
  });

  assert.equal(stt.provider, 'openai-compatible');
  assert.equal(stt.audioFormat().sampleRate, 48_000);
  assert.equal(stt.supportsStreamingInput(), false);
  assert.equal(stt.configured(), true);
});

test('rejects unknown providers and unsafe Gateway URLs', () => {
  assert.throws(() => createVoiceStt({ provider: 'unknown-provider' }), /Unsupported voice STT provider/);
  assert.throws(() => validateVoiceGatewayUrl('http://example.com'), /public HTTPS URL/);
  assert.throws(() => validateVoiceGatewayUrl('https://127.0.0.1:8080'), /public HTTPS URL/);
  assert.throws(() => validateVoiceGatewayUrl('https://[::1]:8080'), /public HTTPS URL/);
  assert.throws(() => validateVoiceGatewayUrl('https://[::ffff:127.0.0.1]:8080'), /public HTTPS URL/);
  assert.throws(() => validateVoiceGatewayUrl('https://example.com/?token=secret'), /public HTTPS URL/);
  assert.equal(validateVoiceGatewayUrl('https://example.com/v1/'), 'https://example.com/v1');
});

test('accepts the longer client secrets returned by Gateway transcription', () => {
  const token = `vcst_${'a'.repeat(600)}`;
  assert.equal(validateSttToken(token), token);
});

test('allows a root Gateway URL to mint its transcription stream URL', () => {
  const now = Date.now();
  const result = validateSttTokenResponse({
    token: 'vcst_test-token-1234567890',
    url: 'wss://example.com/transcription-model?ai-model-id=xai%2Fgrok-stt',
    expiresAt: now + 60_000,
  }, {
    expectedBaseUrl: 'https://example.com',
    model: 'xai/grok-stt',
    now,
  });
  assert.equal(result.url, 'wss://example.com/transcription-model?ai-model-id=xai%2Fgrok-stt');
});

test('Vercel Gateway PCM helper passes a finite stream to streaming transcription', async () => {
  const stt = createVoiceStt({
    provider: 'vercel-ai-gateway',
    apiKey: 'test-key',
    model: 'grok-stt',
  });
  const pcm = Buffer.alloc(24_000, 1);
  const chunks = [];
  let closed = false;
  stt.transcribeStream = async audio => {
    const reader = audio.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return { text: 'ok', language: null };
  };

  const result = await stt.transcribe(pcm);

  assert.equal(closed, true);
  assert.deepEqual(Buffer.concat(chunks), pcm);
  assert.equal(result.text, 'ok');
});
