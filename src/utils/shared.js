export const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function cookieArgs() {
  const files = String(process.env.YTDLP_COOKIE_FILES || '')
    .split(',')
    .map(file => file.trim())
    .filter(Boolean);
  return files.length > 0 ? ['--cookies', files[0]] : [];
}

export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    await new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    if (this.current > 0) this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

export const ytdlpSemaphore = new Semaphore(Math.max(1, Number(process.env.YTDLP_MAX_CONCURRENT) || 6));
