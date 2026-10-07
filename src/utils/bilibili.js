import { execFile } from 'child_process';
import { promisify } from 'util';
import { BILIBILI_USER_AGENT, cookieArgs, formatDuration, ytdlpSemaphore } from './shared.js';
import {
  isAllowedResolvedAudioUrl,
  isBilibiliInput,
  normalizeBilibiliInput,
  parseBilibiliInput,
  redactExternalError,
} from './urlAllowlist.js';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
const YTDLP_COMMON = ['--js-runtimes', 'node'];
const BILIBILI_REFERER = 'https://www.bilibili.com';
const DEFAULT_AUDIO_URL_TTL_MS = 10 * 60 * 1000;
const AUDIO_URL_EXPIRY_BUFFER_MS = 60 * 1000;

function describeBilibiliError(message = '') {
  const lower = message.toLowerCase();
  if (lower.includes('http error 412') || lower.includes('precondition failed')) {
    return 'Bilibili 返回 412 风控/反爬，建议配置有效的 YTDLP_COOKIE_FILES cookies 文件后重试';
  }
  if (lower.includes('login') || lower.includes('cookie')) {
    return 'Bilibili 可能需要登录 cookies，请配置 YTDLP_COOKIE_FILES';
  }
  if (lower.includes('private') || lower.includes('unavailable')) {
    return '这个 Bilibili 视频当前不可用或无权限访问';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return '获取 Bilibili 视频信息超时，请稍后重试';
  }
  return 'Bilibili 视频解析失败，请稍后再试';
}

function bilibiliUrl(data = {}) {
  const value = String(data.webpage_url || data.original_url || data.url || '');
  const normalized = normalizeBilibiliInput(value);
  return normalized || value || null;
}

function audioUrl(data = {}) {
  const requested = [
    ...(Array.isArray(data.requested_downloads) ? data.requested_downloads : []),
    ...(Array.isArray(data.requested_formats) ? data.requested_formats : []),
  ].find(format => format?.url && format.vcodec === 'none');
  if (isAllowedResolvedAudioUrl(requested?.url, 'bilibili')) return requested.url;

  const audioFormats = Array.isArray(data.formats)
    ? data.formats.filter(format => format?.url && format.vcodec === 'none')
    : [];
  audioFormats.sort((a, b) => (Number(b.abr || b.tbr) || 0) - (Number(a.abr || a.tbr) || 0));
  return isAllowedResolvedAudioUrl(audioFormats[0]?.url, 'bilibili') ? audioFormats[0].url : null;
}

function audioUrlExpiresAt(url) {
  const fallback = Date.now() + DEFAULT_AUDIO_URL_TTL_MS;
  try {
    const deadline = Number(new URL(url).searchParams.get('deadline'));
    if (Number.isFinite(deadline) && deadline > 0) {
      return Math.max(Date.now(), deadline * 1000 - AUDIO_URL_EXPIRY_BUFFER_MS);
    }
  } catch {
    // Keep a conservative short TTL for unexpected URL shapes.
  }
  return fallback;
}

export class Bilibili {
  static isBilibiliInput(input) {
    return isBilibiliInput(input);
  }

  static normalizeInput(input) {
    return normalizeBilibiliInput(input);
  }

  static async getVideoInfo(input, { signal } = {}) {
    try {
      const parsed = parseBilibiliInput(input);
      if (!parsed) return null;
      const normalizedUrl = parsed.canonicalUrl;
      await ytdlpSemaphore.acquire(signal);
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          ...cookieArgs('bilibili'),
          '--referer', BILIBILI_REFERER,
          '--user-agent', BILIBILI_USER_AGENT,
          normalizedUrl,
          '--dump-json',
          '--no-download',
          '--no-playlist',
        ], { ...EXEC_OPTIONS, signal, killSignal: 'SIGKILL' }));
      } finally {
        ytdlpSemaphore.release();
      }

      const data = JSON.parse(stdout.trim());
      if (!data.title || !bilibiliUrl(data)) return null;

      const directAudioUrl = audioUrl(data);
      return {
        title: data.title,
        url: bilibiliUrl(data),
        audioUrl: directAudioUrl,
        audioUrlExpiresAt: directAudioUrl ? audioUrlExpiresAt(directAudioUrl) : null,
        duration: this.formatDuration(data.duration),
        thumbnail: data.thumbnail || data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
        author: data.uploader || data.channel || data.creator || 'Unknown',
        views: data.view_count || 0,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      console.error('Bilibili video info error:', redactExternalError(error));
      throw new Error(describeBilibiliError(error.message));
    }
  }

  static formatDuration(seconds) {
    return formatDuration(seconds);
  }
}
