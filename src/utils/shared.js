export const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function firstCookieFile(...envValues) {
  for (const value of envValues) {
    const files = String(value || '')
      .split(',')
      .map(file => file.trim())
      .filter(Boolean);
    if (files.length > 0) return files[0];
  }
  return null;
}

/**
 * 按目标站点选择 yt-dlp cookies，避免把某个平台的登录 cookies 发给其它平台。
 * kind='bilibili'：YTDLP_BILIBILI_COOKIE_FILES，缺省回落到旧版 YTDLP_COOKIE_FILES。
 * kind='youtube'：仅 YTDLP_YOUTUBE_COOKIE_FILES（不回退，防止 B 站 cookies 泄露给 Google）。
 * 其它/缺省 kind：沿用旧版 YTDLP_COOKIE_FILES 行为，兼容未更新的调用点。
 */
export function cookieArgs(kind = null) {
  let file = null;
  if (kind === 'bilibili') {
    file = firstCookieFile(process.env.YTDLP_BILIBILI_COOKIE_FILES, process.env.YTDLP_COOKIE_FILES);
  } else if (kind === 'youtube') {
    file = firstCookieFile(process.env.YTDLP_YOUTUBE_COOKIE_FILES);
  } else if (!kind) {
    file = firstCookieFile(process.env.YTDLP_COOKIE_FILES);
  }
  return file ? ['--cookies', file] : [];
}

export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.current < this.max) {
      this.current++;
      return;
    }

    await new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        },
      };
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason || new Error('Semaphore wait aborted'));
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  release() {
    if (this.current > 0) this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next.resolve();
    }
  }
}

export const ytdlpSemaphore = new Semaphore(Math.max(1, Number(process.env.YTDLP_MAX_CONCURRENT) || 6));
