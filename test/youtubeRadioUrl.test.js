import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { parseYouTubeUrl, normalizeYouTubeUrl } from '../src/utils/urlAllowlist.js';
import { YouTube } from '../src/utils/youtube.js';
import { execute as play } from '../src/commands/play.js';
import { musicQueue, MusicPlayer } from '../src/utils/player.js';
import { cancelPendingPlaybackSave } from '../src/utils/playbackState.js';

const reportedUrl = 'https://www.youtube.com/watch?v=_0BBDUc65Vg&list=RD_0BBDUc65Vg&start_radio=1';
const canonicalUrl = 'https://www.youtube.com/watch?v=_0BBDUc65Vg';

for (const url of [
  reportedUrl,
  'https://www.youtube.com/watch?start_radio=1&v=_0BBDUc65Vg&list=RD_0BBDUc65Vg',
  'https://music.youtube.com/watch?v=_0BBDUc65Vg&list=RD_0BBDUc65Vg&start_radio=1',
  'https://youtu.be/_0BBDUc65Vg?si=share-token&list=RD_0BBDUc65Vg&start_radio=1',
]) {
  test(`radio context is stripped while retaining the video: ${url}`, () => {
    assert.deepEqual(parseYouTubeUrl(url), {
      kind: 'video', videoId: '_0BBDUc65Vg', canonicalUrl,
    });
    assert.equal(normalizeYouTubeUrl(url), canonicalUrl);
    assert.equal(YouTube.isYouTubeUrl(url), true);
    assert.equal(YouTube.isPlaylist(url), false);
    assert.equal(parseYouTubeUrl(url, { allowPlaylist: false })?.canonicalUrl, canonicalUrl);
  });
}

test('an explicit playlist URL still uses the playlist path', () => {
  const parsed = parseYouTubeUrl('https://www.youtube.com/playlist?list=PLexample123&start_radio=1');
  assert.deepEqual(parsed, {
    kind: 'playlist', playlistId: 'PLexample123',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PLexample123',
  });
});

test('allowing start_radio does not weaken host, protocol, id or duplicate-parameter checks', () => {
  for (const url of [
    'https://youtube.com.evil.example/watch?v=_0BBDUc65Vg&start_radio=1',
    'https://www.youtube.com@evil.example/watch?v=_0BBDUc65Vg&start_radio=1',
    'http://www.youtube.com/watch?v=_0BBDUc65Vg&start_radio=1',
    'https://www.youtube.com:8443/watch?v=_0BBDUc65Vg&start_radio=1',
    'https://www.youtube.com/watch?v=invalid&start_radio=1',
    'https://www.youtube.com/watch?v=_0BBDUc65Vg&v=abcdefghijk&start_radio=1',
    'https://www.youtube.com/watch?v=_0BBDUc65Vg&start_radio=1&start_radio=0',
    'https://www.youtube.com/watch?v=_0BBDUc65Vg&start_radio=1&redirect=https://evil.example',
  ]) assert.equal(parseYouTubeUrl(url), null, url);
});

test('/play accepts the exact reported radio URL as one video, not a search or playlist', async t => {
  const guildId = 'youtube-radio-url-regression';
  const voiceChannel = {
    id: 'voice',
    members: new Collection([['human', { user: { bot: false } }]]),
    permissionsFor: () => ({ has: () => true }),
  };
  const queue = musicQueue.get(guildId);
  // Already playing: exercise the real enqueue path without connecting to
  // Discord, invoking Lavalink, starting yt-dlp, or replacing the playing song.
  queue.connection = { state: { status: 'ready' }, joinConfig: { channelId: voiceChannel.id } };
  queue.activeBackend = 'local';
  queue.player = { state: { status: 'playing' } };
  queue.audioResource = {};
  queue.currentSong = { title: 'Existing song', url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: '3:00', source: 'manual' };
  queue.playing = true;
  queue.notificationMode = 'off';
  const replies = [];
  const metadata = t.mock.method(YouTube, 'getVideoInfo', async url => {
    assert.equal(url, reportedUrl);
    // The actual extractor normalizes before launching yt-dlp.
    assert.equal(YouTube.normalizeUrl(url), canonicalUrl);
    return { title: 'Reported video', url: canonicalUrl, duration: '3:00' };
  });
  const search = t.mock.method(YouTube, 'search', async () => []);
  const playlist = t.mock.method(YouTube, 'getPlaylist', async () => []);
  const join = t.mock.method(MusicPlayer, 'joinVoice', async () => { throw new Error('Unexpected network join'); });
  const start = t.mock.method(MusicPlayer, 'playSong', async () => { throw new Error('Unexpected playback replacement'); });
  const interaction = {
    guildId, createdTimestamp: Date.now(),
    guild: { id: guildId, members: { me: { voice: { channel: voiceChannel, channelId: voiceChannel.id } } } },
    member: { voice: { channel: voiceChannel } },
    user: { id: 'human' }, client: { user: {} }, channel: { id: 'text' },
    options: { getString: () => reportedUrl },
    deferReply: async () => {},
    editReply: async payload => { replies.push(typeof payload === 'string' ? payload : payload.content); },
  };
  try {
    await play(interaction);
    assert.equal(metadata.mock.callCount(), 1);
    assert.equal(search.mock.callCount(), 0);
    assert.equal(playlist.mock.callCount(), 0);
    assert.equal(join.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(queue.songs.length, 1);
    assert.equal(queue.songs[0].url, canonicalUrl);
    assert.equal(queue.currentSong.title, 'Existing song');
    assert.match(replies.at(-1), /已添加到队列/);
  } finally {
    cancelPendingPlaybackSave(guildId);
    musicQueue.delete(guildId);
  }
});
