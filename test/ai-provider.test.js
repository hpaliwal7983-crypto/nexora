import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCopilotResponse } from '../ai-provider.js';

function withOpenAI(t) {
  const before = Object.fromEntries(['AI_PROVIDER', 'AI_MODEL', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'].map(key => [key, process.env[key]]));
  process.env.AI_PROVIDER = 'openai'; process.env.AI_MODEL = 'test-model'; process.env.OPENAI_API_KEY = 'test-key'; delete process.env.OPENROUTER_API_KEY;
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}

test('provider configuration absence fails explicitly without calling the network', async t => {
  const before = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  t.after(() => { if (before !== undefined) process.env.OPENAI_API_KEY = before; });
  await assert.rejects(generateCopilotResponse({ system: 'system', history: [], message: 'hello' }), error => error.code === 'configuration');
});

test('empty provider response is rejected instead of rendered as a blank answer', async t => {
  withOpenAI(t); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ' ' } }] }) });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(generateCopilotResponse({ system: 'system', history: [], message: 'hello' }), error => error.code === 'invalid_response');
});

test('rate limit and timeout receive at most one retry', async t => {
  withOpenAI(t); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => ({ choices: [{ message: { content: 'Recovered.' } }] }) }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal((await generateCopilotResponse({ system: 'system', history: [], message: 'hello' })).text, 'Recovered.');
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { calls++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
  await assert.rejects(generateCopilotResponse({ system: 'system', history: [], message: 'hello', timeoutMs: 5 }), error => error.code === 'timeout');
  assert.equal(calls, 2);
});

test('unauthorized provider credentials are not retried', async t => {
  withOpenAI(t); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401 }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(generateCopilotResponse({ system: 'system', history: [], message: 'hello' }), error => error.code === 'configuration');
  assert.equal(calls, 1);
});
