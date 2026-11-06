import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';
import { CollectorRepository } from '../../apps/api/src/repositories/collector-repository.js';
import { executeCollectorCommand } from '../../apps/api/src/services/collector-service.js';

const KEY_A = 'a'.repeat(16);
const KEY_B = 'b'.repeat(16);
const NOW = '2026-11-06T12:00:00.000Z';
const daysAgo = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

test('seen-posts state is one row, replaced as a whole, and a new keyword key starts over', async () => {
  const db = createSqliteD1();
  const repository = new CollectorRepository(db);
  assert.deepEqual(await repository.getSeenPosts(KEY_A), []);
  await repository.saveSeenPosts(KEY_A, ['AbCd1234', 'EfGh5678']);
  await repository.saveSeenPosts(KEY_A, ['AbCd1234', 'EfGh5678', 'IjKl9012']);
  assert.deepEqual(await repository.getSeenPosts(KEY_A), ['AbCd1234', 'EfGh5678', 'IjKl9012']);
  assert.deepEqual(await repository.getSeenPosts(KEY_B), []);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM scan_state WHERE key = 'seen_posts'").get().n, 1);
});

test('state operations work through the Worker command layer, even on a database without the table', async () => {
  const db = createSqliteD1({ migrations: false });
  await assert.rejects(executeCollectorCommand(db, 'scan.seen.get', { keywordKey: 'nope' }), TypeError);
  await executeCollectorCommand(db, 'scan.seen.save', { keywordKey: KEY_A, ids: ['AbCd1234'] });
  assert.deepEqual((await executeCollectorCommand(db, 'scan.seen.get', { keywordKey: KEY_A })).ids, ['AbCd1234']);
});

function seed(db, { id, status, age }) {
  const when = daysAgo(age);
  db.sqlite.prepare('INSERT OR IGNORE INTO posts (id, canonical_url, title, normalized_title, discovered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`P${id}`.padEnd(8, 'x'), `https://www.erome.com/a/P${id}`.padEnd(30, 'x'), 't', 't', when, when, when);
  const stored = ['stored', 'clicked', 'delete_pending'].includes(status);
  db.sqlite.prepare(`INSERT INTO video_assets (id, post_id, source_video_id, status, duration_ms, discovered_at, uploaded_at, expires_at, created_at, updated_at${status === 'clicked' ? ', first_clicked_at' : ''})
                     VALUES (?, ?, ?, ?, 1000, ?, ?, ?, ?, ?${status === 'clicked' ? ', ?' : ''})`)
    .run(...[`${id}`.padEnd(32, '0'), `P${id}`.padEnd(8, 'x'), `vid${id}`.padEnd(8, 'x'), status, when, stored ? when : null, stored ? daysAgo(-1) : null, when, when, ...(status === 'clicked' ? [when] : [])]);
}

test('housekeeping drops discarded rows after 3 days, keeps pipeline rows for 14 and never touches stored media', async () => {
  const db = createSqliteD1();
  const repository = new CollectorRepository(db);
  seed(db, { id: 'aa01', status: 'ignored', age: 4 });
  seed(db, { id: 'aa02', status: 'too_long', age: 2 });
  seed(db, { id: 'aa03', status: 'eligible', age: 4 });
  seed(db, { id: 'aa04', status: 'eligible', age: 15 });
  seed(db, { id: 'aa05', status: 'stored', age: 30 });
  const result = await repository.pruneStale({ now: NOW });
  const left = db.sqlite.prepare('SELECT status FROM video_assets ORDER BY status').all().map((row) => row.status);
  assert.deepEqual(left, ['eligible', 'stored', 'too_long']); // aa01 and aa04 removed
  assert.equal(result.videos, 2);
});

test('housekeeping runs at most once per UTC day, but its own batches continue', async () => {
  const db = createSqliteD1();
  const repository = new CollectorRepository(db);
  for (let index = 0; index < 5; index += 1) seed(db, { id: `bb0${index}`, status: 'ignored', age: 5 });
  const first = await repository.pruneStale({ now: NOW, batchSize: 2 });
  assert.equal(first.videos, 2);
  const sameDay = await repository.pruneStale({ now: '2026-11-06T12:20:00.000Z', batchSize: 2 });
  assert.equal(sameDay.skipped, true);
  assert.equal(sameDay.videos, 0);
  const continued = await repository.pruneStale({ now: NOW, batchSize: 2, continuation: true });
  assert.equal(continued.videos, 2);
  const nextDay = await repository.pruneStale({ now: '2026-11-07T03:03:00.000Z', batchSize: 2 });
  assert.equal(nextDay.videos, 1);
});
