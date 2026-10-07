const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const BILIBILI_BV_RE = /^BV[A-Za-z0-9]{10}$/;
const BILIBILI_AV_RE = /^av\d{1,20}$/i;
const B23_TOKEN_RE = /^[A-Za-z0-9]{4,64}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);

function parseHttpsUrl(value, hosts) {
  const text = String(value || '').trim();
  if (!text || text.length > 2048 || CONTROL_CHAR_RE.test(text) || text.startsWith('//')) return null;

  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)
    ? text
    : `https://${text}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || !hosts.has(parsed.hostname.toLowerCase())
  ) {
    return null;
  }

  return parsed;
}

function onlyAllowedQueryKeys(url, allowedKeys) {
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function canonicalYouTubeVideo(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function parseYouTubeUrl(value, { allowPlaylist = true, allowBrowse = true } = {}) {
  const parsed = parseHttpsUrl(value, YOUTUBE_HOSTS);
  if (!parsed || !onlyAllowedQueryKeys(parsed, new Set([
    'v', 'list', 't', 'start', 'end', 'si', 'index', 'feature', 'pp', 'ab_channel',
  ]))) return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '') || '/';

  if (host === 'youtu.be') {
    const match = path.match(/^\/([A-Za-z0-9_-]{11})$/);
    if (!match || !YOUTUBE_VIDEO_ID_RE.test(match[1])) return null;
    return { kind: 'video', videoId: match[1], canonicalUrl: canonicalYouTubeVideo(match[1]) };
  }

  if (path === '/watch') {
    const videoId = parsed.searchParams.get('v');
    if (!YOUTUBE_VIDEO_ID_RE.test(videoId || '')) return null;
    return { kind: 'video', videoId, canonicalUrl: canonicalYouTubeVideo(videoId) };
  }

  if (allowPlaylist && path === '/playlist') {
    const playlistId = parsed.searchParams.get('list');
    if (!YOUTUBE_PLAYLIST_ID_RE.test(playlistId || '')) return null;
    return {
      kind: 'playlist',
      playlistId,
      canonicalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    };
  }

  if (allowPlaylist && allowBrowse) {
    const match = path.match(/^\/browse\/(?:VL)?(PL[A-Za-z0-9_-]+)$/i);
    if (match && YOUTUBE_PLAYLIST_ID_RE.test(match[1])) {
      return {
        kind: 'playlist',
        playlistId: match[1],
        canonicalUrl: `https://www.youtube.com/playlist?list=${match[1]}`,
      };
    }
  }

  return null;
}

export function isYouTubeUrl(value) {
  return Boolean(parseYouTubeUrl(value));
}

export function normalizeYouTubeUrl(value) {
  return parseYouTubeUrl(value)?.canonicalUrl || null;
}

export function parseSpotifyUrl(value) {
  const parsed = parseHttpsUrl(value, SPOTIFY_HOSTS);
  if (!parsed || !onlyAllowedQueryKeys(parsed, new Set(['si', 'context', 'pi', 'utm_source', 'utm_medium', 'utm_campaign']))) {
    return null;
  }

  const match = parsed.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/i);
  if (!match || !SPOTIFY_ID_RE.test(match[2])) return null;
  return {
    type: match[1].toLowerCase(),
    id: match[2],
    canonicalUrl: `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`,
  };
}

export function isSpotifyUrl(value) {
  return Boolean(parseSpotifyUrl(value));
}

export function parseBilibiliInput(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2048 || CONTROL_CHAR_RE.test(text)) return null;

  if (BILIBILI_BV_RE.test(text)) {
    return {
      type: 'video',
      id: text,
      canonicalUrl: `https://www.bilibili.com/video/${text}`,
    };
  }
  if (BILIBILI_AV_RE.test(text)) {
    const id = text.toLowerCase();
    return {
      type: 'video',
      id,
      canonicalUrl: `https://www.bilibili.com/video/${id}`,
    };
  }

  const b23 = parseHttpsUrl(text, new Set(['b23.tv']));
  if (b23) {
    const match = b23.pathname.replace(/\/+$/, '').match(/^\/([A-Za-z0-9]{4,64})$/);
    if (match && !b23.search && !b23.hash && B23_TOKEN_RE.test(match[1])) {
      return { type: 'short', id: match[1], canonicalUrl: `https://b23.tv/${match[1]}` };
    }
  }

  const parsed = parseHttpsUrl(text, BILIBILI_HOSTS);
  if (!parsed || !onlyAllowedQueryKeys(parsed, new Set(['p']))) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  const match = path.match(/^\/video\/(BV[A-Za-z0-9]{10}|av\d{1,20})$/i);
  if (!match) return null;
  const id = /^av/i.test(match[1]) ? match[1].toLowerCase() : match[1];
  const part = parsed.searchParams.get('p');
  if (part !== null && !/^\d{1,6}$/.test(part)) return null;
  return {
    type: 'video',
    id,
    part: part || null,
    canonicalUrl: `https://www.bilibili.com/video/${id}${part ? `?p=${part}` : ''}`,
  };
}

export function isBilibiliInput(value) {
  return Boolean(parseBilibiliInput(value));
}

export function normalizeBilibiliInput(value) {
  return parseBilibiliInput(value)?.canonicalUrl || null;
}

export function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/.test(text)) return true;
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(text)) return true;
  return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/|$)/.test(text);
}

export function redactExternalError(error) {
  let message = String(error?.message || error || 'unknown error');
  const secrets = [
    process.env.DISCORD_TOKEN,
    process.env.LAVALINK_PASSWORD,
    process.env.AI_API_KEY,
    process.env.VOICE_LISTENER_TOKEN,
  ].filter(value => typeof value === 'string' && value.length > 0);
  for (const secret of new Set(secrets)) message = message.split(secret).join('[redacted]');

  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[external-url]')
    .replace(/((?:authorization|password|passwd|token|secret|cookie|key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:SESSDATA|DedeUserID|bili_jct)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

export function isAllowedResolvedAudioUrl(value, provider) {
  const text = String(value || '');
  if (!text || text.length > 8192 || CONTROL_CHAR_RE.test(text)) return false;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  if (provider === 'youtube') return host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
  if (provider === 'bilibili') {
    return host === 'bilivideo.com'
      || host.endsWith('.bilivideo.com')
      || host === 'bilivideo.cn'
      || host.endsWith('.bilivideo.cn');
  }
  return false;
}
