import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCollectorCommand } from '../src/services/collector-service.js';
import { COPY_AUTHORIZED } from '../../../packages/config/src/security.js';

class FakeD1 {
  statements = [];
  batchCalls = [];

  prepare(sql) {
    const owner = this;
    const statement = {
      sql,
      params: [],
      bind(...params) {
        return { ...this, params };
      },
      async all() {
        owner.statements.push({ sql, params: this.params });
        return { results: [] };
      },
    };
    return statement;
  }

  async batch(statements) {
    this.batchCalls.push(statements.map((statement) => ({ sql: statement.sql, params: statement.params ?? [] })));
    return statements.map(() => ({ success: true }));
  }
}

test('collector Worker exposes only its documented operation names', async () => {
  const db = new FakeD1();
  await assert.rejects(executeCollectorCommand(db, 'arbitrary-sql', { sql: 'DROP TABLE posts' }), /Unknown collector operation/);
});

test('post inspection command strips source URLs before persistence', async () => {
  const db = new FakeD1();
  await executeCollectorCommand(db, 'post.inspect', {
    now: '2026-11-01T00:00:00.000Z',
    inspection: {
      postId: 'AbCd1234',
      title: 'Sample album',
      inspectedAt: '2026-11-01T00:00:00.000Z',
      tags: [{ name: 'keyword', normalizedName: 'keyword' }],
      videos: [{
        sourceVideoId: 'Video1234',
        durationMs: 600_000,
        sourceUrl: 'https://v19.erome.com/private/video.mp4',
      }],
    },
  });

  const serialized = JSON.stringify(db.batchCalls);
  assert.equal(serialized.includes('v19.erome.com'), false);
  assert.equal(serialized.includes('sourceUrl'), false);
  assert.ok(db.batchCalls[0].every((statement) => statement.params.length <= 100));
});

test('collector service validates oversized and invalid payloads', async () => {
  const db = new FakeD1();
  await assert.rejects(executeCollectorCommand(db, 'posts.upsert', {
    posts: Array.from({ length: 161 }, () => ({})),
    now: '2026-11-01T00:00:00.000Z',
  }), /at most 160/);
  await assert.rejects(executeCollectorCommand(db, 'posts.pending', {
    postIds: ['AbCd1234'], limit: 0, keyword: 'needle',
  }), /limit must be between/);
});

test('listing command rejects noncanonical URLs and page numbers outside New pages 1-6', async () => {
  const db = new FakeD1();
  const base = {
    id: 'AbCd1234',
    canonicalUrl: 'https://www.erome.com/a/AbCd1234',
    title: 'A sample post',
    pageNumber: 1,
  };

  await assert.rejects(executeCollectorCommand(db, 'posts.upsert', {
    posts: [{ ...base, canonicalUrl: 'https://outside.example/a/AbCd1234' }],
    now: '2026-11-01T00:00:00.000Z',
  }), /canonical public Erome album URL/);

  await assert.rejects(executeCollectorCommand(db, 'posts.upsert', {
    posts: [{ ...base, pageNumber: 7 }],
    now: '2026-11-01T00:00:00.000Z',
  }), /pageNumber must be between 1 and 6/);

  // Page 4 (the new default depth) is accepted.
  await executeCollectorCommand(db, 'posts.upsert', {
    posts: [{ ...base, pageNumber: 4 }],
    now: '2026-11-01T00:00:00.000Z',
  });
});

test('inspection command rejects malformed media identifiers and invalid durations', async () => {
  const db = new FakeD1();
  const base = {
    postId: 'AbCd1234',
    title: 'Sample album',
    inspectedAt: '2026-11-01T00:00:00.000Z',
    tags: [],
  };

  await assert.rejects(executeCollectorCommand(db, 'post.inspect', {
    now: '2026-11-01T00:00:00.000Z',
    inspection: { ...base, videos: [{ sourceVideoId: '../private', durationMs: 60_000 }] },
  }), /sourceVideoId is invalid/);

  await assert.rejects(executeCollectorCommand(db, 'post.inspect', {
    now: '2026-11-01T00:00:00.000Z',
    inspection: { ...base, videos: [{ sourceVideoId: 'Video1234', durationMs: -1 }] },
  }), /durationMs must be a positive safe integer/);
});

test('evaluation command accepts only the documented metadata statuses and row IDs', async () => {
  const db = new FakeD1();
  await assert.rejects(executeCollectorCommand(db, 'videos.evaluate', {
    now: '2026-11-01T00:00:00.000Z',
    evaluations: [{ id: 'not-a-row-id', status: 'copy_blocked' }],
  }), /Video evaluation ID is invalid/);

  await assert.rejects(executeCollectorCommand(db, 'videos.evaluate', {
    now: '2026-11-01T00:00:00.000Z',
    evaluations: [{ id: 'a'.repeat(32), status: 'download_now' }],
  }), /Video evaluation status is invalid/);
});


test('Worker-side policy also blocks eligible status while copy authorization is false', { skip: COPY_AUTHORIZED }, async () => {
  const db = new FakeD1();
  await assert.rejects(executeCollectorCommand(db, 'videos.evaluate', {
    now: '2026-11-01T00:00:00.000Z',
    evaluations: [{ id: 'a'.repeat(32), status: 'eligible' }],
  }), /COPY_AUTHORIZED is false/);
  assert.equal(db.batchCalls.length, 0);
});


test('media registration is blocked at the Worker command boundary while copy authorization is false', { skip: COPY_AUTHORIZED }, async () => {
  const db = new FakeD1();
  await assert.rejects(executeCollectorCommand(db, 'media.register', {
    assetId: 'a'.repeat(32),
    objectId: `/Ero-Scrap/${'a'.repeat(32)}/clip.mp4`,
    shareUrl: 'https://mega.nz/file/AbCd#secret',
    uploadedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-08T00:00:00.000Z',
  }), /COPY_AUTHORIZED is false/);
  assert.equal(db.batchCalls.length, 0);
});


test('process due check is disabled at the Worker boundary while copy authorization is false', { skip: COPY_AUTHORIZED }, async () => {
  const db = new FakeD1();
  const result = await executeCollectorCommand(db, 'process.hasDue', {
    now: '2026-11-01T12:00:00.000Z',
  });
  assert.deepEqual(result, { due: false });
  assert.equal(db.statements.length, 0, 'the locked gate does not query media jobs');
});

test('retention due check is a narrow read-only operation', async () => {
  const db = new FakeD1();
  const result = await executeCollectorCommand(db, 'retention.hasDue', {
    now: '2026-11-01T12:00:00.000Z',
  });
  assert.deepEqual(result, { due: false });
  assert.equal(db.statements.length, 1);
  assert.match(db.statements[0].sql, /FROM video_assets/u);
  assert.match(db.statements[0].sql, /FROM job_records/u);
  assert.deepEqual(db.statements[0].params, [
    '2026-11-01T12:00:00.000Z',
    '2026-11-01T12:00:00.000Z',
    '2026-11-01T12:00:00.000Z',
  ]);
});
