import test from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { classifyVoiceOpusError, createVoiceOpusDecoder } from '../src/utils/voiceOpus.js';

test('voice Opus decoder skips one invalid packet and continues decoding', () => {
  const encoder = new OpusScript(24_000, 1, OpusScript.Application.AUDIO);
  const decoder = createVoiceOpusDecoder();
  try {
    const goodPacket = encoder.encode(Buffer.alloc(960), 480);
    const first = decoder.decode(goodPacket);
    const bad = decoder.decode(Buffer.from([0xff]));
    const third = decoder.decode(goodPacket);

    assert.equal(first.ok, true);
    assert.equal(first.pcm.length, 960);
    assert.deepEqual(bad, { ok: false, reason: 'invalid-packet', fatal: false });
    assert.equal(third.ok, true);
    assert.equal(third.pcm.length, 960);
    assert.deepEqual(decoder.diagnostics(), {
      backend: 'opusscript',
      totalPackets: 3,
      decodedPackets: 2,
      droppedPackets: 1,
      consecutiveErrors: 0,
      lastError: 'invalid-packet',
    });
  } finally {
    decoder.destroy();
    encoder.delete();
  }
});

test('voice Opus decoder stops a segment after consecutive invalid packets', () => {
  const decoder = createVoiceOpusDecoder({ maxConsecutiveErrors: 2 });
  try {
    assert.deepEqual(decoder.decode(Buffer.alloc(0)), {
      ok: false,
      reason: 'empty-packet',
      fatal: false,
    });
    assert.deepEqual(decoder.decode(Buffer.alloc(0)), {
      ok: false,
      reason: 'empty-packet',
      fatal: true,
    });
  } finally {
    decoder.destroy();
  }
});

test('voice Opus decoder also enforces the total invalid packet limit', () => {
  const decoder = createVoiceOpusDecoder({
    maxConsecutiveErrors: 10,
    maxTotalErrors: 2,
    decoderFactory: () => ({
      decode(packet) {
        if (packet[0] === 0xff) throw new Error('Decode error: Invalid packet');
        return Buffer.alloc(960);
      },
      delete() {},
    }),
  });
  try {
    assert.equal(decoder.decode(Buffer.from([0xff])).fatal, false);
    assert.equal(decoder.decode(Buffer.from([1])).ok, true);
    assert.equal(decoder.decode(Buffer.from([0xff])).fatal, true);
  } finally {
    decoder.destroy();
  }
});

test('voice Opus decoder validates packet shape and cleans up once', () => {
  let deletes = 0;
  const decoder = createVoiceOpusDecoder({
    decoderFactory: () => ({
      decode: () => Buffer.alloc(960),
      delete: () => { deletes += 1; },
    }),
  });

  assert.equal(decoder.decode('not-a-buffer').reason, 'invalid-buffer');
  assert.equal(decoder.decode(Buffer.alloc(OpusScript.MAX_PACKET_SIZE + 1)).reason, 'oversized-packet');
  decoder.destroy();
  decoder.destroy();

  assert.equal(deletes, 1);
  assert.deepEqual(decoder.decode(Buffer.from([1])), {
    ok: false,
    reason: 'decoder-destroyed',
    fatal: true,
  });
});

test('voice Opus decoder errors have stable diagnostic categories', () => {
  assert.equal(classifyVoiceOpusError(new Error('Decode error: Invalid packet')), 'invalid-packet');
  assert.equal(classifyVoiceOpusError(new Error('Decode error: Buffer too small')), 'buffer-too-small');
  assert.equal(classifyVoiceOpusError(new Error('unexpected')), 'unknown-decode-error');
});
