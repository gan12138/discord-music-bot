import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFfmpegCandidates, validateFfmpeg, ffmpegVersion } from '../src/utils/ffmpeg.js';

test('ffmpeg candidates prefer an explicit FFMPEG_BIN override first', () => {
  const previous = process.env.FFMPEG_BIN;
  process.env.FFMPEG_BIN = '/custom/ffmpeg';
  try {
    assert.equal(resolveFfmpegCandidates()[0], '/custom/ffmpeg');
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = previous;
  }
});

test('validateFfmpeg rejects a nonexistent binary', () => {
  assert.equal(validateFfmpeg('/nonexistent/ffmpeg-xyz'), false);
  assert.equal(ffmpegVersion('/nonexistent/ffmpeg-xyz'), null);
});
