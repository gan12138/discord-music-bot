import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const BUNDLED_FFMPEG_URL = new URL('../../node_modules/ffmpeg-static/ffmpeg', import.meta.url);

let cachedFfmpegPath = null;

function runVersionOutput(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const result = spawnSync(path, ['-version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout || ''}\n${result.stderr || ''}`;
  } catch {
    return null;
  }
}

export function validateFfmpeg(path) {
  const output = runVersionOutput(path);
  return Boolean(output && output.includes('--enable-libopus'));
}

export function ffmpegVersion(path) {
  const output = runVersionOutput(path);
  if (!output) return null;
  const match = /version\s+([^\s]+)/i.exec(output);
  return match ? match[1] : null;
}

export function resolveFfmpegCandidates() {
  const candidates = [];
  const seen = new Set();
  const push = path => {
    if (typeof path === 'string' && path && !seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };

  if (process.env.FFMPEG_BIN) push(process.env.FFMPEG_BIN);
  push('/usr/bin/ffmpeg');
  push('/usr/local/bin/ffmpeg');
  push('ffmpeg');
  push(fileURLToPath(BUNDLED_FFMPEG_URL));
  return candidates;
}

export function resolveFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  for (const candidate of resolveFfmpegCandidates()) {
    if (validateFfmpeg(candidate)) {
      process.env.FFMPEG_BIN = candidate;
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }
  throw new Error('没有可用的 ffmpeg（需 --enable-libopus）');
}
