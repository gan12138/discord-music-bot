import test from 'node:test';
import assert from 'node:assert/strict';
import { getAIConfigStatus, requestAIJson, validateAIEndpoint } from '../src/utils/aiClient.js';

function configureAI(t, baseUrl) {
  const config = { AI_ENABLED: 'true', AI_API_KEY: 'test-key', AI_MODEL: 'test-model', AI_BASE_URL: baseUrl };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('AI cannot send a credential without an explicitly configured endpoint', async t => {
  configureAI(t, undefined);
  assert.equal(getAIConfigStatus().ok, false);
  assert.throws(() => validateAIEndpoint(), /endpoint is required/);
  let called = false;
  const result = await requestAIJson([], {
    request: async () => { called = true; throw new Error('Unexpected request'); },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('AI sends requests only to the explicitly configured public HTTPS endpoint', async t => {
  configureAI(t, 'https://example.com/v1/');
  let endpoint;
  const result = await requestAIJson([], {
    request: async (url, options) => {
      endpoint = url;
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    },
  });
  assert.equal(endpoint, 'https://example.com/v1/chat/completions');
  assert.deepEqual(result, { ok: true });
});
