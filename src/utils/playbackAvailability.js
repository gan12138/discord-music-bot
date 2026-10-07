import { parseYouTubeUrl, parseBilibiliInput } from './urlAllowlist.js';

export function playbackSourceKey(song) {
  const url = typeof song === 'string' ? song : song?.url;
  const youtube = parseYouTubeUrl(url, { allowPlaylist: false });
  if (youtube?.videoId) return `youtube:${youtube.videoId}`;
  const bilibili = parseBilibiliInput(url);
  return bilibili ? `bilibili:${bilibili.canonicalUrl || bilibili.id}` : null;
}

export class PlaybackAvailability {
  constructor({ now = Date.now, capacity = 1000 } = {}) {
    this.now = now;
    this.capacity = capacity;
    this.entries = new Map();
  }

  failure(song, backend, category, { exhausted = false } = {}) {
    if (['backend-unavailable', 'environment', 'process-crash', 'recovery-deadline'].includes(category)) return;
    const key = playbackSourceKey(song);
    if (!key) return;
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(key) || { paths: {}, failures: 0, retryAfter: 0 };
    entry.paths[backend] = { category, failedAt: now };
    if (exhausted) {
      entry.failures += 1;
      const ttl = category === 'content-restricted' ? 24 * 60 * 60_000
        : Math.min(60 * 60_000, 10 * 60_000 * (2 ** Math.min(3, entry.failures - 1)));
      entry.retryAfter = now + ttl;
    }
    entry.expiresAt = Math.max(now + 24 * 60 * 60_000, entry.retryAfter);
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
  }

  success(song, backend) {
    const entry = this.entries.get(playbackSourceKey(song));
    if (!entry) return;
    entry.retryAfter = 0;
    entry.failures = 0;
    delete entry.paths[backend];
  }

  isCoolingDown(song) {
    return (this.entries.get(playbackSourceKey(song))?.retryAfter || 0) > this.now();
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export const playbackAvailability = new PlaybackAvailability();
