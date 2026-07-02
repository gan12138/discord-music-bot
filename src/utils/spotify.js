import { execFile } from 'child_process';
import { promisify } from 'util';
import { ytdlpSemaphore } from './shared.js';

const execFileAsync = promisify(execFile);
const MAX_SPOTIFY_ITEMS = 50;
const CONVERT_CONCURRENCY = 3;
const YTDLP_COMMON = ['--js-runtimes', 'node'];

export class SpotifyHandler {
  static isSpotifyUrl(url) {
    const patterns = [
      /^https?:\/\/open\.spotify\.com\/track\/.+$/,
      /^https?:\/\/open\.spotify\.com\/album\/.+$/,
      /^https?:\/\/open\.spotify\.com\/playlist\/.+$/
    ];
    return patterns.some(pattern => pattern.test(url));
  }

  static async getTrack(url) {
    try {
      // 用 yt-dlp 获取 Spotify 曲目元数据
      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          url,
          '--dump-json',
          '--no-download',
          '--flat-playlist',
        ], { timeout: 15000 }));
      } finally {
        ytdlpSemaphore.release();
      }

      const data = JSON.parse(stdout.trim());
      return {
        title: data.title || data.track,
        artist: data.artist || data.uploader || '',
        searchQuery: `${data.title || data.track} ${data.artist || data.uploader || ''}`
      };
    } catch (error) {
      console.error('Spotify track error:', error.message);
      // 回退：从 URL 中无法获取信息时返回 null
      return null;
    }
  }

  static async _getCollection(url, label = 'collection') {
    try {
      await ytdlpSemaphore.acquire();
      let stdout;
      try {
        ({ stdout } = await execFileAsync('yt-dlp', [
          ...YTDLP_COMMON,
          url,
          '--dump-json',
          '--no-download',
          '--flat-playlist',
        ], { timeout: 30000 }));
      } finally {
        ytdlpSemaphore.release();
      }

      return stdout.trim().split('\n')
        .filter(line => line.trim())
        .slice(0, MAX_SPOTIFY_ITEMS)
        .map(line => {
          const data = JSON.parse(line);
          return {
            title: data.title || data.track,
            artist: data.artist || data.uploader || '',
            searchQuery: `${data.title || data.track} ${data.artist || data.uploader || ''}`
          };
        });
    } catch (error) {
      console.error(`Spotify ${label} error:`, error.message);
      return null;
    }
  }

  static async getAlbum(url) {
    return this._getCollection(url, 'album');
  }

  static async getPlaylist(url) {
    return this._getCollection(url, 'playlist');
  }

  static async convertToYouTube(spotifyData) {
    const { YouTube } = await import('./youtube.js');

    if (Array.isArray(spotifyData)) {
      const items = spotifyData.slice(0, MAX_SPOTIFY_ITEMS);
      const results = new Array(items.length).fill(null);
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < items.length) {
          const i = nextIndex++;
          const searchResults = await YouTube.search(items[i].searchQuery, 1);
          if (searchResults.length > 0) {
            results[i] = searchResults[0];
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONVERT_CONCURRENCY, items.length) }, worker));
      return results.filter(Boolean);
    } else {
      const searchResults = await YouTube.search(spotifyData.searchQuery, 1);
      return searchResults.length > 0 ? searchResults[0] : null;
    }
  }
}
