import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorRepository } from '../../apps/api/src/repositories/collector-repository.js';
import { listCatalogItems } from '../../apps/api/src/repositories/catalog-repository.js';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:10:00.000Z';
const HEX = (char) => char.repeat(32);

function post(id, title = `Title ${id}`) {
  return { id, canonicalUrl: `https://www.erome.com/a/${id}`, title, publishedAt: null, pageNumber: 1 };
}

function seedStored(d1, { id, postId, expiresAt, status = 'stored', discoveredAt = T0 }) {
  d1.sqlite.prepare(`INSERT OR IGNORE INTO posts (id, canonical_url, title, normalized_title, discovered_at, created_at, updated_at)
    VALUES (?, ?, 'T', 't', ?, ?, ?)`).run(postId, `https://www.erome.com/a/${postId}`, discoveredAt, T0, T0);
  d1.sqlite.prepare(`INSERT INTO video_assets (id, post_id, source_video_id, status, duration_ms, storage_provider,
      storage_object_id, share_url, discovered_at, uploaded_at, first_clicked_at, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1000, 'mega', ?, 'https://mega.nz/file/AbCd#k', ?, ?, ?, ?, ?, ?)`)
    .run(id, postId, `v${id.slice(0, 6)}`, status, `/Ero-Scrap/${id}/a.mp4`, discoveredAt, T0,
      status === 'clicked' ? T0 : null, expiresAt, T0, T0);
}

test('listing upsert does not rewrite posts whose listing data did not change', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  await repo.upsertListingPosts([post('AAAA1111'), post('BBBB2222')], T0);

  const before = d1.sqlite.prepare('SELECT id, updated_at FROM posts ORDER BY id').all().map((row) => ({ ...row }));
  await repo.upsertListingPosts([post('AAAA1111'), post('BBBB2222')], T1);
  const after = d1.sqlite.prepare('SELECT id, updated_at FROM posts ORDER BY id').all().map((row) => ({ ...row }));

  assert.deepEqual(after, before, 'unchanged listing rows must not be written again');
});

test('listing upsert never reverts a title that the album inspection already refined', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  await repo.upsertListingPosts([post('AAAA1111', 'Short title')], T0);
  await repo.savePostInspection({
    postId: 'AAAA1111', title: 'Short title, complete version from the album page',
    inspectedAt: T0, tags: [], videos: [],
  }, T0);

  await repo.upsertListingPosts([post('AAAA1111', 'Short title')], T1);
  const row = d1.sqlite.prepare('SELECT title, normalized_title FROM posts WHERE id = ?').get('AAAA1111');
  assert.equal(row.title, 'Short title, complete version from the album page');
  assert.equal(row.normalized_title, 'short title, complete version from the album page');
});

test('listing upsert still updates the title of posts that were not inspected yet', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  await repo.upsertListingPosts([post('AAAA1111', 'Old')], T0);
  await repo.upsertListingPosts([post('AAAA1111', 'New')], T1);
  assert.equal(d1.sqlite.prepare('SELECT title FROM posts').get().title, 'New');
});

test('evaluations skip rows that already hold the target status and protected rows', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  await repo.upsertListingPosts([post('AAAA1111')], T0);
  await repo.savePostInspection({
    postId: 'AAAA1111', title: 'T', inspectedAt: T0, tags: [],
    videos: [{ sourceVideoId: 'VideoA123', durationMs: 1000 }],
  }, T0);
  const [{ id }] = d1.sqlite.prepare('SELECT id FROM video_assets').all();

  await repo.updateEvaluations([{ id, status: 'ignored' }], T0);
  await repo.updateEvaluations([{ id, status: 'ignored' }], T1);
  assert.equal(d1.sqlite.prepare('SELECT updated_at FROM video_assets WHERE id = ?').get(id).updated_at, T0);

  await repo.updateEvaluations([{ id, status: 'too_long' }], T1);
  assert.equal(d1.sqlite.prepare('SELECT status, updated_at FROM video_assets WHERE id = ?').get(id).status, 'too_long');

  d1.sqlite.prepare("UPDATE video_assets SET status = 'delete_pending', uploaded_at = ?, expires_at = ? WHERE id = ?").run(T0, T0, id);
  await repo.updateEvaluations([{ id, status: 'ignored' }], T1);
  assert.equal(d1.sqlite.prepare('SELECT status FROM video_assets WHERE id = ?').get(id).status, 'delete_pending');
});

test('retention claims new due assets even while older jobs are stuck', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  // Two assets whose deletion jobs exhausted their retries ("dead") and still sit in delete_pending.
  for (const [index, char] of ['1', '2'].entries()) {
    seedStored(d1, { id: HEX(char), postId: `STUCK${index}00`, expiresAt: '2026-10-01T00:00:00.000Z' });
  }
  // The retention sweep must create jobs for these before they can be marked dead.
  const first = await repo.claimDueDeletionJobs({ now: T0, limit: 2 });
  assert.equal(first.length, 2);
  for (const job of first) {
    await repo.failDeletion({ jobId: job.jobId, leaseToken: job.leaseToken, errorCode: 'storage_delete_failed', attempts: 8, now: T0 });
  }
  assert.equal(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM job_records WHERE status = 'dead'").get().n, 2);

  // A newer asset becomes due. It must not be starved by the two older stuck ones.
  seedStored(d1, { id: HEX('3'), postId: 'FRESH000', expiresAt: '2026-10-31T00:00:00.000Z' });
  const next = await repo.claimDueDeletionJobs({ now: T1, limit: 2 });
  assert.deepEqual(next.map((job) => job.assetId), [HEX('3')]);
});

test('retention cancels a leased job whose asset no longer exists', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  seedStored(d1, { id: HEX('4'), postId: 'GONE0000', expiresAt: '2026-10-01T00:00:00.000Z' });
  d1.sqlite.exec('PRAGMA foreign_keys = OFF');
  const claimedOnce = await repo.claimDueDeletionJobs({ now: T0, limit: 2 });
  assert.equal(claimedOnce.length, 1);
  d1.sqlite.prepare('DELETE FROM video_assets WHERE id = ?').run(HEX('4'));

  // Lease expires; the orphan job must be closed instead of cycling forever.
  const later = '2026-11-01T02:00:00.000Z';
  assert.deepEqual(await repo.claimDueDeletionJobs({ now: later, limit: 2 }), []);
  assert.equal(d1.sqlite.prepare("SELECT status FROM job_records").get().status, 'cancelled');
});

test('prune removes stale metadata in bounded batches and never touches stored videos', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  const old = '2026-10-01T00:00:00.000Z';
  const fresh = '2026-10-31T00:00:00.000Z';
  const now = '2026-11-01T00:00:00.000Z';

  await repo.upsertListingPosts([post('OLDPOST1'), post('OLDKEEP1'), post('NEWPOST1')], old);
  d1.sqlite.prepare("UPDATE posts SET discovered_at = ? WHERE id = 'NEWPOST1'").run(fresh);
  await repo.savePostInspection({
    postId: 'OLDPOST1', title: 'T', inspectedAt: old, tags: [{ name: 'Tag', normalizedName: 'tag' }],
    videos: [{ sourceVideoId: 'OldVideo1', durationMs: 5000 }],
  }, old);
  d1.sqlite.prepare("UPDATE video_assets SET discovered_at = ?").run(old);
  seedStored(d1, { id: HEX('5'), postId: 'OLDKEEP1', expiresAt: '2026-11-05T00:00:00.000Z', discoveredAt: old });

  d1.sqlite.prepare("INSERT INTO scan_runs (id, started_at, status, created_at) VALUES ('old-scan', ?, 'succeeded', ?)").run(old, old);
  d1.sqlite.prepare("INSERT INTO scan_runs (id, started_at, status, created_at) VALUES ('new-scan', ?, 'succeeded', ?)").run(fresh, fresh);
  d1.sqlite.prepare(`INSERT INTO job_records (id, job_type, status, idempotency_key, available_at, created_at, updated_at)
    VALUES ('j-old', 'delete_video', 'succeeded', 'k1', ?, ?, ?), ('j-dead', 'delete_video', 'dead', 'k2', ?, ?, ?)`).run(old, old, old, old, old, old);

  const result = await repo.pruneStale({ now, retainDays: 14, jobRetainDays: 7, batchSize: 500 });

  assert.deepEqual(result, { videos: 1, posts: 1, scans: 1, jobs: 1 });
  assert.deepEqual(d1.sqlite.prepare('SELECT id FROM posts ORDER BY id').all().map((r) => r.id), ['NEWPOST1', 'OLDKEEP1']);
  assert.equal(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM video_assets WHERE status = 'stored'").get().n, 1);
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) AS n FROM post_tags').get().n, 0);
  assert.deepEqual(d1.sqlite.prepare('SELECT id FROM scan_runs').all().map((r) => r.id), ['new-scan']);
  assert.deepEqual(d1.sqlite.prepare('SELECT id FROM job_records').all().map((r) => r.id), ['j-dead']);
});

test('prune respects its batch size so one call stays small', async () => {
  const d1 = createSqliteD1();
  const repo = new CollectorRepository(d1);
  const old = '2026-10-01T00:00:00.000Z';
  await repo.upsertListingPosts(['AAAA0001', 'AAAA0002', 'AAAA0003'].map((id) => post(id)), old);
  const result = await repo.pruneStale({ now: '2026-11-01T00:00:00.000Z', retainDays: 14, jobRetainDays: 7, batchSize: 2 });
  assert.equal(result.posts, 2);
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 1);
});

test('catalog listing walks the partial index in page order, without sorting', async () => {
  const d1 = createSqliteD1();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  for (let index = 0; index < 300; index += 1) {
    d1.sqlite.prepare(`INSERT OR IGNORE INTO posts (id, canonical_url, title, normalized_title, discovered_at, created_at, updated_at)
      VALUES (?, ?, 'T', 't', ?, ?, ?)`).run(`P${index}XXXX`, `https://www.erome.com/a/P${index}XXXX`, T0, T0, T0);
    d1.sqlite.prepare(`INSERT INTO video_assets (id, post_id, source_video_id, status, discovered_at, created_at, updated_at)
      VALUES (?, ?, ?, 'ignored', ?, ?, ?)`).run(index.toString(16).padStart(32, '0'), `P${index}XXXX`, `vid${index}xx`, T0, T0, T0);
  }
  seedStored(d1, { id: HEX('a'), postId: 'POSTAAAA', expiresAt: future });

  await listCatalogItems(d1, { limit: 24, cursor: null, query: '' });
  const { sql, params } = d1.log.at(-1);
  const plan = d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(' | ');
  assert.match(plan, /idx_video_assets_catalog/u);
  assert.doesNotMatch(plan, /USE TEMP B-TREE/u);
});

test('catalog listing returns only active stored items, newest first, with keyset pagination', async () => {
  const d1 = createSqliteD1();
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  seedStored(d1, { id: HEX('a'), postId: 'POSTAAAA', expiresAt: future, discoveredAt: '2026-11-01T00:00:01.000Z' });
  seedStored(d1, { id: HEX('b'), postId: 'POSTBBBB', expiresAt: future, discoveredAt: '2026-11-01T00:00:02.000Z', status: 'clicked' });
  seedStored(d1, { id: HEX('c'), postId: 'POSTCCCC', expiresAt: '2020-01-01T00:00:00.000Z', discoveredAt: '2026-11-01T00:00:03.000Z' });

  const page1 = await listCatalogItems(d1, { limit: 1, cursor: null, query: '' });
  assert.deepEqual(page1.items.map((item) => item.id), [HEX('b')]);
  assert.equal(page1.hasMore, true);
  const page2 = await listCatalogItems(d1, { limit: 1, cursor: page1.nextCursor, query: '' });
  assert.deepEqual(page2.items.map((item) => item.id), [HEX('a')]);
  assert.equal(page2.hasMore, false);
  assert.ok(now);
});

test('first click shortens expiry to 24h once; later clicks never extend it (real SQLite)', async () => {
  const { recordFirstClickAndGetShareUrl } = await import('../../apps/api/src/repositories/catalog-repository.js');
  const d1 = createSqliteD1();
  const sevenDays = '2026-11-08T00:00:00.000Z';
  seedStored(d1, { id: HEX('9'), postId: 'CLICK000', expiresAt: sevenDays });

  const clickedAt = '2026-11-02T10:00:00.000Z';
  const url = await recordFirstClickAndGetShareUrl(d1, HEX('9'), clickedAt);
  assert.equal(url, 'https://mega.nz/file/AbCd#k');
  const afterFirst = d1.sqlite.prepare('SELECT status, first_clicked_at, expires_at FROM video_assets WHERE id = ?').get(HEX('9'));
  assert.deepEqual({ ...afterFirst }, { status: 'clicked', first_clicked_at: clickedAt, expires_at: '2026-11-03T10:00:00.000Z' });

  await recordFirstClickAndGetShareUrl(d1, HEX('9'), '2026-11-02T20:00:00.000Z');
  const afterSecond = d1.sqlite.prepare('SELECT first_clicked_at, expires_at FROM video_assets WHERE id = ?').get(HEX('9'));
  assert.deepEqual({ ...afterSecond }, { first_clicked_at: clickedAt, expires_at: '2026-11-03T10:00:00.000Z' });

  assert.equal(await recordFirstClickAndGetShareUrl(d1, HEX('9'), '2026-11-04T00:00:00.000Z'), null, 'expired items cannot be opened');
});
