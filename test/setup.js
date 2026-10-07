import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDataDirectory = mkdtempSync(join(tmpdir(), 'discord-music-bot-test-'));
process.env.MUSICBOT_DATA_PATH = join(testDataDirectory, 'musicbot.json');
// AI tests use injected requests and a reserved example endpoint, never a personal relay.
process.env.AI_BASE_URL = 'https://example.com/v1';

process.on('exit', () => {
  rmSync(testDataDirectory, { recursive: true, force: true });
});
