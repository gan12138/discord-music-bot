import { getAIConfigStatus, requestAIJson } from './aiClient.js';
import { YouTube } from './youtube.js';

const MAX_ADD_COUNT = 100;
const ALBUM_KINDS = new Set(['album', 'concert', 'live']);
const DEFAULT_NEGATIVE_KEYWORDS = [
  'cover',
  'busking',
  'reaction',
  'karaoke',
  'lyrics only',
  'sped up',
  'slowed',
  'nightcore',
  'news',
  '新聞',
  '新闻',
  'interview',
  'podcast',
];
const NEGATIVE_RE = new RegExp(DEFAULT_NEGATIVE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

function compact(value, limit = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[臺台]/g, '台')
    .replace(/[謙]/g, '谦')
    .replace(/[陳]/g, '陈')
    .replace(/[張]/g, '张')
    .replace(/[聽]/g, '听')
    .replace(/[樂]/g, '乐')
    .replace(/terence\s+lam/g, '林家谦')
    .replace(/eason\s+chan/g, '陈奕迅')
    .replace(/hins\s+cheung/g, '张敬轩')
    .replace(/[\s\-_:|()[\]【】「」『』《》*]+/g, ' ')
    .trim();
}

function unwrapIntent(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.action || result.content || result.targetPlaylist || result.suggestedName) return result;
  for (const key of ['output', 'data', 'result', 'intent', 'plan']) {
    const unwrapped = unwrapIntent(result[key]);
    if (unwrapped) return unwrapped;
  }
  return null;
}

function normalizeStringList(value, limit = 50, itemLimit = 120) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const item of value) {
    const text = compact(item, itemLimit);
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function normalizeIndexes(value) {
  if (!Array.isArray(value)) return [];
  const indexes = value
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item > 0);
  return [...new Set(indexes)];
}

export function normalizeAddCount(count) {
  const value = Number(count) || 20;
  return Math.min(MAX_ADD_COUNT, Math.max(1, Math.trunc(value)));
}

export function getAIPlaylistConfigStatus() {
  return getAIConfigStatus();
}

// ---------- 去重 ----------

function videoIdFromUrl(url) {
  const match = String(url || '').match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] || null;
}

function titleCore(title) {
  return normalizeText(title)
    .replace(/official music video|official video|official audio|lyrics?|mv|hd|4k/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function songKey(song) {
  return normalizeText(`${song?.title || ''} ${song?.author || song?.artist || ''}`);
}

function makeDuplicateState(existingSongs = []) {
  return {
    keys: new Set(existingSongs.map(songKey)),
    urls: new Set(existingSongs.map(song => song.url).filter(Boolean)),
    videoIds: new Set(existingSongs.map(song => videoIdFromUrl(song.url)).filter(Boolean)),
  };
}

function isDuplicateSong(song, state) {
  const key = songKey(song);
  const videoId = videoIdFromUrl(song?.url);
  return !song?.url
    || state.urls.has(song.url)
    || (videoId && state.videoIds.has(videoId))
    || (key && state.keys.has(key));
}

function rememberSong(song, state) {
  const key = songKey(song);
  const videoId = videoIdFromUrl(song?.url);
  if (song?.url) state.urls.add(song.url);
  if (videoId) state.videoIds.add(videoId);
  if (key) state.keys.add(key);
}

// ---------- 第 1 层：意图解析 ----------

const VALID_ACTIONS = ['add', 'create', 'clear', 'remove', 'rename', 'delete'];
const VALID_KINDS = ['album', 'concert', 'live', 'artist_top', 'theme', 'specific', 'none'];

function normalizeIntent(raw, { selectedName, addLimit }) {
  const intent = unwrapIntent(raw);
  if (!intent) return null;

  let action = String(intent.action || '').toLowerCase();
  if (!VALID_ACTIONS.includes(action)) action = 'add';

  const targetPlaylist = selectedName || compact(intent.targetPlaylist || intent.playlist || '', 80) || null;
  const suggestedName = compact(intent.suggestedName || intent.newName || '', 80) || null;

  const rawContent = intent.content && typeof intent.content === 'object' ? intent.content : {};
  let kind = String(rawContent.kind || rawContent.type || 'none').toLowerCase();
  if (!VALID_KINDS.includes(kind)) kind = 'none';

  const content = {
    kind,
    artist: compact(rawContent.artist || '', 80),
    collection: compact(rawContent.collection || rawContent.album || rawContent.concert || '', 120),
    theme: compact(rawContent.theme || rawContent.description || '', 160),
    songTitles: normalizeStringList(rawContent.songTitles || rawContent.songs || rawContent.tracks, 100, 160),
    count: normalizeAddCount(rawContent.count || addLimit),
  };

  return {
    action,
    targetPlaylist,
    suggestedName,
    renameTo: action === 'rename' ? (compact(intent.renameTo || suggestedName || '', 80) || null) : null,
    content,
    remove: {
      byIndexes: normalizeIndexes(intent.remove?.byIndexes),
      byTitleKeywords: normalizeStringList(intent.remove?.byTitleKeywords || intent.remove?.keywords, 50, 80),
    },
    reason: compact(intent.reason || intent.explanation || '', 240),
  };
}

export async function parseAIPlaylistIntent(prompt, { count = 20, playlists = [], selectedName = null } = {}) {
  const addLimit = normalizeAddCount(count);
  const raw = await requestAIJson([
    {
      role: 'system',
      content: 'You translate natural-language music-playlist requests into a compact structured intent. You ONLY classify intent and extract entities (artist, album/concert name, themes, explicit song titles). You do NOT need to recall full tracklists. Return strict JSON only.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'classify_playlist_intent',
        request: prompt,
        addLimit,
        existingPlaylists: playlists.map(p => p.name),
        selectedPlaylist: selectedName,
        rules: [
          selectedName
            ? `The user already selected playlist "${selectedName}". Use it as targetPlaylist.`
            : 'If the request clearly refers to an existing playlist by name, set targetPlaylist to that exact name.',
          'If no target playlist is given but the user wants songs added, set action="create" and put a short natural name in suggestedName derived from the album/concert/artist/theme (e.g. the album or concert name).',
          'action: add (add to existing), create (make new playlist and add), clear (empty it), remove (remove some songs), rename, delete.',
          'content.kind: album/concert/live when the user wants a specific album or concert tracklist; artist_top for an artist\'s popular songs; specific when the user names exact songs; theme for mood/genre/style requests; none if no songs are being added.',
          'For album/concert/live: fill content.artist and content.collection (the album/concert name). Do NOT enumerate the tracklist; the backend fetches it from the music source.',
          'For specific: list the named songs in content.songTitles.',
          'For theme: put the description in content.theme.',
          'remove.byIndexes are 1-based positions; remove.byTitleKeywords are artist/title keywords. Only when user asks to remove.',
        ],
        output: {
          action: 'add|create|clear|remove|rename|delete',
          targetPlaylist: 'existing playlist name or null',
          suggestedName: 'name for a new playlist, or null',
          renameTo: 'new name when action=rename, else null',
          content: {
            kind: 'album|concert|live|artist_top|theme|specific|none',
            artist: 'string',
            collection: 'album or concert name',
            theme: 'mood/genre description',
            songTitles: 'array of explicit song titles',
            count: 'number of songs to add',
          },
          remove: { byIndexes: 'array of 1-based ints', byTitleKeywords: 'array of strings' },
          reason: 'short Chinese explanation',
        },
      }),
    },
  ], { temperature: 0.2 });

  return normalizeIntent(raw, { selectedName, addLimit });
}

// ---------- 第 2 层：内容解析（数据源优先，AI 兜底） ----------

function collect(songs, state, into, limit) {
  for (const song of songs) {
    if (into.songs.length >= limit) break;
    if (!song?.url || !song?.title) continue;
    if (NEGATIVE_RE.test(song.title)) continue;
    if (isDuplicateSong(song, state)) continue;
    into.songs.push(song);
    rememberSong(song, state);
  }
}

async function searchEach(queries, state, into, limit) {
  for (const query of queries) {
    if (into.songs.length >= limit) break;
    const results = await YouTube.search(query, 4);
    const pick = results.find(c => c?.url && c?.title && !NEGATIVE_RE.test(c.title) && !isDuplicateSong(c, state));
    if (pick) {
      into.songs.push(pick);
      rememberSong(pick, state);
    } else {
      into.missing.push({ query });
    }
  }
}

// 让 LLM 兜底列出曲目（标注为推测），仅当数据源失败时使用。
// 用「示例驱动」的提示词，对中转模型更稳定。
async function aiTracklistFallback(content, limit) {
  const desc = [content.artist, content.collection, content.theme].filter(Boolean).join(' ');
  const raw = await requestAIJson([
    {
      role: 'system',
      content: 'You are a music expert. Return ONLY a JSON object with a "songs" array of real, well-known songs formatted as "Artist - Title". Do not invent titles.',
    },
    {
      role: 'user',
      content: `请列出最多 ${limit} 首符合「${desc}」的真实、知名歌曲。返回格式示例：{"songs":["陈奕迅 - 十年","张学友 - 吻别"]}`,
    },
  ], { temperature: 0.3 });
  return normalizeStringList(extractSongList(raw), limit, 160);
}

// 从可能大小写不一/嵌套的 AI 响应里提取歌曲数组
function extractSongList(raw) {
  if (!raw || typeof raw !== 'object') return [];
  for (const key of Object.keys(raw)) {
    if (/^(songs|tracks|list|songlist|results)$/i.test(key) && Array.isArray(raw[key])) {
      return raw[key];
    }
  }
  // 兜底：找到第一个全是字符串的数组
  for (const value of Object.values(raw)) {
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value;
  }
  return [];
}

/**
 * 根据意图的 content 解析出可添加的歌曲列表。
 * 返回 { songs, missing, source } —— source 标注数据来源便于提示用户。
 */
export async function resolveContent(content, existingSongs = [], limit = 20) {
  const addLimit = normalizeAddCount(limit);
  const state = makeDuplicateState(existingSongs);
  const result = { songs: [], missing: [], source: 'search', estimated: false };

  if (!content || content.kind === 'none') return result;

  // 专辑/演唱会/Live：数据源优先
  if (ALBUM_KINDS.has(content.kind)) {
    const query = [content.artist, content.collection].filter(Boolean).join(' ').trim();
    if (query) {
      try {
        const albumTracks = await YouTube.searchAlbum(query, addLimit);
        if (albumTracks && albumTracks.length > 0) {
          result.source = 'music-album';
          collect(albumTracks, state, result, addLimit);
          if (result.songs.length > 0) return result;
        }
      } catch (error) {
        console.error('[AI Playlist] album lookup failed:', error.message);
      }
    }

    // 兜底 1：普通搜索 collection
    if (query) {
      try {
        const searchTracks = await YouTube.search(`${query} live`, addLimit);
        collect(searchTracks, state, result, addLimit);
        if (result.songs.length > 0) {
          result.source = 'search';
          return result;
        }
      } catch (error) {
        console.error('[AI Playlist] album search fallback failed:', error.message);
      }
    }

    // 兜底 2：AI 推测曲目
    const guessed = await aiTracklistFallback(content, addLimit);
    if (guessed.length > 0) {
      result.estimated = true;
      result.source = 'ai-estimated';
      await searchEach(guessed, state, result, addLimit);
    }
    return result;
  }

  // 用户明确点名的歌
  if (content.kind === 'specific' && content.songTitles.length > 0) {
    const queries = content.songTitles.map(t => (content.artist ? `${content.artist} ${t}` : t));
    await searchEach(queries, state, result, addLimit);
    return result;
  }

  // 歌手热门
  if (content.kind === 'artist_top' && content.artist) {
    try {
      const tracks = await YouTube.search(`${content.artist} 热门歌曲`, addLimit);
      collect(tracks, state, result, addLimit);
    } catch (error) {
      console.error('[AI Playlist] artist_top failed:', error.message);
    }
    if (result.songs.length === 0) {
      const guessed = await aiTracklistFallback(content, addLimit);
      result.estimated = true;
      await searchEach(guessed, state, result, addLimit);
    }
    return result;
  }

  // 主题/风格/混合：LLM 生成候选歌名（它擅长推荐），再逐首搜
  if (content.kind === 'theme' || content.songTitles.length > 0) {
    const queries = content.songTitles.length > 0
      ? content.songTitles
      : await aiTracklistFallback(content, addLimit);
    if (content.songTitles.length === 0) result.estimated = true;
    await searchEach(queries, state, result, addLimit);
    return result;
  }

  return result;
}

// ---------- 移除歌曲 ----------

export function findSongsToRemove(songs, remove = {}) {
  const ids = new Set();
  for (const index of remove.byIndexes || []) {
    const song = songs[index - 1];
    if (song?.id) ids.add(song.id);
  }

  const keywords = (remove.byTitleKeywords || []).map(normalizeText).filter(Boolean);
  if (keywords.length > 0) {
    for (const song of songs) {
      const haystack = normalizeText(`${song.title || ''} ${song.author || ''}`);
      if (keywords.some(keyword => haystack.includes(keyword))) ids.add(song.id);
    }
  }

  return songs.filter(song => ids.has(song.id));
}
