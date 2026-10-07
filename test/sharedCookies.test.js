import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieArgs } from '../src/utils/shared.js';

test('yt-dlp cookies stay isolated by platform', () => {
  const originalLegacy = process.env.YTDLP_COOKIE_FILES;
  const originalBilibili = process.env.YTDLP_BILIBILI_COOKIE_FILES;
  const originalYouTube = process.env.YTDLP_YOUTUBE_COOKIE_FILES;

  try {
    process.env.YTDLP_COOKIE_FILES = '/cookies/legacy-bilibili.txt';
    delete process.env.YTDLP_BILIBILI_COOKIE_FILES;
    delete process.env.YTDLP_YOUTUBE_COOKIE_FILES;

    assert.deepEqual(cookieArgs('bilibili'), ['--cookies', '/cookies/legacy-bilibili.txt']);
    assert.deepEqual(cookieArgs('youtube'), []);
    assert.deepEqual(cookieArgs('none'), []);

    process.env.YTDLP_BILIBILI_COOKIE_FILES = '/cookies/bilibili.txt';
    process.env.YTDLP_YOUTUBE_COOKIE_FILES = '/cookies/youtube.txt';
    assert.deepEqual(cookieArgs('bilibili'), ['--cookies', '/cookies/bilibili.txt']);
    assert.deepEqual(cookieArgs('youtube'), ['--cookies', '/cookies/youtube.txt']);
  } finally {
    if (originalLegacy === undefined) delete process.env.YTDLP_COOKIE_FILES;
    else process.env.YTDLP_COOKIE_FILES = originalLegacy;
    if (originalBilibili === undefined) delete process.env.YTDLP_BILIBILI_COOKIE_FILES;
    else process.env.YTDLP_BILIBILI_COOKIE_FILES = originalBilibili;
    if (originalYouTube === undefined) delete process.env.YTDLP_YOUTUBE_COOKIE_FILES;
    else process.env.YTDLP_YOUTUBE_COOKIE_FILES = originalYouTube;
  }
});
