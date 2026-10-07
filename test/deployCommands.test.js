import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('deploy script refuses global deployment without explicit opt-in', () => {
  const result = spawnSync(process.execPath, ['src/deploy-commands.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCORD_TOKEN: 'test-token',
      CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '',
      ALLOW_GLOBAL_COMMAND_DEPLOY: 'false',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Global command deployment is disabled/);
});

test('invalid guild IDs cannot fall through to command deployment', () => {
  const result = spawnSync(process.execPath, ['src/deploy-commands.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'test-token',
      CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: 'invalid-guild',
      ALLOW_GLOBAL_COMMAND_DEPLOY: 'true',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISCORD_GUILD_ID must be a valid Discord snowflake/);
  assert.doesNotMatch(result.stdout, /开始刷新/);
});
