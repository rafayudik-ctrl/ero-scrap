import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = 'f'.repeat(64);

function request(path = '/internal/collector', { method = 'POST', token = TOKEN, body = { operation: 'unknown', payload: {} }, headers = {} } = {}) {
  const requestHeaders = new Headers({ 'Content-Type': 'application/json', ...headers });
  if (token !== null) requestHeaders.set('Authorization', `Bearer ${token}`);
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: requestHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  });
}

const fakeDb = {
  prepare() {
    return {
      bind() { return this; },
      async all() { return { results: [] }; },
      async first() { return null; },
      async run() { return { success: true }; },
    };
  },
  async batch() { return []; },
};

test('internal collector route rejects missing and incorrect runner tokens', async () => {
  const env = { DB: fakeDb, RUNNER_API_TOKEN: TOKEN };
  const missing = await worker.fetch(request('/internal/collector', { token: null }), env);
  assert.equal(missing.status, 401);
  const invalid = await worker.fetch(request('/internal/collector', { token: 'wrong' }), env);
  assert.equal(invalid.status, 401);
});

test('internal collector route fails closed if server secret is missing or weak', async () => {
  const response = await worker.fetch(request(), { DB: fakeDb, RUNNER_API_TOKEN: 'short' });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, 'internal_auth_not_configured');
});

test('internal collector route accepts only POST and JSON', async () => {
  const wrongMethod = await worker.fetch(request('/internal/collector', { method: 'GET' }), {
    DB: fakeDb,
    RUNNER_API_TOKEN: TOKEN,
  });
  assert.equal(wrongMethod.status, 405);

  const wrongType = await worker.fetch(request('/internal/collector', {
    headers: { 'Content-Type': 'text/plain' },
  }), { DB: fakeDb, RUNNER_API_TOKEN: TOKEN });
  assert.equal(wrongType.status, 415);
});

test('internal collector route rejects unknown commands and malformed request bodies', async () => {
  const unknown = await worker.fetch(request('/internal/collector', {
    body: { operation: 'raw-sql', payload: { sql: 'DROP TABLE posts' } },
  }), { DB: fakeDb, RUNNER_API_TOKEN: TOKEN });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'unknown_operation');

  const malformed = new Request('https://api.example.test/internal/collector', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  const invalid = await worker.fetch(malformed, { DB: fakeDb, RUNNER_API_TOKEN: TOKEN });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_json');
});

test('health endpoint remains public while private collector commands require the token', async () => {
  const response = await worker.fetch(new Request('https://api.example.test/health'), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stage, 3);
});
