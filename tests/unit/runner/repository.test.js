import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorApiClient, CollectorApiError } from '../../../apps/runner/src/clients/collector-api-client.js';

const endpoint = 'https://api.example.test/internal/collector';
const token = 'a'.repeat(64);

function createClient(fetchImpl) {
  return new CollectorApiClient({ endpoint, token, fetchImpl });
}

test('collector API client sends allowlisted commands with bearer authentication', async () => {
  const requests = [];
  const client = createClient(async (url, options) => {
    requests.push({ url, options });
    return Response.json({ ok: true, data: { scanId: 'scan-123' } });
  });

  const id = await client.createScanRun('2026-11-01T00:00:00.000Z');
  assert.equal(id, 'scan-123');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    operation: 'scan.create',
    payload: { startedAt: '2026-11-01T00:00:00.000Z' },
  });
});

test('repository facade maps every domain operation to a narrow command', async () => {
  const calls = [];
  const client = createClient(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const data = body.operation === 'posts.pending' ? { posts: [] }
      : body.operation === 'posts.snapshots' ? { posts: [] }
        : body.operation === 'scan.create' ? { scanId: 'scan-2' }
          : body.operation === 'process.hasDue' ? { due: true }
            : { ok: true };
    return Response.json({ ok: true, data });
  });

  await client.createScanRun('2026-11-01T00:00:00.000Z');
  await client.finishScanRun('scan-2', { finishedAt: '2026-11-01T00:01:00.000Z', status: 'succeeded', pagesScanned: 2, postsSeen: 1, matchingPosts: 1, videoCandidates: 1, errorCode: null });
  await client.upsertListingPosts([], '2026-11-01T00:00:00.000Z');
  assert.deepEqual(await client.getPendingInspection(['AbCd1234'], 10, 'needle'), []);
  await client.savePostInspection({ postId: 'AbCd1234', title: 'Title', inspectedAt: '2026-11-01T00:00:00.000Z', tags: [], videos: [] }, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(await client.getPostSnapshots(['AbCd1234']), []);
  await client.updateEvaluations([], '2026-11-01T00:00:00.000Z');
  assert.equal(await client.hasDueProcessVideoJobs({ now: '2026-11-01T00:00:00.000Z' }), true);

  assert.deepEqual(calls.map((item) => item.operation), [
    'scan.create', 'scan.finish', 'posts.upsert', 'posts.pending',
    'post.inspect', 'posts.snapshots', 'process.hasDue',
  ]);
});

test('collector API client normalizes server and network errors', async () => {
  const failed = createClient(async () => Response.json({
    ok: false,
    error: { code: 'invalid_payload', message: 'Invalid request.' },
  }, { status: 400 }));
  await assert.rejects(failed.createScanRun('2026-11-01T00:00:00.000Z'), (error) => {
    assert.ok(error instanceof CollectorApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_payload');
    return true;
  });

  const offline = createClient(async () => { throw new Error('private network detail'); });
  await assert.rejects(offline.createScanRun('2026-11-01T00:00:00.000Z'), (error) => {
    assert.equal(error.code, 'collector_network_error');
    assert.equal(error.message.includes('private network detail'), false);
    return true;
  });
});

test('collector API client rejects unsafe endpoint, short token and incomplete Access pair', () => {
  assert.throws(() => new CollectorApiClient({ endpoint: 'http://api.example.test/internal/collector', token, fetchImpl: fetch }), /HTTPS/);
  assert.throws(() => new CollectorApiClient({ endpoint, token: 'short', fetchImpl: fetch }), /32 characters/);
  assert.throws(() => new CollectorApiClient({ endpoint: 'https://user:pass@api.example.test/internal/collector', token, fetchImpl: fetch }), /credentials/);
  assert.throws(() => new CollectorApiClient({ endpoint, token, accessClientId: 'id', fetchImpl: fetch }), /provided together/);
});

test('large evaluation sets are sent in bounded API batches', async () => {
  const requests = [];
  const client = createClient(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return Response.json({ ok: true, data: { ok: true } });
  });

  const evaluations = Array.from({ length: 1_101 }, (_, index) => ({
    id: index.toString(16).padStart(32, '0'),
    status: 'duration_unknown',
  }));
  await client.updateEvaluations(evaluations, '2026-11-01T00:00:00.000Z');

  assert.deepEqual(requests.map((request) => request.payload.evaluations.length), [500, 500, 101]);
  assert.ok(requests.every((request) => request.operation === 'videos.evaluate'));
  assert.equal(requests.flatMap((request) => request.payload.evaluations).length, 1_101);
});
