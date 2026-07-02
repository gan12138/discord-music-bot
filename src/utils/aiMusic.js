import { YouTube } from './youtube.js';
import { isAIEnabled, requestAIJson } from './aiClient.js';
import {
  applyVersionPreferenceToQuery,
  sortByVersionPreference,
  versionNegativeKeywords,
} from './versionPreference.js';

const DEFAULT_NEGATIVE_KEYWORDS = [
  'reaction',
  'cover',
  'karaoke',
  'lyrics only',
  'sped up',
  'slowed',
  'nightcore',
];

const RADIO_STYLE_VALUES = {
  genre: new Set(['mandopop', 'cantopop', 'pop', 'kpop', 'jpop', 'rock', 'hiphop', 'rnb', 'edm', 'lofi', 'jazz', 'anime']),
  era: new Set(['70s', '80s', '90s', '2000s', '2010s', '2020s', 'latest']),
  language: new Set(['chinese', 'cantonese', 'english', 'japanese', 'korean']),
  mood: new Set(['chill', 'happy', 'sad', 'party', 'focus', 'romantic', 'energetic']),
};

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_:|()[\]【】「」『』《》]+/g, ' ').trim();
}

function normalizeRadioStyle(style = {}) {
  if (!style || typeof style !== 'object') return null;
  const normalized = {};
  for (const [key, allowedValues] of Object.entries(RADIO_STYLE_VALUES)) {
    const value = String(style[key] || '').trim().toLowerCase();
    if (allowedValues.has(value)) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function unwrapAIPlan(result) {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.songs) || Array.isArray(result.queries) || Array.isArray(result.searchQueries)) return result;
  for (const key of ['output', 'data', 'result', 'plan']) {
    if (result[key] && typeof result[key] === 'object') {
      const unwrapped = unwrapAIPlan(result[key]);
      if (unwrapped) return unwrapped;
    }
  }
  return null;
}

function normalizeQueries(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).slice(0, 6);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeSongSuggestions(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const songs = [];
  for (const item of value) {
    let title = '';
    let artist = '';
    if (typeof item === 'string') {
      title = item.trim();
    } else if (item && typeof item === 'object') {
      title = String(item.title || item.song || item.name || '').trim();
      artist = String(item.artist || item.singer || item.author || '').trim();
    }

    const key = normalizeText(`${artist} ${title}`);
    if (!title || seen.has(key)) continue;
    seen.add(key);
    songs.push({ title, artist });
  }

  return songs.slice(0, 6);
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
    .replace(/\s+/g, ' ')
    .trim();
}

function suggestedSongQuery(song) {
  return [song.artist, song.title, 'official audio'].filter(Boolean).join(' ');
}

function filterSongs(songs, negativeKeywords, preference) {
  const seen = new Set();
  const seenVideoIds = new Set();
  const seenTitleCores = new Set();
  const blocked = [...negativeKeywords, ...versionNegativeKeywords(preference)].map(normalizeText);
  const filtered = [];

  for (const song of songs) {
    if (!song?.title || !song?.url) continue;
    const key = songKey(song);
    const videoId = videoIdFromUrl(song.url);
    const title = normalizeText(song.title);
    const core = titleCore(song.title);
    if (seen.has(key)) continue;
    if (videoId && seenVideoIds.has(videoId)) continue;
    if (core && seenTitleCores.has(core)) continue;
    if (blocked.some(keyword => keyword && title.includes(keyword))) continue;
    seen.add(key);
    if (videoId) seenVideoIds.add(videoId);
    if (core) seenTitleCores.add(core);
    filtered.push(song);
  }

  return sortByVersionPreference(filtered, preference);
}

async function createAIPlan(prompt, preference) {
  if (!isAIEnabled()) return null;

  const result = await requestAIJson([
    {
      role: 'system',
      content: 'You are a music DJ for a Discord bot. Convert natural language music requests into distinct real song recommendations. Return strict JSON only.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'natural_language_music_request',
        request: prompt,
        versionPreference: preference,
        rules: [
          'Return 4 to 6 different real songs, each with title and artist.',
          'Do not return multiple versions, uploads, live/studio variants, remixes, or translations of the same song as separate songs.',
          'Prefer real songs and artists over playlists unless the user explicitly asks for a long mix.',
          'Do not include covers, reactions, karaoke, lyric-only videos unless explicitly requested.',
          'If versionPreference is live, prefer live/concert/performance versions.',
          'If versionPreference is normal, prefer official audio/music video/studio versions and avoid live/concert.',
          'Also infer radioStyle for follow-up autoplay from the user request.',
          'radioStyle.genre must be one of: mandopop, cantopop, pop, kpop, jpop, rock, hiphop, rnb, edm, lofi, jazz, anime.',
          'radioStyle.era must be one of: 70s, 80s, 90s, 2000s, 2010s, 2020s, latest.',
          'radioStyle.language must be one of: chinese, cantonese, english, japanese, korean.',
          'radioStyle.mood must be one of: chill, happy, sad, party, focus, romantic, energetic.',
          'Omit radioStyle fields that are not clearly implied.',
        ],
        output: {
          songs: 'array of objects: { title: string, artist: string }',
          negativeKeywords: 'array of strings',
          radioStyle: 'object with optional genre, era, language, mood enum values',
          reason: 'short Chinese explanation',
        },
      }),
    },
  ], { temperature: 0.5 });

  const plan = unwrapAIPlan(result);
  const songs = normalizeSongSuggestions(plan?.songs || plan?.tracks || plan?.recommendations);
  const queries = normalizeQueries(plan?.queries || plan?.searchQueries);
  if (songs.length === 0 && queries.length === 0) {
    console.warn('[AI Music] AI response did not contain usable songs or queries');
    return null;
  }
  return {
    songs,
    queries,
    negativeKeywords: Array.isArray(plan.negativeKeywords) ? plan.negativeKeywords : [],
    radioStyle: normalizeRadioStyle(plan.radioStyle || plan.style),
    reason: plan.reason || plan.explanation || '',
  };
}

export async function findAIMusic(prompt, { preference = 'any', limit = 3 } = {}) {
  const plan = await createAIPlan(prompt, preference);
  const songSuggestions = plan?.songs?.length ? plan.songs : [];
  const queries = songSuggestions.length > 0
    ? songSuggestions.map(suggestedSongQuery)
    : (plan?.queries?.length ? plan.queries : [prompt]);
  const negativeKeywords = [
    ...DEFAULT_NEGATIVE_KEYWORDS,
    ...(plan?.negativeKeywords || []),
  ];
  const candidates = [];

  for (const query of queries.slice(0, 6)) {
    const adjustedQuery = applyVersionPreferenceToQuery(query, preference);
    const results = await YouTube.search(adjustedQuery, songSuggestions.length > 0 ? 1 : 4);
    candidates.push(...results);
    if (filterSongs(candidates, negativeKeywords, preference).length >= limit) break;
  }

  return {
    songs: filterSongs(candidates, negativeKeywords, preference).slice(0, limit),
    reason: plan?.reason || (plan ? '' : 'AI 未启用或请求失败，已使用普通搜索。'),
    radioStyle: plan?.radioStyle || null,
    usedAI: Boolean(plan),
  };
}
