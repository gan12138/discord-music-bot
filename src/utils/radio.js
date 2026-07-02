import { YouTube } from './youtube.js';
import { requestAIJson } from './aiClient.js';
import {
  applyVersionPreferenceToQuery,
  sortByVersionPreference,
  versionNegativeKeywords,
} from './versionPreference.js';

const DEFAULT_RADIO_BATCH_SIZE = 5;
const RADIO_QUEUE_TARGET_SIZE = 5;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 15 * 60;
const MAX_SAME_AUTHOR_PER_BATCH = 2;
const GENERATION_WAIT_MS = 15_000;
const RADIO_DEBUG = process.env.RADIO_DEBUG === '1';

function isRadioAIEnabled() {
  return process.env.RADIO_AI_ENABLED === 'true';
}

const GENRE_LABELS = {
  mandopop: '华语流行',
  cantopop: '粤语流行',
  pop: '欧美流行',
  kpop: 'K-pop',
  jpop: 'J-pop',
  rock: '摇滚',
  hiphop: '嘻哈',
  rnb: 'R&B',
  edm: 'EDM',
  lofi: 'Lo-fi',
  jazz: '爵士',
  anime: '动漫',
};

const LANGUAGE_LABELS = {
  chinese: '中文',
  cantonese: '粤语',
  english: '英文',
  japanese: '日文',
  korean: '韩文',
};

const MOOD_LABELS = {
  chill: '放松',
  happy: '开心',
  sad: '伤感',
  party: '派对',
  focus: '专注',
  romantic: '浪漫',
  energetic: '热血',
};

const ENGLISH_GENRE_SEARCH_LABELS = {
  pop: 'western pop',
  rock: 'rock',
  hiphop: 'hip hop',
  rnb: 'r&b',
  edm: 'edm',
  lofi: 'lofi',
  jazz: 'jazz',
};

const ENGLISH_LANGUAGE_SEARCH_LABELS = {
  english: 'english',
};

const DEFAULT_NEGATIVE_KEYWORDS = [
  'reaction',
  'karaoke',
  'instrumental',
  'lyrics only',
  'cover',
  'sped up',
  'slowed',
  'nightcore',
  'interview',
  'news',
  'cnn',
  'talk show',
  'podcast',
  'documentary',
  'trailer',
  'teaser',
  'behind the scenes',
  '訪問',
  '访问',
  '專訪',
  '专访',
  '新聞',
  '新闻',
  '八卦',
  '娛樂',
  '娱乐',
  '節目',
  '节目',
  '綜藝',
  '综艺',
  '花絮',
  '預告',
  '预告',
  '直樂',
  '講到明',
  '讲到明',
  '有冇諗過',
  '确认',
  '確認',
];

const VERSION_TITLE_KEYWORDS = [
  'official music video',
  'official video',
  'official audio',
  'official mv',
  'music video',
  'lyric video',
  'lyrics',
  'lyric',
  'mv',
  'hd',
  '4k',
  '1080p',
  '720p',
  'audio',
  'full version',
  '完整版',
  '完整板',
  '官方',
  '歌詞',
  '歌词',
  'lyrics video',
  'english lyrics',
  'chinese lyrics',
  '中英歌詞',
  '中英歌词',
  '歌詞版',
  '歌词版',
  '歌詞同步',
  '歌词同步',
  '動態歌詞',
  '动态歌词',
  '中英字幕',
  '中字',
  '拼音',
  'pinyin',
  'jyutping',
  'romanized',
  'romanised',
  '粵語拼音',
  '粤语拼音',
  '拼音字幕',
  '粵拼字幕',
  '粤拼字幕',
  'cantonese song',
  'canto pop',
  'cantopop',
  'english',
  'cover',
  '翻唱',
  'remix',
  '混音',
  'live',
  '現場',
  '现场',
  '演唱會',
  '演唱会',
  '搖滾版',
  '摇滚版',
  'version',
  '版',
];

const NON_MUSIC_AUTHOR_KEYWORDS = [
  'cnn',
  'news',
  'media',
  'moreforms',
  '魔方全媒',
  'viutv',
  'tvb',
  '娛樂',
  '娱乐',
  '新聞',
  '新闻',
];

const MUSIC_SIGNAL_KEYWORDS = [
  'official music video',
  'official mv',
  'official audio',
  'music video',
  'lyric video',
  'lyrics',
  'mv',
  'audio',
  'live',
  'performance',
  'topic',
  '歌詞',
  '歌词',
  '官方',
  '音樂',
  '音乐',
  '演唱會',
  '演唱会',
  '現場',
  '现场',
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[臺台]/g, '台')
    .replace(/[倫]/g, '伦')
    .replace(/[詞]/g, '词')
    .replace(/[聽]/g, '听')
    .replace(/[樂]/g, '乐')
    .replace(/[與]/g, '与')
    .replace(/[無]/g, '无')
    .replace(/[會]/g, '会')
    .replace(/[現]/g, '现')
    .replace(/[\s\-_:|()[\]【】「」『』《》]+/g, ' ')
    .trim();
}

function parseDurationSeconds(duration) {
  if (!duration || typeof duration !== 'string') return null;
  const parts = duration.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function songKey(song) {
  return normalizeText(`${song.title} ${song.author || ''}`);
}

function videoIdFromUrl(url) {
  const match = String(url || '').match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] || null;
}

function titleCore(title) {
  return normalizeText(title)
    .replace(/official music video|official video|official audio|lyrics?|mv|hd|4k/g, '')
    .trim();
}

function stripVersionText(value) {
  let text = normalizeText(value)
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|「[^」]*」|『[^』]*』|《[^》]*》/g, ' ');

  for (const keyword of VERSION_TITLE_KEYWORDS) {
    text = text.replaceAll(normalizeText(keyword), ' ');
  }

  return text
    .replace(/\b(jay chou|周杰伦)\b/g, '周杰伦')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(value) {
  return stripVersionText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !/^\d+$/.test(token));
}

function songFingerprint(song = {}) {
  const title = stripVersionText(song.title || '');
  const author = stripVersionText(song.author || '')
    .replace(/\s*-\s*topic$/i, '')
    .trim();

  const tokens = meaningfulTokens(title)
    .filter(token => !author || !author.includes(token));
  const compactTitle = tokens.join(' ') || title;
  if (!compactTitle) return null;
  return `${author}|${compactTitle}`.replace(/\s+/g, ' ').trim();
}

function sameSongByTitle(a = {}, b = {}) {
  const aTitle = stripVersionText(a.title || '');
  const bTitle = stripVersionText(b.title || '');
  if (!aTitle || !bTitle) return false;

  const aTokens = new Set(meaningfulTokens(aTitle));
  const bTokens = new Set(meaningfulTokens(bTitle));
  const shared = [...aTokens].filter(token => bTokens.has(token));
  if (shared.length === 0) return false;

  const shorterSize = Math.min(aTokens.size, bTokens.size);
  if (shorterSize > 0 && shared.length / shorterSize >= 0.8) return true;

  const aCjkTokens = cjkCoreTokens(a.title || '');
  const bCjkTokens = cjkCoreTokens(b.title || '');
  return aCjkTokens.some(token => bCjkTokens.some(other => other.includes(token) || token.includes(other)));
}

function cjkCoreTokens(value) {
  return meaningfulTokens(value)
    .filter(token => /[\u4e00-\u9fff]/.test(token) && token.length >= 3);
}

function looksLikeNonMusicVideo(song) {
  const title = normalizeText(song.title);
  const author = normalizeText(song.author || '');
  const hasMusicSignal = MUSIC_SIGNAL_KEYWORDS.some(keyword => title.includes(normalizeText(keyword)) || author.includes(normalizeText(keyword)));
  const hasNonMusicAuthor = NON_MUSIC_AUTHOR_KEYWORDS.some(keyword => author.includes(normalizeText(keyword)));
  const hasNewsLikeTitle = /[?？]/.test(song.title || '') || title.length > 80;

  if (hasNonMusicAuthor && !hasMusicSignal) return true;
  if (hasNewsLikeTitle && !hasMusicSignal) return true;
  return false;
}

function isUsableRadioSeed(song) {
  if (!song?.title || !song?.url) return false;
  const durationSeconds = parseDurationSeconds(song.duration);
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) return false;
  if (looksLikeNonMusicVideo(song)) return false;
  return true;
}

function pickRadioSeed(serverQueue) {
  const candidates = [
    serverQueue.radio?.seedSong,
    serverQueue.currentSong,
    ...(serverQueue.history || []).slice().reverse(),
  ].filter(Boolean);

  return candidates.find(isUsableRadioSeed) || null;
}

export function refreshRadioSeed(serverQueue) {
  if (!serverQueue?.radio) return null;
  const seed = pickRadioSeed(serverQueue) || serverQueue.history?.at(-1) || serverQueue.currentSong || null;
  serverQueue.radio.seedSong = seed;
  return seed;
}

function buildExcludedSongs(serverQueue, seedSong) {
  return [
    serverQueue.currentSong,
    seedSong,
    ...(serverQueue.history || []),
    ...(serverQueue.songs || []),
    ...(serverQueue.radioQueue || []),
  ].filter(Boolean);
}

function buildHardExcludedSongs(serverQueue, seedSong) {
  return [
    serverQueue.currentSong,
    seedSong,
    ...(serverQueue.songs || []),
    ...(serverQueue.radioQueue || []),
  ].filter(Boolean);
}

function buildRelaxedExcludedSongs(serverQueue, seedSong) {
  return [
    serverQueue.currentSong,
    seedSong,
    ...(serverQueue.history || []).slice(-50),
    ...(serverQueue.songs || []),
    ...(serverQueue.radioQueue || []),
  ].filter(Boolean);
}

function recentTrackStrings(history, limit = 8) {
  return history.slice(-limit).map(song => `${song.title}${song.author ? ` - ${song.author}` : ''}`);
}

function fallbackInferStyle(history) {
  const text = normalizeText(recentTrackStrings(history, 5).join(' '));
  const matchers = [
    { genre: 'cantopop', language: 'cantonese', tokens: ['陈奕迅', '张学友', 'beyond', '容祖儿', '粤语', 'eason', 'jacky cheung'] },
    { genre: 'mandopop', language: 'chinese', tokens: ['周杰伦', '林俊杰', '五月天', '王力宏', 'jay chou', 'jj lin', 'mayday'] },
    { genre: 'kpop', language: 'korean', tokens: ['bts', 'blackpink', 'newjeans', 'twice', 'ive', 'kpop'] },
    { genre: 'jpop', language: 'japanese', tokens: ['yoasobi', 'aimer', '米津', 'lisa', 'jpop'] },
    { genre: 'lofi', tokens: ['lofi', 'chill beats', 'study beats'] },
    { genre: 'edm', tokens: ['edm', 'alan walker', 'marshmello', 'avicii'] },
    { genre: 'rock', tokens: ['rock', 'metal', '摇滚'] },
  ];

  const style = {};
  for (const matcher of matchers) {
    if (matcher.tokens.some(token => text.includes(normalizeText(token)))) {
      Object.assign(style, matcher);
      delete style.tokens;
      break;
    }
  }

  if (text.includes('90s') || text.includes('90年代')) style.era = '90s';
  if (text.includes('2000s') || text.includes('2000年代')) style.era = '2000s';
  if (text.includes('sad') || text.includes('伤感') || text.includes('失恋')) style.mood = 'sad';
  if (text.includes('party') || text.includes('dance') || text.includes('派对')) style.mood = 'party';
  if (text.includes('chill') || text.includes('放松')) style.mood = 'chill';

  return Object.keys(style).length > 0 ? style : null;
}

function hasExplicitStyle(style = {}) {
  return Boolean(style.genre || style.era || style.language || style.mood);
}

function prefersEnglishQueries(style = {}) {
  return style.genre === 'pop' || style.language === 'english';
}

function genreSearchLabel(style = {}) {
  if (prefersEnglishQueries(style)) {
    return ENGLISH_GENRE_SEARCH_LABELS[style.genre] || style.genre;
  }
  return GENRE_LABELS[style.genre] || style.genre;
}

function languageSearchLabel(style = {}) {
  if (prefersEnglishQueries(style)) {
    return ENGLISH_LANGUAGE_SEARCH_LABELS[style.language] || style.language;
  }
  return LANGUAGE_LABELS[style.language] || style.language;
}

function styleTermSets(style = {}) {
  const terms = styleSearchTerms(style);
  const genre = genreSearchLabel(style);
  const language = languageSearchLabel(style);
  const englishTerms = [style.era, style.genre, style.language, style.mood].filter(Boolean);

  return {
    terms,
    broadTerms: [language, genre].filter(Boolean),
    englishTerms,
  };
}

function styleQueries(style = {}) {
  const { terms, broadTerms, englishTerms } = styleTermSets(style);
  const joined = terms.join(' ');
  const broad = broadTerms.join(' ');
  const english = englishTerms.join(' ');
  const queries = [];

  if (joined) {
    queries.push(`${joined} official music video`);
    queries.push(`${joined} official audio`);
    if (prefersEnglishQueries(style)) {
      queries.push(`${joined} songs`);
      queries.push(`${joined} hits`);
    } else {
      queries.push(`${joined} 歌曲`);
      queries.push(`${joined} MV`);
    }
  }
  if (broad && broad !== joined) {
    queries.push(`${broad} official music video`);
    queries.push(prefersEnglishQueries(style) ? `${broad} songs` : `${broad} 歌曲`);
  }
  if (english) {
    queries.push(`${english} songs`);
    queries.push(`${english} pop music`);
  }
  if (style.genre === 'cantopop' || style.language === 'cantonese') {
    queries.push('香港 粤语 流行 歌曲');
    queries.push('Cantonese pop official music video');
  }

  return [...new Set(queries.map(query => query.trim()).filter(Boolean))];
}

function relaxedStyleQueries(style = {}) {
  const relaxed = { ...style, era: null, mood: null };
  return styleQueries(relaxed);
}

function fallbackQueries(style = {}, seedSong = null, history = []) {
  const terms = [
    style.era,
    languageSearchLabel(style),
    genreSearchLabel(style),
    MOOD_LABELS[style.mood] || style.mood,
  ].filter(Boolean);

  if (hasExplicitStyle(style)) {
    return styleQueries(style);
  }

  const queries = [];
  if (seedSong?.title) {
    queries.push(`${seedSong.title} ${seedSong.author || ''} 类似歌曲`);
    queries.push(`${seedSong.title} similar songs`);
  }

  // 从 history 中随机取几首不同的歌作为额外种子，增加查询多样性
  const recentHistory = (history || []).slice(-30);
  const extraSeeds = recentHistory
    .filter(s => s.title !== seedSong?.title)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  for (const song of extraSeeds) {
    queries.push(`${song.title} ${song.author || ''} 类似歌曲`);
  }

  if (terms.length > 0) {
    queries.push(`${terms.join(' ')} 歌曲`);
    queries.push(`${terms.join(' ')} playlist`);
  }
  if (queries.length === 0) {
    queries.push('popular music playlist', 'trending songs');
  }
  return queries;
}

function styleSearchTerms(style = {}) {
  return [
    style.era,
    languageSearchLabel(style),
    genreSearchLabel(style),
    MOOD_LABELS[style.mood] || style.mood,
  ].filter(Boolean);
}

function looksBroadQuery(query) {
  const text = normalizeText(query);
  const words = text.split(' ').filter(Boolean);
  const hasSongSignal = /official|music video|mv|audio|lyrics?|歌詞|歌词|歌曲|完整版|現場|现场|live/.test(text);
  return words.length <= 3 && !hasSongSignal;
}

function expandRadioQueries(queries, style = {}) {
  const expanded = [];
  const styleTerms = styleSearchTerms(style).join(' ');
  const englishQueries = prefersEnglishQueries(style);

  for (const query of queries.filter(Boolean)) {
    expanded.push(query);
    if (looksBroadQuery(query)) {
      expanded.push(`${query} official music video`);
      expanded.push(`${query} official audio`);
      expanded.push(englishQueries ? `${query} songs` : `${query} 歌曲`);
    }
  }

  if (styleTerms) {
    expanded.push(`${styleTerms} official music video`);
    expanded.push(`${styleTerms} official audio`);
    expanded.push(englishQueries ? `${styleTerms} hits` : `${styleTerms} 新歌 MV`);
  }

  return [...new Set(expanded.map(query => query.trim()).filter(Boolean))];
}

async function searchRadioCandidates(queries, count, versionPreference) {
  const candidates = [];
  for (const query of queries.slice(0, 10)) {
    const results = await YouTube.search(applyVersionPreferenceToQuery(query, versionPreference), 10);
    candidates.push(...results);
    if (candidates.length >= count * 8) break;
  }
  return candidates;
}

async function aiInferStyle(history, currentStyle) {
  if (history.length < 3) return null;

  const result = await requestAIJson([
    {
      role: 'system',
      content: 'You infer music style from recent tracks. Return strict JSON only. Use compact enum-like values when possible.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'infer_music_style',
        recentTracks: history.slice(-5).map(song => ({
          title: song.title,
          author: song.author,
          source: song.source || 'unknown',
        })),
        currentStyle,
        rules: [
          'Only set shouldSwitch true if the recent batch consistently indicates a style change.',
          'A single inserted song should not switch the radio style.',
          'Return { style: { genre, era, language, mood }, confidence, shouldSwitch, reason }.',
        ],
      }),
    },
  ], { temperature: 0.2 });

  if (!result?.style || typeof result.confidence !== 'number') return null;
  return result;
}

async function aiQueries(style, seedSong, history, versionPreference = 'any') {
  const result = await requestAIJson([
    {
      role: 'system',
      content: 'You create YouTube music search queries for a Discord music bot. Return strict JSON only.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'generate_music_search_queries',
        style,
        versionPreference,
        seedSong: seedSong ? { title: seedSong.title, author: seedSong.author } : null,
        recentTracks: recentTrackStrings(history),
        avoid: history.slice(-50).map(song => song.title),
        rules: [
          'Do not include the seed track itself.',
          'Do not include alternate uploads, lyric videos, live/remix/cover versions, translations, or collaborations of the seed track.',
          'Only target individual songs, official music videos, official audio, lyric videos, or live music performances.',
          'Each query must include a specific artist plus a specific song title whenever possible.',
          'Do not return artist names by themselves, channel names, playlists, mixes, albums, or generic genre-only queries.',
          'Avoid near-duplicate versions, lyric videos, covers, karaoke, remixes, sped up, slowed, or reactions unless explicitly requested.',
          'Exclude interviews, news, gossip, variety shows, talk shows, podcasts, documentaries, trailers, behind-the-scenes clips, and TV segments.',
          'Avoid recommending more than 1-2 songs by the same artist in one batch.',
          'Prefer adjacent artists and similar style songs over multiple songs from the same artist.',
          'Use artist plus song title when possible, not just artist names.',
          'If versionPreference is live, prefer live/concert/performance versions.',
          'If versionPreference is normal, prefer official audio/music video/studio versions and avoid live/concert/performance.',
        ],
        output: {
          queries: 'array of 4 to 6 concise YouTube search queries',
          negativeKeywords: 'array of bad-result keywords',
          reason: 'short explanation',
        },
      }),
    },
  ]);

  if (!Array.isArray(result?.queries) || result.queries.length === 0) return null;
  return {
    queries: result.queries.filter(Boolean).slice(0, 6),
    negativeKeywords: Array.isArray(result.negativeKeywords) ? result.negativeKeywords : DEFAULT_NEGATIVE_KEYWORDS,
  };
}

function filterCandidates(candidates, excludedSongs, negativeKeywords = DEFAULT_NEGATIVE_KEYWORDS, versionPreference = 'any', options = {}) {
  const {
    relaxed = false,
    maxSameAuthor = MAX_SAME_AUTHOR_PER_BATCH,
    enforceVersionBlocks = true,
    hardExcludedSongs = [],
  } = options;
  const seen = new Set(excludedSongs.map(songKey));
  const seenVideoIds = new Set(excludedSongs.map(song => videoIdFromUrl(song.url)).filter(Boolean));
  const seenTitleCores = new Set(relaxed ? [] : excludedSongs.map(song => titleCore(song.title)).filter(Boolean));
  const seenFingerprints = new Set(relaxed ? [] : excludedSongs.map(songFingerprint).filter(Boolean));
  const authorCounts = new Map();
  const filtered = [];
  const blockedVersionKeywords = enforceVersionBlocks ? versionNegativeKeywords(versionPreference).map(normalizeText) : [];

  for (const song of candidates) {
    const key = songKey(song);
    const title = normalizeText(song.title);
    const core = titleCore(song.title);
    const fingerprint = songFingerprint(song);
    const videoId = videoIdFromUrl(song.url);
    const author = normalizeText(song.author || 'unknown');
    const durationSeconds = parseDurationSeconds(song.duration);

    if (!song?.url || !song?.title || seen.has(key)) continue;
    if (!videoId) continue;
    if (videoId && seenVideoIds.has(videoId)) continue;
    if (!relaxed && core && seenTitleCores.has(core)) continue;
    if (!relaxed && fingerprint && seenFingerprints.has(fingerprint)) continue;
    if (!relaxed && [...seenTitleCores].some(existing => existing && core && (existing.includes(core) || core.includes(existing)))) continue;
    if (hardExcludedSongs.some(existing => sameSongByTitle(existing, song))) continue;
    if (!relaxed && excludedSongs.some(existing => sameSongByTitle(existing, song))) continue;
    if (filtered.some(existing => sameSongByTitle(existing, song))) continue;
    if (filtered.some(existing => songKey(existing) === key)) continue;
    if (!durationSeconds || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) continue;
    if (negativeKeywords.some(keyword => title.includes(normalizeText(keyword)))) continue;
    if (looksLikeNonMusicVideo(song)) continue;
    if (blockedVersionKeywords.some(keyword => title.includes(keyword))) continue;
    if ((authorCounts.get(author) || 0) >= maxSameAuthor) continue;

    seen.add(key);
    if (videoId) seenVideoIds.add(videoId);
    if (core) seenTitleCores.add(core);
    if (fingerprint) seenFingerprints.add(fingerprint);
    authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
    filtered.push({ ...song, requestedBy: '自动续播', source: 'radio' });
  }

  return sortByVersionPreference(filtered, versionPreference);
}

function fallbackPlayableCandidates(candidates, serverQueue, count, versionPreference = 'any') {
  const hardExcludedSongs = buildHardExcludedSongs(serverQueue, serverQueue.radio?.seedSong || null);
  const recentHistory = (serverQueue.history || []).slice(-10);
  const currentVideoId = videoIdFromUrl(serverQueue.currentSong?.url);
  const queuedVideoIds = new Set([
    ...(serverQueue.songs || []),
    ...(serverQueue.radioQueue || []),
  ].map(song => videoIdFromUrl(song.url)).filter(Boolean));
  const recentVideoIds = new Set(recentHistory.map(song => videoIdFromUrl(song.url)).filter(Boolean));
  const seen = new Set();
  const playable = [];

  for (const song of candidates) {
    const videoId = videoIdFromUrl(song?.url);
    const durationSeconds = parseDurationSeconds(song?.duration);
    const key = songKey(song);
    const title = normalizeText(song?.title);

    if (!song?.title || !song?.url || !videoId) continue;
    if (videoId === currentVideoId || queuedVideoIds.has(videoId)) continue;
    if (recentVideoIds.has(videoId)) continue;
    if (seen.has(videoId) || seen.has(key)) continue;
    if (hardExcludedSongs.some(existing => sameSongByTitle(existing, song))) continue;
    if (recentHistory.some(existing => sameSongByTitle(existing, song))) continue;
    if (playable.some(existing => sameSongByTitle(existing, song))) continue;
    if (!durationSeconds || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) continue;
    if (looksLikeNonMusicVideo(song)) continue;
    if (['reaction', 'karaoke', 'interview', 'podcast', 'documentary', 'news', '新聞', '新闻'].some(keyword => title.includes(normalizeText(keyword)))) continue;

    seen.add(videoId);
    seen.add(key);
    playable.push({ ...song, requestedBy: '自动续播', source: 'radio', fallback: true });
    if (playable.length >= count) break;
  }

  return sortByVersionPreference(playable, versionPreference);
}

export function describeStyle(style = {}) {
  const parts = [
    GENRE_LABELS[style.genre] || style.genre,
    style.era,
    LANGUAGE_LABELS[style.language] || style.language,
    MOOD_LABELS[style.mood] || style.mood,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '根据当前歌曲自动推荐';
}

const AUTODETECT_COOLDOWN_MS = 3 * 60 * 1000;

export async function maybeApplyAutodetect(serverQueue) {
  if (!serverQueue.radio?.enabled || !serverQueue.radio?.autodetect) return false;
  const history = serverQueue.history || [];
  if (history.length < 3) return false;

  // 冷却检查：至少间隔 3 分钟
  const now = Date.now();
  if (serverQueue.radio._lastAutodetectAt && now - serverQueue.radio._lastAutodetectAt < AUTODETECT_COOLDOWN_MS) {
    return false;
  }

  const aiResult = await aiInferStyle(history, serverQueue.radio.currentStyle);
  serverQueue.radio._lastAutodetectAt = now;
  let nextStyle = null;
  let shouldSwitch = false;

  if (aiResult?.shouldSwitch && aiResult.confidence >= 0.75) {
    nextStyle = aiResult.style;
    shouldSwitch = true;
  } else if (!aiResult) {
    nextStyle = fallbackInferStyle(history);
    shouldSwitch = Boolean(nextStyle?.genre && nextStyle.genre !== serverQueue.radio.currentStyle?.genre);
  }

  if (!shouldSwitch || !nextStyle) return false;
  serverQueue.radio.currentStyle = { ...serverQueue.radio.currentStyle, ...nextStyle };
  serverQueue.radioQueue = [];
  return true;
}

const AI_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export async function generateRadioSongs(serverQueue, count = DEFAULT_RADIO_BATCH_SIZE) {
  if (!serverQueue.radio?.enabled) return [];
  if (serverQueue.radio.isGenerating) {
    const before = serverQueue.radioQueue.length;
    if (serverQueue.radio._generatingPromise) {
      await Promise.race([
        serverQueue.radio._generatingPromise,
        new Promise(resolve => setTimeout(resolve, GENERATION_WAIT_MS)),
      ]);
    }
    const generatedByExistingTask = serverQueue.radioQueue.slice(before);
    if (serverQueue.radio.isGenerating && generatedByExistingTask.length === 0) {
      serverQueue.radio.lastGeneration = {
        at: Date.now(),
        status: 'already-generating',
        queueSize: serverQueue.radioQueue.length,
      };
    }
    return generatedByExistingTask;
  }
  serverQueue.radio.isGenerating = true;
  let resolveGenerating;
  serverQueue.radio._generatingPromise = new Promise(resolve => { resolveGenerating = resolve; });

  try {
    const style = serverQueue.radio.currentStyle || {};
    const versionPreference = serverQueue.versionPreference || 'any';
    const seedSong = pickRadioSeed(serverQueue);
    const history = serverQueue.history || [];

    // AI 失败后 5 分钟内直接走 fallback，不浪费请求
    const radioAIEnabled = isRadioAIEnabled();
    const aiCoolingDown = serverQueue.radio._lastAIFailureAt &&
      Date.now() - serverQueue.radio._lastAIFailureAt < AI_RETRY_COOLDOWN_MS;
    const aiPlan = radioAIEnabled && !aiCoolingDown ? await aiQueries(style, seedSong, history, versionPreference) : null;
    if (radioAIEnabled && !aiPlan && !aiCoolingDown) {
      serverQueue.radio._lastAIFailureAt = Date.now();
    }
    if (aiPlan) {
      serverQueue.radio._lastAIFailureAt = null;
    }

    const queries = expandRadioQueries(aiPlan?.queries?.length ? aiPlan.queries : fallbackQueries(style, seedSong, history), style);
    const negativeKeywords = aiPlan?.negativeKeywords?.length ? [...DEFAULT_NEGATIVE_KEYWORDS, ...aiPlan.negativeKeywords] : DEFAULT_NEGATIVE_KEYWORDS;

    const excludedSongs = buildExcludedSongs(serverQueue, seedSong);
    if (RADIO_DEBUG) {
      console.log('[Radio] mode:', aiPlan ? 'ai' : 'fallback', 'radioAI:', radioAIEnabled, 'style:', describeStyle(style), 'version:', versionPreference);
      console.log('[Radio] queries:', queries.slice(0, 8));
    }

    const diagnostics = {
      at: Date.now(),
      status: 'running',
      mode: aiPlan ? 'ai' : 'fallback',
      radioAI: radioAIEnabled,
      style: describeStyle(style),
      versionPreference,
      seedTitle: seedSong?.title || null,
      queryCount: queries.length,
      candidates: 0,
      strictSongs: 0,
      fallbackCandidates: 0,
      fallbackSongs: 0,
      relaxedSongs: 0,
      playableFallbackSongs: 0,
      generatedSongs: 0,
    };

    const candidates = await searchRadioCandidates(queries, count, versionPreference);
    diagnostics.candidates = candidates.length;
    let songs = filterCandidates(candidates, excludedSongs, negativeKeywords, versionPreference).slice(0, count);
    diagnostics.strictSongs = songs.length;
    if (RADIO_DEBUG) console.log('[Radio] candidates:', candidates.length, 'strict songs:', songs.length);

    let fallbackCandidates = [];

    if (songs.length === 0) {
      const fallback = expandRadioQueries(
        hasExplicitStyle(style) ? relaxedStyleQueries(style) : fallbackQueries(style, seedSong, history),
        style
      );
      if (RADIO_DEBUG) console.log('[Radio] retry fallback queries:', fallback.slice(0, 8));
      fallbackCandidates = await searchRadioCandidates(fallback, count, versionPreference);
      diagnostics.fallbackCandidates = fallbackCandidates.length;
      songs = filterCandidates(fallbackCandidates, excludedSongs, DEFAULT_NEGATIVE_KEYWORDS, versionPreference).slice(0, count);
      diagnostics.fallbackSongs = songs.length;
      if (RADIO_DEBUG) console.log('[Radio] fallback candidates:', fallbackCandidates.length, 'strict songs:', songs.length);
    }

    if (songs.length === 0) {
      const relaxedCandidates = fallbackCandidates.length > 0 ? fallbackCandidates : candidates;
      songs = filterCandidates(
        relaxedCandidates,
        buildRelaxedExcludedSongs(serverQueue, seedSong),
        DEFAULT_NEGATIVE_KEYWORDS,
        versionPreference,
        {
          relaxed: true,
          maxSameAuthor: 3,
          enforceVersionBlocks: false,
          hardExcludedSongs: buildHardExcludedSongs(serverQueue, seedSong),
        }
      ).slice(0, count);
      diagnostics.relaxedSongs = songs.length;
      if (RADIO_DEBUG) console.log('[Radio] relaxed songs:', songs.length);
    }

    if (songs.length === 0) {
      songs = fallbackPlayableCandidates(
        [...fallbackCandidates, ...candidates],
        serverQueue,
        count,
        versionPreference
      );
      diagnostics.playableFallbackSongs = songs.length;
      if (RADIO_DEBUG) console.log('[Radio] playable fallback songs:', songs.length);
    }

    if (RADIO_DEBUG) console.log('[Radio] generated songs:', songs.length);
    serverQueue.radio.lastGeneratedAt = Date.now();
    diagnostics.status = songs.length > 0 ? 'generated' : 'empty';
    diagnostics.generatedSongs = songs.length;
    serverQueue.radio.lastGeneration = diagnostics;
    console.log(`[Radio] status=${diagnostics.status} generated=${songs.length} candidates=${diagnostics.candidates} strict=${diagnostics.strictSongs} fallback=${diagnostics.fallbackSongs} relaxed=${diagnostics.relaxedSongs} playable=${diagnostics.playableFallbackSongs} style="${diagnostics.style}" version=${versionPreference} seed="${diagnostics.seedTitle || ''}"`);
    // 动态轮转 seedSong，让下一次生成使用不同的种子歌搜索
    if (songs.length > 0) {
      serverQueue.radio.seedSong = serverQueue.currentSong || serverQueue.history?.at(-1) || songs[0];
    }
    serverQueue.radioQueue.push(...songs);
    return songs;
  } finally {
    serverQueue.radio.isGenerating = false;
    serverQueue.radio._generatingPromise = null;
    resolveGenerating();
  }
}

export async function ensureRadioQueue(serverQueue, targetSize = RADIO_QUEUE_TARGET_SIZE) {
  if (!serverQueue.radio?.enabled) return 0;
  if (serverQueue.pausedByEmptyChannel) return 0;
  if (serverQueue.radioQueue.length >= targetSize) return serverQueue.radioQueue.length;

  const before = serverQueue.radioQueue.length;
  for (let attempt = 0; attempt < 3 && serverQueue.radioQueue.length < targetSize; attempt++) {
    const needed = Math.max(targetSize - serverQueue.radioQueue.length, DEFAULT_RADIO_BATCH_SIZE);
    const songs = await generateRadioSongs(serverQueue, needed);
    if (songs.length === 0 && RADIO_DEBUG) console.log('[Radio] refill attempt produced no songs:', attempt + 1);
    if (songs.length === 0 && serverQueue.radio.isGenerating) break;
  }

  return serverQueue.radioQueue.length - before;
}
