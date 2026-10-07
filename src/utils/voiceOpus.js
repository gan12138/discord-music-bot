import OpusScript from 'opusscript';

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;
const DEFAULT_MAX_TOTAL_ERRORS = 50;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function classifyVoiceOpusError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('invalid packet')) return 'invalid-packet';
  if (message.includes('buffer too small')) return 'buffer-too-small';
  if (message.includes('bad argument')) return 'bad-argument';
  if (message.includes('invalid state')) return 'invalid-decoder-state';
  if (message.includes('memory allocation')) return 'memory-allocation-failed';
  if (message.includes('internal error')) return 'internal-error';
  if (message.includes('unimplemented')) return 'unimplemented';
  return 'unknown-decode-error';
}

export function createVoiceOpusDecoder({
  sampleRate = 24_000,
  channels = 1,
  maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
  maxTotalErrors = DEFAULT_MAX_TOTAL_ERRORS,
  decoderFactory = (rate, channelCount) => new OpusScript(rate, channelCount, OpusScript.Application.AUDIO),
} = {}) {
  const consecutiveLimit = positiveInteger(maxConsecutiveErrors, DEFAULT_MAX_CONSECUTIVE_ERRORS);
  const totalLimit = positiveInteger(maxTotalErrors, DEFAULT_MAX_TOTAL_ERRORS);
  let decoder = decoderFactory(sampleRate, channels);
  let destroyed = false;
  const stats = {
    backend: 'opusscript',
    totalPackets: 0,
    decodedPackets: 0,
    droppedPackets: 0,
    consecutiveErrors: 0,
    lastError: null,
  };

  const failure = reason => {
    stats.droppedPackets += 1;
    stats.consecutiveErrors += 1;
    stats.lastError = reason;
    return {
      ok: false,
      reason,
      fatal: stats.consecutiveErrors >= consecutiveLimit || stats.droppedPackets >= totalLimit,
    };
  };

  return {
    backend: stats.backend,

    decode(packet) {
      if (destroyed) return { ok: false, reason: 'decoder-destroyed', fatal: true };
      stats.totalPackets += 1;
      if (!(Buffer.isBuffer(packet) || packet instanceof Uint8Array)) return failure('invalid-buffer');
      if (packet.byteLength === 0) return failure('empty-packet');
      if (packet.byteLength > OpusScript.MAX_PACKET_SIZE) return failure('oversized-packet');

      try {
        const input = Buffer.isBuffer(packet)
          ? packet
          : Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
        const pcm = decoder.decode(input);
        if (!pcm?.length) return failure('empty-pcm');
        stats.decodedPackets += 1;
        stats.consecutiveErrors = 0;
        return { ok: true, pcm: Buffer.from(pcm) };
      } catch (error) {
        return failure(classifyVoiceOpusError(error));
      }
    },

    diagnostics() {
      return { ...stats };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        decoder?.delete?.();
      } finally {
        decoder = null;
      }
    },
  };
}
