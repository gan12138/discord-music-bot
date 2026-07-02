const LIVE_TOKENS = ['live', 'concert', 'performance', '现场', '演唱会', '音乐节'];
const NORMAL_TOKENS = ['official audio', 'official music video', 'studio version', 'mv', '官方'];

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

export function versionPreferenceLabel(preference = 'any') {
  return {
    any: '不限制',
    live: '尽量 Live / 现场版',
    normal: '尽量普通 / 官方版',
  }[preference] || '不限制';
}

export function normalizeVersionPreference(preference) {
  return ['any', 'live', 'normal'].includes(preference) ? preference : null;
}

export function applyVersionPreferenceToQuery(query, preference = 'any') {
  if (preference === 'live') return `${query} live concert 现场 演唱会`;
  if (preference === 'normal') return `${query} official audio official music video`;
  return query;
}

export function versionNegativeKeywords(preference = 'any') {
  if (preference === 'normal') return LIVE_TOKENS;
  return [];
}

export function scoreVersionPreference(song, preference = 'any') {
  if (preference === 'any') return 0;
  const text = normalizeText(`${song?.title || ''} ${song?.author || ''}`);
  const liveScore = LIVE_TOKENS.some(token => text.includes(normalizeText(token))) ? 2 : 0;
  const normalScore = NORMAL_TOKENS.some(token => text.includes(normalizeText(token))) ? 1 : 0;
  return preference === 'live' ? liveScore : normalScore - liveScore;
}

export function sortByVersionPreference(songs, preference = 'any') {
  if (preference === 'any') return songs;
  return [...songs].sort((a, b) => scoreVersionPreference(b, preference) - scoreVersionPreference(a, preference));
}
