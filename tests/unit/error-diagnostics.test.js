import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../apps/api/src/index.js';
import { CollectorApiClient, CollectorApiError } from '../../apps/runner/src/clients/collector-api-client.js';
import { sanitizeDiagnostic, describeError, hintFor } from '../../packages/config/src/diagnostics.js';

const TOKEN = 'f'.repeat(64);

test('sanitizer removes URLs, tags and long opaque strings and stays short', () => {
  const text = sanitizeDiagnostic(`<h1>Error</h1> failed https://x.example/a?b=1 key ${'A1b2'.repeat(12)} ${'z'.repeat(1000)}`);
  assert.doesNotMatch(text, /https?:|<h1>|A1b2A1b2A1b2/u);
  assert.match(text, /\[url\]/u);
  assert.ok(text.length <= 400);
  assert.equal(sanitizeDiagnostic(null), '');
});

test('describeError walks the cause chain and hintFor spots D1 limits and missing tables', () => {
  const chain = describeError(new Error('D1_ERROR: daily limit', { cause: Object.assign(new Error('quota exceeded'), { code: 'X' }) }));
  assert.equal(chain.length, 2);
  assert.equal(chain[1].code, 'X');
  assert.match(hintFor('D1_ERROR: Exceeded daily row writes limit'), /D1 free-plan/u);
  assert.match(hintFor('D1_ERROR: no such table: thumbnails'), /migrations/u);
  assert.equal(hintFor('something else'), null);
});

test('a database failure returns the operation, sanitized causes and a hint to the runner', async () => {
  const failingDb = {
    prepare() { throw new Error('D1_ERROR: Exceeded daily row writes limit for https://secret.example/x'); },
    async batch() { throw new Error('D1_ERROR: Exceeded daily row writes limit'); },
  };
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const response = await worker.fetch(new Request('https://api.example.test/internal/collector', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ operation: 'scan.create', payload: { startedAt: '2026-11-06T12:00:00.000Z' } }),
    }), { DB: failingDb, RUNNER_API_TOKEN: TOKEN });
    assert.equal(response.status, 500);
    const { error } = await response.json();
    assert.equal(error.code, 'collector_operation_failed');
    assert.equal(error.operation, 'scan.create');
    assert.match(error.causes[0].message, /Exceeded daily row writes/u);
    assert.doesNotMatch(JSON.stringify(error), /secret\.example/u);
    assert.match(error.hint, /D1 free-plan/u);
    assert.ok(logged.length >= 1);
  } finally { console.error = original; }
});

test('the runner client turns that response into an actionable error without leaking the token', async () => {
  const body = { ok: false, error: { code: 'collector_operation_failed', message: 'The collector operation could not be completed.', operation: 'scan.create',
    causes: [{ name: 'Error', message: 'D1_ERROR: Exceeded daily row writes limit' }], hint: 'D1 free-plan limit or overload' } };
  const client = new CollectorApiClient({ endpoint: 'https://x.example/internal/collector', token: TOKEN, fetchImpl: async () => new Response(JSON.stringify(body), { status: 500 }) });
  await assert.rejects(client.createScanRun('2026-11-06T12:00:00.000Z'), (error) => {
    assert.ok(error instanceof CollectorApiError);
    assert.equal(error.status, 500);
    assert.equal(error.operation, 'scan.create');
    assert.match(error.detail, /Exceeded daily row writes/u);
    assert.match(error.hint, /D1 free-plan/u);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), new RegExp(TOKEN, 'u'));
    return true;
  });

  const html = new CollectorApiClient({ endpoint: 'https://x.example/internal/collector', token: TOKEN,
    fetchImpl: async () => new Response('<html><body>Error 1102 Worker exceeded resource limits</body></html>', { status: 503, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.createScanRun('x'), (error) => {
    assert.equal(error.code, 'collector_invalid_response');
    assert.equal(error.status, 503);
    assert.match(error.detail, /Error 1102 Worker exceeded resource limits/u);
    return true;
  });
});
