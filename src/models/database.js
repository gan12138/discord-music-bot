import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataPath = join(__dirname, '../../data');
const dbPath = join(dataPath, 'musicbot.json');

if (!existsSync(dataPath)) {
  mkdirSync(dataPath, { recursive: true });
}

function emptyDB() {
  return {
    playlists: [],
    guildSettings: {},
    playbackStates: {}
  };
}

// 内存缓存，避免每次操作都读写磁盘导致并发丢失更新
let dbCache = null;

function loadDB() {
  if (dbCache) return dbCache;
  if (!existsSync(dbPath)) {
    dbCache = emptyDB();
    return dbCache;
  }
  try {
    dbCache = JSON.parse(readFileSync(dbPath, 'utf-8'));
    return dbCache;
  } catch (error) {
    const backupPath = join(dataPath, `musicbot.corrupt-${Date.now()}.json`);
    try {
      copyFileSync(dbPath, backupPath);
      console.error(`[Database] musicbot.json is invalid; backed up to ${backupPath}:`, error.message);
    } catch (backupError) {
      console.error('[Database] failed to back up invalid musicbot.json:', backupError.message);
    }
    dbCache = emptyDB();
    return dbCache;
  }
}

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

function saveDB(data) {
  dbCache = data;
  // 防抖写入磁盘，避免高频写入
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDB, SAVE_DEBOUNCE_MS);
}

function flushDB() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dbCache) return;
  try {
    const tmpPath = `${dbPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(dbCache, null, 2));
    renameSync(tmpPath, dbPath);
  } catch (error) {
    console.error('[Database] flush failed:', error.message);
  }
}

const MAX_PLAYLISTS_PER_GUILD = 25;
const MAX_SONGS_PER_PLAYLIST = 200;

export const Playlist = {
  create(guildId, userId, name) {
    const db = loadDB();
    const existing = db.playlists.find(p => p.guildId === guildId && p.name === name);
    if (existing) return null;

    const guildCount = db.playlists.filter(p => p.guildId === guildId).length;
    if (guildCount >= MAX_PLAYLISTS_PER_GUILD) return 'limit';
    
    const playlist = {
      id: randomUUID(),
      guildId,
      userId,
      name,
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
    const existing = db.playlists.find(p => p.guildId === guildId && p.name === newName);
    if (existing) return false;
    playlist.name = newName;
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
    saveDB(db);
    return count;
  },

  removeSong(playlistId, songId) {
    const db = loadDB();
    const playlist = db.playlists.find(p => p.id === playlistId);
    if (!playlist) return false;
    
    const index = playlist.songs.findIndex(s => s.id === songId);
    if (index === -1) return false;
    playlist.songs.splice(index, 1);
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
    if (removed > 0) saveDB(db);
    return removed;
  }
};

export const GuildSettings = {
  get(guildId) {
    const db = loadDB();
    return db.guildSettings[guildId];
  },

  set(guildId, settings) {
    const db = loadDB();
    db.guildSettings[guildId] = {
      djRole: settings.djRole ?? null,
      defaultVolume: settings.defaultVolume ?? 50,
      prefix: settings.prefix ?? '!'
    };
    saveDB(db);
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
