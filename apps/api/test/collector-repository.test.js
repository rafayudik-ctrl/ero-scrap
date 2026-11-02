import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CollectorRepository } from '../src/repositories/collector-repository.js';

function createFakeD1() {
  const batches = [];
  const runs = [];
  const statements = [];
  const queries = [];

  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return [];
    },
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async all() {
          queries.push({ sql: this.sql, params: this.params });
          return { results: [] };
        },
        async run() {
          runs.push({ sql: this.sql, params: this.params });
          return { success: true, meta: { changes: 1 } };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      batches.push(items.map((item) => ({ sql: item.sql, params: [...item.params] })));
      return items.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };

  return { db, batches, runs, statements, queries };
}

test('D1 repository uses Web Crypto and stores video metadata without source URLs', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  const now = '2026-11-01T00:00:00.000Z';

  await repository.savePostInspection({
    postId: 'AbCd1234',
    title: 'Example post',
    inspectedAt: now,
    tags: [
      { name: 'Retro', normalizedName: 'retro' },
      { name: 'Sample keyword', normalizedName: 'sample keyword' },
    ],
    videos: [
      { sourceVideoId: 'VideoA123', durationMs: 599_000, sourceUrl: 'https://media.erome.com/private-a.mp4' },
      { sourceVideoId: 'VideoB456', durationMs: 600_000, sourceUrl: 'https://media.erome.com/private-b.mp4' },
    ],
  }, now);

  assert.equal(fake.batches.length, 1);
  const statements = fake.batches[0];
  const videoInsert = statements.find((statement) => statement.sql.includes('INSERT INTO video_assets'));
  assert.ok(videoInsert);
  assert.equal(videoInsert.params.length, 14);
  assert.equal(videoInsert.params[2], 'VideoA123');
  assert.equal(videoInsert.params[3], 599_000);
  assert.equal(videoInsert.params[9], 'VideoB456');
  assert.equal(videoInsert.params[10], 600_000);

  const expectedId = createHash('sha256').update('AbCd1234:VideoA123').digest('hex').slice(0, 32);
  assert.equal(videoInsert.params[0], expectedId);
  const serialized = JSON.stringify(statements);
  assert.equal(serialized.includes('sourceUrl'), false);
  assert.equal(serialized.includes('private-a.mp4'), false);
  assert.equal(serialized.includes('private-b.mp4'), false);
});

test('D1 repository creates scan IDs with the platform Web Crypto API', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  const scanId = await repository.createScanRun('2026-11-01T00:00:00.000Z');

  assert.match(scanId, /^[0-9a-f-]{36}$/u);
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].params[0], scanId);
});


test('D1 stored-media registration matches FFprobe duration to the discovered video metadata', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  await repository.registerStoredMedia({
    assetId: 'a'.repeat(32),
    objectId: `/Ero-Scrap/${'a'.repeat(32)}/clip.mp4`,
    shareUrl: 'https://mega.nz/file/AbCd#secret',
    durationMs: 599_500,
    uploadedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-08T00:00:00.000Z',
  });

  assert.equal(fake.queries.length, 1);
  assert.match(fake.runs[0].sql, /ABS\(duration_ms - \?\) <= \?/u);
  assert.deepEqual(fake.runs[0].params.slice(-2), [599_500, 2_000]);
});


test('process due lookup uses a bounded read-only query', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  assert.equal(await repository.hasDueProcessVideoJobs({ now: '2026-11-01T12:00:00.000Z' }), false);
  assert.equal(fake.queries.length, 1);
  assert.match(fake.queries[0].sql, /job_type = 'process_video'/u);
  assert.match(fake.queries[0].sql, /status IN \('pending', 'retry'\)/u);
  assert.deepEqual(fake.queries[0].params, [
    '2026-11-01T12:00:00.000Z',
    '2026-11-01T12:00:00.000Z',
  ]);
});

test('retention completion is guarded by the current lease token in both D1 statements', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  const leaseToken = 'a'.repeat(32);
  await repository.completeDeletion({
    jobId: '11111111-1111-4111-8111-111111111111',
    assetId: 'b'.repeat(32),
    leaseToken,
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(fake.batches.length, 1);
  assert.match(fake.batches[0][0].sql, /EXISTS[\s\S]*lease_token = \?/u);
  assert.match(fake.batches[0][1].sql, /status = 'leased' AND lease_token = \?/u);
  assert.equal(fake.batches[0][0].params.at(-1), leaseToken);
  assert.equal(fake.batches[0][1].params.at(-1), leaseToken);
});

test('retention failure cannot alter a job after its lease token has changed', async () => {
  const fake = createFakeD1();
  fake.db.prepare = (sql) => ({
    bind(...params) { this.params = params; return this; },
    async all() { return { results: [] }; },
    async run() {
      fake.runs.push({ sql, params: this.params });
      return { success: true, meta: { changes: 0 } };
    },
  });
  const repository = new CollectorRepository(fake.db);
  const result = await repository.failDeletion({
    jobId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'c'.repeat(32),
    attempts: 2,
    errorCode: 'storage_delete_failed',
    now: '2026-11-01T00:00:00.000Z',
  });
  assert.deepEqual(result, { retry: false, dead: false, stale: true });
  assert.match(fake.runs[0].sql, /status = 'leased' AND lease_token = \?/u);
  assert.equal(fake.runs[0].params.at(-1), 'c'.repeat(32));
});


test('thumbnail cleanup lookup rejects stale retention lease owners', async () => {
  const fake = createFakeD1();
  const repository = new CollectorRepository(fake.db);
  await assert.rejects(repository.getDeletionThumbnailKey({
    assetId: 'd'.repeat(32),
    jobId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'e'.repeat(32),
  }), (error) => error.code === 'retention_lease_stale');
  assert.match(fake.queries[0].sql, /INNER JOIN job_records[\s\S]*status = 'leased'[\s\S]*lease_token = \?/u);
  assert.deepEqual(fake.queries[0].params, ['11111111-1111-4111-8111-111111111111', 'e'.repeat(32), 'd'.repeat(32)]);
});
