import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackState } from '../src/models/database.js';
import { musicQueue, MusicPlayer } from '../src/utils/player.js';

test('skip records the current song so previous can restore it', async () => {
  const guildId = `test-history-${Date.now()}`;
  const currentSong = { title: 'Current', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', source: 'manual' };
  const nextSong = { title: 'Next', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', source: 'manual' };
  const serverQueue = musicQueue.get(guildId);
  serverQueue.currentSong = currentSong;
  serverQueue.songs = [nextSong];
  serverQueue.activeBackend = 'local';
  serverQueue.player = { stop() {} };

  const originalPlaySong = MusicPlayer.playSong;
  const originalPlaybackStateSet = PlaybackState.set;
  MusicPlayer.playSong = async (_guildId, _textChannel, song, source) => {
    song.source = source || song.source || 'manual';
    serverQueue.currentSong = song;
  };
  PlaybackState.set = () => {};

  try {
    const skipped = await MusicPlayer.skip(guildId);
    assert.equal(skipped.ok, true);
    assert.equal(serverQueue.currentSong, nextSong);
    assert.deepEqual(serverQueue.history, [currentSong]);

    const previous = await MusicPlayer.previous(guildId);
    assert.equal(previous.ok, true);
    assert.equal(previous.song, currentSong);
    assert.equal(serverQueue.currentSong, currentSong);
    assert.deepEqual(serverQueue.songs, [nextSong]);
    assert.deepEqual(serverQueue.history, []);
  } finally {
    MusicPlayer.playSong = originalPlaySong;
    PlaybackState.set = originalPlaybackStateSet;
    musicQueue.delete(guildId);
  }
});
