import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { basename, dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DB_PATH = join(__dirname, '../../data/musicbot.json');
const configuredDBPath = String(process.env.MUSICBOT_DATA_PATH || '').trim();
export const DATABASE_PATH = configuredDBPath ? resolve(configuredDBPath) : DEFAULT_DB_PATH;
const dataPath = dirname(DATABASE_PATH);

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const SAVE_DEBOUNCE_MS = positiveInteger(process.env.MUSICBOT_SAVE_DEBOUNCE_MS, 2000, 60_000);
const SAVE_RETRY_DELAY_MS = positiveInteger(process.env.MUSICBOT_SAVE_RETRY_DELAY_MS, 1000, 60_000);
const MAX_SAVE_RETRIES = positiveInteger(process.env.MUSICBOT_SAVE_RETRY_LIMIT, 3, 10);

let saveTimer = null;
let dbCache = null;
let dirty = false;
let saveRetryCount = 0;

function ensureDataDirectory() {
  if (!existsSync(dataPath)) {
    mkdirSync(dataPath, { recursive: true });
  }
}

try {
  ensureDataDirectory();
} catch (error) {
  console.error('[Database] failed to prepare data directory:', error.message);
}

function emptyDB() {
  return {
    playlists: [],
    guildSettings: {},
    playbackStates: {}
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value, fallback = '') {
  if (value == null) return fallback;
  return typeof value === 'string' ? value : String(value);
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function validPlaylistName(value) {
  const name = String(value ?? '').trim();
  return name.length > 0 && name.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/.test(name);
}

function normalizePlaylist(value) {
  if (!isRecord(value)) return null;
  const songs = Array.isArray(value.songs)
    ? value.songs.filter(isRecord)
    : [];
  return {
    ...value,
    id: stringValue(value.id, randomUUID()),
    guildId: stringValue(value.guildId),
    userId: stringValue(value.userId),
    name: stringValue(value.name),
    revision: nonNegativeInteger(value.revision),
    createdAt: stringValue(value.createdAt, new Date(0).toISOString()),
    songs,
  };
}

function normalizeObjectMap(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isRecord(item) ? item : {},
  ]));
}

function normalizeDB(value) {
  const source = isRecord(value) ? value : {};
  const playlists = Array.isArray(source.playlists)
    ? source.playlists.map(normalizePlaylist).filter(Boolean)
    : [];
  const normalized = {
    playlists,
    guildSettings: normalizeObjectMap(source.guildSettings),
    playbackStates: normalizeObjectMap(source.playbackStates),
  };
  const repaired = !isRecord(value)
    || !Array.isArray(value.playlists)
    || !isRecord(value.guildSettings)
    || !isRecord(value.playbackStates);
  return { value: normalized, repaired };
}

function scheduleFlush(delayMs) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushDB();
  }, delayMs);
}

// 内存缓存，避免每次操作都读写磁盘导致并发丢失更新
export function loadDB() {
  if (dbCache) return dbCache;
  if (!existsSync(DATABASE_PATH)) {
    dbCache = emptyDB();
    return dbCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(DATABASE_PATH, 'utf-8'));
    const normalized = normalizeDB(parsed);
    dbCache = normalized.value;
    if (normalized.repaired) {
      dirty = true;
      scheduleFlush(SAVE_DEBOUNCE_MS);
    }
    return dbCache;
  } catch (error) {
    const name = basename(DATABASE_PATH, '.json') || 'musicbot';
    const backupPath = join(dataPath, `${name}.corrupt-${Date.now()}.json`);
    try {
      copyFileSync(DATABASE_PATH, backupPath);
      console.error(`[Database] ${name}.json is invalid; backed up to ${backupPath}:`, error.message);
    } catch (backupError) {
      console.error(`[Database] failed to back up invalid ${name}.json:`, backupError.message);
    }
    dbCache = emptyDB();
    dirty = true;
    scheduleFlush(SAVE_DEBOUNCE_MS);
    return dbCache;
  }
}

export function saveDB(data) {
  dbCache = normalizeDB(data).value;
  dirty = true;
  saveRetryCount = 0;
  // 防抖写入磁盘，避免高频写入
  scheduleFlush(SAVE_DEBOUNCE_MS);
}

export function flushDB() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dbCache || !dirty) return true;
  try {
    ensureDataDirectory();
    const tmpPath = `${DATABASE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(dbCache, null, 2));
    renameSync(tmpPath, DATABASE_PATH);
    dirty = false;
    saveRetryCount = 0;
    return true;
  } catch (error) {
    console.error('[Database] flush failed:', error.message);
    dirty = true;
    if (saveRetryCount < MAX_SAVE_RETRIES) {
      saveRetryCount += 1;
      scheduleFlush(SAVE_RETRY_DELAY_MS);
    }
    return false;
  }
}

export function isDatabaseDirty() {
  return dirty;
}

export function getDatabaseStatus() {
  return {
    path: DATABASE_PATH,
    dirty,
    retryCount: saveRetryCount,
    maxRetries: MAX_SAVE_RETRIES,
    pendingFlush: Boolean(saveTimer),
  };
}

const MAX_PLAYLISTS_PER_GUILD = 25;
const MAX_SONGS_PER_PLAYLIST = 200;
const DEFAULT_WAKE_WORDS = ['音乐助手', '语音助手'];
const VOICE_COMMANDS = ['play', 'pause', 'resume', 'previous', 'skip'];
const VOICE_LANGUAGES = new Set(['mixed', 'mandarin', 'cantonese']);
const VOICE_UNDERSTANDING_MODES = new Set(['strict', 'balanced']);
const NOTIFICATION_MODES = new Set(['private', 'panel', 'off', 'on']);
const VERSION_PREFERENCES = new Set(['any', 'live', 'normal']);
const MAX_STT_OPTOUT_USERS = 100_000;

function normalizeVoiceLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (language === 'auto') return 'mixed';
  if (language === 'zh' || language === 'zh-cn' || language === 'cmn') return 'mandarin';
  if (language === 'yue' || language === 'zh-hk') return 'cantonese';
  return VOICE_LANGUAGES.has(language) ? language : 'mixed';
}

function uniqueStrings(values, { max = 25, maxLength = 100 } = {}) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= maxLength))]
    .slice(0, max);
}

function defaultVoiceControl() {
  return {
    enabled: true,
    listenerAutoJoin: true,
    wakeWords: [...DEFAULT_WAKE_WORDS],
    language: 'mixed',
    understandingMode: 'strict',
    permissionMode: 'everyone',
    allowedRoleIds: [],
    sttAccessMode: 'everyone',
    cloudSttEnabled: true,
    consentedUserIds: [],
    sttOptOutUserIds: [],
    auditChannelId: null,
    enabledCommands: [...VOICE_COMMANDS],
  };
}

function mergeVoiceControl(value) {
  const defaults = defaultVoiceControl();
  const source = value && typeof value === 'object' ? value : {};
  const configuredWakeWords = uniqueStrings(source.wakeWords, { max: 10, maxLength: 40 });
  // Migrate the original default without changing explicitly customized lists.
  const wakeWords = configuredWakeWords.length === 1
    && configuredWakeWords[0] === '音乐助手'
    ? [...configuredWakeWords, '语音助手']
    : configuredWakeWords;
  const sttAccessMode = source.sttAccessMode === 'off'
    ? 'off'
    : source.sttAccessMode === 'everyone'
      ? 'everyone'
      : source.cloudSttEnabled === false ? 'off' : 'everyone';
  const sttOptOutUserIds = uniqueStrings(source.sttOptOutUserIds, {
    max: MAX_STT_OPTOUT_USERS,
    maxLength: 22,
  }).filter(id => /^\d{16,22}$/.test(id));

  return {
    enabled: source.enabled !== false,
    listenerAutoJoin: source.listenerAutoJoin !== false,
    wakeWords: wakeWords.length > 0 ? wakeWords : defaults.wakeWords,
    language: normalizeVoiceLanguage(source.language || defaults.language),
    understandingMode: VOICE_UNDERSTANDING_MODES.has(source.understandingMode)
      ? source.understandingMode
      : defaults.understandingMode,
    permissionMode: 'everyone',
    allowedRoleIds: [],
    sttAccessMode,
    cloudSttEnabled: sttAccessMode !== 'off',
    consentedUserIds: [],
    sttOptOutUserIds,
    auditChannelId: /^\d{16,22}$/.test(String(source.auditChannelId || ''))
      ? String(source.auditChannelId)
      : null,
    enabledCommands: defaults.enabledCommands,
  };
}

function mergeGuildSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const volume = Number(source.defaultVolume);
  const notificationMode = NOTIFICATION_MODES.has(source.notificationMode)
    ? source.notificationMode
    : 'private';
  const versionPreference = VERSION_PREFERENCES.has(source.versionPreference)
    ? source.versionPreference
    : 'any';
  const djRole = /^\d{16,22}$/.test(String(source.djRole || ''))
    ? String(source.djRole)
    : null;
  return {
    djRole,
    defaultVolume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 50,
    prefix: String(source.prefix || '!').slice(0, 10),
    notificationMode,
    versionPreference,
    voiceControl: mergeVoiceControl(source.voiceControl),
  };
}

export const VoiceControlDefaults = Object.freeze({
  listenerAutoJoin: true,
  wakeWords: Object.freeze([...DEFAULT_WAKE_WORDS]),
  language: 'mixed',
  understandingMode: 'strict',
  enabledCommands: Object.freeze([...VOICE_COMMANDS]),
  permissionMode: 'everyone',
  sttAccessMode: 'everyone',
  cloudSttEnabled: true,
});

export const Playlist = {
  create(guildId, userId, name) {
    const db = loadDB();
    const normalizedName = String(name || '').trim();
    if (!validPlaylistName(normalizedName)) return 'invalid';
    const existing = db.playlists.find(p => p.guildId === guildId && p.name === normalizedName);
    if (existing) return null;

    const guildCount = db.playlists.filter(p => p.guildId === guildId).length;
    if (guildCount >= MAX_PLAYLISTS_PER_GUILD) return 'limit';
    
    const playlist = {
      id: randomUUID(),
      guildId,
      userId,
      name: normalizedName,
      revision: 0,
      createdAt: new Date().toISOString(),
      songs: []
    };
    db.playlists.push(playlist);
    saveDB(db);
    return playlist.id;
  },

  get(guildId, name) {
    const db = loadDB();
    return db.playlists.find(p => p.guildId === guildId && p.name === name);
  },

  getById(playlistId, guildId = null) {
    const db = loadDB();
    return db.playlists.find(p => p.id === playlistId && (guildId === null || p.guildId === guildId));
  },

  getSnapshot(guildId, name) {
    const playlist = this.get(guildId, name);
    if (!playlist) return null;
    return {
      id: playlist.id,
      guildId: playlist.guildId,
      userId: playlist.userId,
      name: playlist.name,
      revision: playlist.revision,
    };
  },

  getAll(guildId) {
    const db = loadDB();
    return db.playlists.filter(p => p.guildId === guildId);
  },

  delete(guildId, name) {
    const db = loadDB();
    const index = db.playlists.findIndex(p => p.guildId === guildId && p.name === name);
    if (index === -1) return false;
    db.playlists.splice(index, 1);
    saveDB(db);
    return true;
  },

  rename(guildId, oldName, newName) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.guildId === guildId && p.name === oldName);
    if (!playlist) return null;
    const normalizedName = String(newName || '').trim();
    if (!validPlaylistName(normalizedName)) return 'invalid';
    const existing = db.playlists.find(p => p.guildId === guildId && p.name === normalizedName);
    if (existing) return false;
    playlist.name = normalizedName;
    playlist.revision = nonNegativeInteger(playlist.revision) + 1;
    saveDB(db);
    return true;
  },

  addSong(playlistId, song) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    if (!playlist) return null;

    if (playlist.songs.length >= MAX_SONGS_PER_PLAYLIST) return 'limit';
    
    playlist.songs.push({
      id: randomUUID(),
      title: song.title,
      url: song.url,
      duration: song.duration,
      thumbnail: song.thumbnail,
      author: song.author,
      addedAt: new Date().toISOString()
    });
    playlist.revision = nonNegativeInteger(playlist.revision) + 1;
    saveDB(db);
    return playlist.songs[playlist.songs.length - 1].id;
  },

  getSongs(playlistId) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    return playlist ? playlist.songs : [];
  },

  clearSongs(playlistId) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    if (!playlist) return false;
    const count = playlist.songs.length;
    playlist.songs = [];
    if (count > 0) {
      playlist.revision = nonNegativeInteger(playlist.revision) + 1;
      saveDB(db);
    }
    return count;
  },

  removeSong(playlistId, songId) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    if (!playlist) return false;
    
    const index = playlist.songs.findIndex(s => s.id === songId);
    if (index === -1) return false;
    playlist.songs.splice(index, 1);
    playlist.revision = nonNegativeInteger(playlist.revision) + 1;
    saveDB(db);
    return true;
  },

  removeSongs(playlistId, songIds) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    if (!playlist) return false;
    const ids = new Set(songIds);
    const before = playlist.songs.length;
    playlist.songs = playlist.songs.filter(song => !ids.has(song.id));
    const removed = before - playlist.songs.length;
    if (removed > 0) {
      playlist.revision = nonNegativeInteger(playlist.revision) + 1;
      saveDB(db);
    }
    return removed;
  },

  applyConditionalPlan({
    guildId,
    userId,
    playlistId = null,
    playlistName = '',
    expectedRevision = null,
    requireOwner = false,
    action = 'add',
    create = false,
    renameTo = null,
    clear = false,
    removeSongIds = [],
    addSongs = [],
  } = {}) {
    const db = loadDB();
    const normalizedGuildId = String(guildId || '');
    const normalizedUserId = String(userId || '');
    const normalizedPlaylistName = String(playlistName || '').trim();
    let playlist = playlistId
      ? db.playlists.find(item => item.id === playlistId)
      : null;
    let created = false;

    if (playlist) {
      if (playlist.guildId !== normalizedGuildId) return { ok: false, reason: 'wrong-guild' };
      if (requireOwner && playlist.userId !== normalizedUserId) return { ok: false, reason: 'not-owner' };
      if (!Number.isInteger(expectedRevision) || playlist.revision !== expectedRevision) {
        return { ok: false, reason: 'stale' };
      }
    } else if (playlistId) {
      return { ok: false, reason: 'not-found' };
    } else if (create) {
      if (!validPlaylistName(normalizedPlaylistName)) return { ok: false, reason: 'invalid-name' };
      if (db.playlists.some(item => item.guildId === normalizedGuildId && item.name === normalizedPlaylistName)) {
        return { ok: false, reason: 'name-conflict' };
      }
      if (db.playlists.filter(item => item.guildId === normalizedGuildId).length >= MAX_PLAYLISTS_PER_GUILD) {
        return { ok: false, reason: 'playlist-limit' };
      }
      playlist = {
        id: randomUUID(),
        guildId: normalizedGuildId,
        userId: normalizedUserId,
        name: normalizedPlaylistName,
        revision: 0,
        createdAt: new Date().toISOString(),
        songs: [],
      };
      db.playlists.push(playlist);
      created = true;
    } else {
      return { ok: false, reason: 'not-found' };
    }

    if (action === 'delete') {
      const index = db.playlists.findIndex(item => item.id === playlist.id);
      if (index < 0) return { ok: false, reason: 'not-found' };
      db.playlists.splice(index, 1);
      saveDB(db);
      return { ok: true, created, deleted: true, finalName: playlist.name, finalCount: 0, revision: null };
    }

    let changed = created;
    let renamedFrom = null;
    let cleared = 0;
    let removed = [];
    const added = [];

    if (renameTo && renameTo !== playlist.name) {
      const normalizedRenameTo = String(renameTo).trim();
      if (!validPlaylistName(normalizedRenameTo)) return { ok: false, reason: 'invalid-name' };
      if (db.playlists.some(item => item.guildId === normalizedGuildId && item.name === normalizedRenameTo && item.id !== playlist.id)) {
        return { ok: false, reason: 'name-conflict' };
      }
      renamedFrom = playlist.name;
      playlist.name = normalizedRenameTo;
      changed = true;
    }

    if (clear) {
      cleared = playlist.songs.length;
      if (cleared > 0) changed = true;
      playlist.songs = [];
    } else if (Array.isArray(removeSongIds) && removeSongIds.length > 0) {
      const ids = new Set(removeSongIds.filter(Boolean));
      removed = playlist.songs.filter(song => ids.has(song.id));
      if (removed.length > 0) {
        playlist.songs = playlist.songs.filter(song => !ids.has(song.id));
        changed = true;
      }
    }

    for (const song of Array.isArray(addSongs) ? addSongs : []) {
      if (playlist.songs.length >= MAX_SONGS_PER_PLAYLIST) break;
      if (!song || typeof song !== 'object' || !song.title || !song.url) continue;
      const addedSong = {
        id: randomUUID(),
        title: String(song.title).slice(0, 500),
        url: String(song.url).slice(0, 2048),
        duration: song.duration == null ? null : String(song.duration).slice(0, 32),
        thumbnail: song.thumbnail == null ? null : String(song.thumbnail).slice(0, 2048),
        author: song.author == null ? 'Unknown' : String(song.author).slice(0, 200),
        addedAt: new Date().toISOString(),
      };
      playlist.songs.push(addedSong);
      added.push(addedSong);
      changed = true;
    }

    if (changed) {
      playlist.revision = nonNegativeInteger(playlist.revision) + 1;
      saveDB(db);
    }

    return {
      ok: true,
      created,
      renamedFrom,
      cleared,
      removed,
      added,
      deleted: false,
      finalName: playlist.name,
      finalCount: playlist.songs.length,
      revision: playlist.revision,
    };
  }
};

export const GuildSettings = {
  get(guildId) {
    const db = loadDB();
    db.guildSettings ||= {};
    return mergeGuildSettings(db.guildSettings[guildId]);
  },

  set(guildId, settings) {
    const db = loadDB();
    db.guildSettings ||= {};
    db.guildSettings[guildId] = mergeGuildSettings(settings);
    saveDB(db);
    return db.guildSettings[guildId];
  },

  update(guildId, patch) {
    const current = this.get(guildId);
    const source = patch && typeof patch === 'object' ? patch : {};
    const voicePatch = source.voiceControl && typeof source.voiceControl === 'object'
      ? source.voiceControl
      : {};
    const normalizedVoicePatch = Object.prototype.hasOwnProperty.call(voicePatch, 'cloudSttEnabled')
      && !Object.prototype.hasOwnProperty.call(voicePatch, 'sttAccessMode')
      ? {
          ...voicePatch,
          sttAccessMode: voicePatch.cloudSttEnabled === true ? 'everyone' : 'off',
        }
      : voicePatch;
    return this.set(guildId, {
      ...current,
      ...source,
      voiceControl: {
        ...current.voiceControl,
        ...normalizedVoicePatch,
      },
    });
  }
};

export const PlaybackState = {
  get(guildId) {
    const db = loadDB();
    return db.playbackStates?.[guildId] || null;
  },

  getAll() {
    const db = loadDB();
    return db.playbackStates || {};
  },

  set(guildId, state) {
    const db = loadDB();
    db.playbackStates ||= {};
    db.playbackStates[guildId] = state;
    saveDB(db);
  },

  delete(guildId) {
    const db = loadDB();
    if (!db.playbackStates?.[guildId]) return false;
    delete db.playbackStates[guildId];
    saveDB(db);
    return true;
  }
};

export default { loadDB, saveDB, flushDB };
