import { execFile } from 'child_process';
import { promisify } from 'util';
import { cookieArgs, formatDuration, ytdlpSemaphore } from './shared.js';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
const YTDLP_COMMON = ['--js-runtimes', 'node'];
const YTDLP_AUDIO_FORMAT = 'bestaudio[ext=webm]/bestaudio';
const MAX_PLAYLIST_ITEMS = 100;
const DEFAULT_AUDIO_URL_TTL_MS = 10 * 60 * 1000;
const AUDIO_URL_EXPIRY_BUFFER_MS = 60 * 1000;

function videoUrl(data = {}) {
  const id = videoId(data.webpage_url) || videoId(data.url) || videoId(data.id);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function videoId(value) {
  const text = String(value || '');
  const match = text.match(/(?:v=|youtu\.be\/)?([a-zA-Z0-9_-]{11})(?:\b|$)/);
  return match?.[1] || null;
}

function isPlayableVideo(data = {}) {
  return Boolean(videoUrl(data)) && Number(data.duration) > 0;
}

// 过滤专辑/演唱会曲目里的噪音：cover/reaction/drum/teaser 等，以及过短的片段
const ALBUM_NOISE_RE = /\b(cover|reaction|react|drum\s*(cover|score)|karaoke|busking|teaser|trailer|sneak\s*peek|preview|making|behind the scenes|interview)\b|翻唱|鼓譜|鼓谱|預告|预告|花絮|訪問|访问|搶先|抢先|reaction/i;

function parseDurationSeconds(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '');
  if (/^\d+:\d{2}$/.test(text)) {
    const [m, s] = text.split(':').map(Number);
    return m * 60 + s;
  }
  return Number(text) || 0;
}

function filterAlbumTracks(tracks, limit = 50) {
  if (!Array.isArray(tracks)) return [];
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    if (!track?.title || !track?.url) continue;
    if (ALBUM_NOISE_RE.test(track.title)) continue;
    const seconds = parseDurationSeconds(track.duration);
    if (seconds > 0 && seconds < 45) continue; // 跳过过短的预告/片段
    const id = videoId(track.url);
    const key = id || track.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}

function audioUrl(data = {}) {
  return data.requested_downloads?.[0]?.url || data.url || null;
}

function audioUrlExpiresAt(url) {
  const fallback = Date.now() + DEFAULT_AUDIO_URL_TTL_MS;
  try {
    const expires = Number(new URL(url).searchParams.get('expire'));
    if (Number.isFinite(expires) && expires > 0) {
      return Math.max(Date.now(), expires * 1000 - AUDIO_URL_EXPIRY_BUFFER_MS);
    }
  } catch {
    // Non-URL or unexpected format: keep a conservative short TTL.
  }
  return fallback;
}

export class YouTube {
  static async search(query, limit = 10) {
    try {
      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          ...cookieArgs(),
          `ytsearch${limit}:${query}`,
          '--dump-json',
          '--no-download',
          '--flat-playlist',
        ], EXEC_OPTIONS));
      } finally {
        ytdlpSemaphore.release();
      }

      const results = stdout.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const data = JSON.parse(line);
          if (!isPlayableVideo(data)) return null;
          return {
            title: data.title,
            url: videoUrl(data),
            duration: this.formatDuration(data.duration),
            thumbnail: data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
            author: data.channel || data.uploader || 'Unknown',
            views: data.view_count || 0
          };
        })
        .filter(Boolean);

      return results;
    } catch (error) {
      console.error('YouTube search error:', error.message);
      return [];
    }
  }

  static normalizeUrl(url) {
    const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortUrlMatch) {
      return `https://www.youtube.com/watch?v=${shortUrlMatch[1]}`;
    }
    return url;
  }

  static async getVideoInfo(url) {
    try {
      const normalizedUrl = this.normalizeUrl(url);

      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          ...cookieArgs(),
          normalizedUrl,
          '-f', YTDLP_AUDIO_FORMAT,
          '--dump-json',
          '--no-download',
          '--no-playlist',
        ], EXEC_OPTIONS));
      } finally {
        ytdlpSemaphore.release();
      }

      const data = JSON.parse(stdout.trim());
      if (!isPlayableVideo(data)) return null;

      const directAudioUrl = audioUrl(data);
      return {
        title: data.title,
        url: videoUrl(data),
        audioUrl: directAudioUrl,
        audioUrlExpiresAt: directAudioUrl ? audioUrlExpiresAt(directAudioUrl) : null,
        duration: this.formatDuration(data.duration),
        thumbnail: data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
        author: data.channel || data.uploader || 'Unknown',
        views: data.view_count || 0
      };
    } catch (error) {
      console.error('YouTube video info error:', error.message);
      return null;
    }
  }

  static async getPlaylist(url) {
    try {
      const normalizedUrl = this.normalizeUrl(url);
      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          ...cookieArgs(),
          normalizedUrl,
          '--dump-json',
          '--no-download',
          '--flat-playlist',
        ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }));
      } finally {
        ytdlpSemaphore.release();
      }

      return stdout.trim().split('\n')
        .filter(line => line.trim())
        .slice(0, MAX_PLAYLIST_ITEMS)
        .map(line => {
          const data = JSON.parse(line);
          if (!isPlayableVideo(data)) return null;
          return {
            title: data.title,
            url: videoUrl(data),
            duration: this.formatDuration(data.duration),
            thumbnail: data.thumbnails?.[data.thumbnails.length - 1]?.url || null,
            author: data.channel || data.uploader || 'Unknown'
          };
        })
        .filter(Boolean);
    } catch (error) {
      console.error('YouTube playlist error:', error.message);
      return null;
    }
  }

  // 在 YouTube Music 搜索专辑/演唱会，返回权威曲目表。
  // 策略：优先用搜索结果里的 album/playlist browse URL（VLPL...）展开完整曲目，
  // 失败则回退到搜索页里的单曲结果。
  static async searchAlbum(query, limit = 50) {
    const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
    let entries;
    try {
      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          ...cookieArgs(),
          searchUrl,
          '--dump-json',
          '--no-download',
          '--flat-playlist',
          '--playlist-end', '20',
        ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }));
      } finally {
        ytdlpSemaphore.release();
      }

      entries = stdout.trim().split('\n')
        .filter(line => line.trim().startsWith('{'))
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (error) {
      console.error('YouTube Music album search error:', error.message);
      return null;
    }

    // 找 album/playlist browse URL（VLPL 前缀是播放列表，UC 是频道要跳过）
    const browseEntry = entries.find(entry =>
      entry.ie_key === 'YoutubeTab' && /\/browse\/(VL)?PL/i.test(String(entry.url || ''))
    );

    if (browseEntry?.url) {
      const tracks = await this.getPlaylist(browseEntry.url);
      const filtered = filterAlbumTracks(tracks, limit);
      if (filtered.length > 0) return filtered;
    }

    // 回退：用搜索页里的单曲结果
    const songs = entries
      .filter(entry => (entry.ie_key === 'Youtube' || entry._type === 'url') && videoId(entry.url || entry.id))
      .map(entry => ({
        title: entry.title,
        url: videoUrl({ url: entry.url, id: entry.id }),
        duration: this.formatDuration(entry.duration),
        thumbnail: entry.thumbnails?.[entry.thumbnails.length - 1]?.url || null,
        author: entry.channel || entry.uploader || 'Unknown',
      }))
      .filter(song => song.url && song.title);

    const filtered = filterAlbumTracks(songs, limit);
    return filtered.length > 0 ? filtered : null;
  }

  static isYouTubeUrl(url) {
    const patterns = [
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=.+$/,
      /^(https?:\/\/)?youtu\.be\/.+$/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?list=.+$/
    ];
    return patterns.some(pattern => pattern.test(url));
  }

  static isPlaylist(url) {
    return url.includes('playlist?list=');
  }

  static formatDuration(seconds) {
    return formatDuration(seconds);
  }
}
