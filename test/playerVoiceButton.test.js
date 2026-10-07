import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNowPlayingPayload } from '../src/utils/playerPanel.js';
import { GuildSettings } from '../src/models/database.js';
import { setVoiceControlManager } from '../src/utils/voiceControlRuntime.js';

function queue(guildId) {
  return {
    guildId,
    currentSong: {
      title: 'Current',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    },
    songs: [],
    radioQueue: [],
    radio: { enabled: false, currentStyle: {} },
    volume: 50,
    loop: 'off',
    versionPreference: 'any',
    notificationMode: 'private',
  };
}

test('panel exposes the listener join button and reflects connection state', () => {
  const guildId = `panel-voice-${Date.now()}`;
  GuildSettings.update(guildId, {
    voiceControl: { enabled: true, listenerAutoJoin: true },
  });
  const serverQueue = queue(guildId);
  const manager = {
    diagnostics: () => ({ listenerReady: true, guildConnected: false }),
  };
  setVoiceControlManager(manager);

  try {
    let payload = buildNowPlayingPayload(serverQueue, serverQueue.currentSong);
    let components = payload.components.flatMap(row => row.components);
    let voiceButton = components.find(button => button.data.custom_id.startsWith('player:voice:'));
    assert.equal(voiceButton.data.label, '语音Bot加入');

    manager.diagnostics = () => ({ listenerReady: true, guildConnected: true });
    payload = buildNowPlayingPayload(serverQueue, serverQueue.currentSong);
    components = payload.components.flatMap(row => row.components);
    voiceButton = components.find(button => button.data.custom_id.startsWith('player:voice:'));
    assert.equal(voiceButton.data.label, '语音Bot离开');
  } finally {
    setVoiceControlManager(null);
  }
});
