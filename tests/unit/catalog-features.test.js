import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';
import { CollectorRepository } from '../../apps/api/src/repositories/collector-repository.js';
import { listCatalogItems, requestEarlyDeletion, CATALOG_ORDERS } from '../../apps/api/src/repositories/catalog-repository.js';
import worker from '../../apps/api/src/index.js';
import { resolveUnopenedDays, isValidUnopenedExpiry } from '../../packages/config/src/retention-days.js';
import { loadRunnerConfig } from '../../apps/runner/src/config/env.js';

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const DAY = 86_400_000;

function seedVideo(db, { n, discoveredAgoMs, durationMs, status = 'stored', expiresInMs = 2 * DAY, uploadedAgoMs = 3600_000, clicked = false }) {
  const postId = `Post${n}`.padEnd(8, 'x');
  db.sqlite.prepare('INSERT OR IGNORE INTO posts (id, canonical_url, title, normalized_title, discovered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(postId, `https://www.erome.com/a/${postId}`, `Video ${n}`, `video ${n}`, iso(-discoveredAgoMs), iso(-discoveredAgoMs), iso(-discoveredAgoMs));
  const id = String(n).padStart(32, '0');
  db.sqlite.prepare(`INSERT INTO video_assets (id, post_id, source_video_id, status, duration_ms, discovered_at, uploaded_at, expires_at, thumbnail_key, share_url, created_at, updated_at${clicked ? ', first_clicked_at' : ''})
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'https://mega.nz/file/AbCdEf#k', ?, ?${clicked ? ', ?' : ''})`)
    .run(...[id, postId, `src${n}`.padEnd(8, 'x'), status, durationMs, iso(-discoveredAgoMs), iso(-uploadedAgoMs), iso(expiresInMs), iso(-discoveredAgoMs), iso(-discoveredAgoMs), ...(clicked ? [iso(-1000)] : [])]);
  return id;
}

async function titles(db, options) {
  const pages = [];
  let cursor = null;
  do {
    const page = await listCatalogItems(db, { limit: 2, cursor, ...options });
    assert.equal(page.invalidCursor, false);
    pages.push(...page.items.map((item) => item.title));
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

test('catalog sorts by recency and by duration, in both directions, across pages', async () => {
  const db = createSqliteD1();
  seedVideo(db, { n: 1, discoveredAgoMs: 5 * 3600_000, durationMs: 300_000 });
  seedVideo(db, { n: 2, discoveredAgoMs: 4 * 3600_000, durationMs: 60_000 });
  seedVideo(db, { n: 3, discoveredAgoMs: 3 * 3600_000, durationMs: 300_000 });
  seedVideo(db, { n: 4, discoveredAgoMs: 2 * 3600_000, durationMs: 590_000 });
  seedVideo(db, { n: 5, discoveredAgoMs: 1 * 3600_000, durationMs: 120_000 });
  assert.deepEqual(await titles(db, { order: 'recent' }), ['Video 5', 'Video 4', 'Video 3', 'Video 2', 'Video 1']);
  assert.deepEqual(await titles(db, { order: 'oldest' }), ['Video 1', 'Video 2', 'Video 3', 'Video 4', 'Video 5']);
  // Equal durations (videos 1 and 3) are separated by the id, with no repeats or gaps across pages.
  assert.deepEqual(await titles(db, { order: 'longest' }), ['Video 4', 'Video 3', 'Video 1', 'Video 5', 'Video 2']);
  assert.deepEqual(await titles(db, { order: 'shortest' }), ['Video 2', 'Video 5', 'Video 1', 'Video 3', 'Video 4']);
  await assert.rejects(listCatalogItems(db, { limit: 2, order: 'random' }), RangeError);
  assert.deepEqual(Object.keys(CATALOG_ORDERS), ['recent', 'oldest', 'longest', 'shortest']);
});

test('a cursor from a time-ordered list is rejected by a duration-ordered request', async () => {
  const db = createSqliteD1();
  for (let n = 1; n <= 3; n += 1) seedVideo(db, { n, discoveredAgoMs: n * 3600_000, durationMs: n * 1000 });
  const first = await listCatalogItems(db, { limit: 1, order: 'recent' });
  const mismatch = await listCatalogItems(db, { limit: 1, order: 'longest', cursor: first.nextCursor });
  assert.equal(mismatch.invalidCursor, true);
});

test('early deletion hides the video at once and leaves the file to the normal retention sweep', async () => {
  const db = createSqliteD1();
  const stored = seedVideo(db, { n: 1, discoveredAgoMs: 3600_000, durationMs: 100_000 });
  const clicked = seedVideo(db, { n: 2, discoveredAgoMs: 3600_000, durationMs: 100_000, status: 'clicked', clicked: true });
  const pending = seedVideo(db, { n: 3, discoveredAgoMs: 3600_000, durationMs: 100_000, status: 'delete_pending' });
  assert.equal((await listCatalogItems(db, { limit: 10 })).items.length, 2);

  assert.equal(await requestEarlyDeletion(db, stored), true);
  assert.equal(await requestEarlyDeletion(db, stored), false); // already due
  assert.equal(await requestEarlyDeletion(db, pending), false);
  assert.equal(await requestEarlyDeletion(db, 'f'.repeat(32)), false);
  assert.equal((await listCatalogItems(db, { limit: 10 })).items.map((item) => item.id).join(), clicked);

  // The existing retention pipeline now sees it as due and removes it.
  const repository = new CollectorRepository(db);
  const due = await repository.claimDueDeletionJobs({ now: new Date().toISOString(), limit: 10 });
  assert.ok(JSON.stringify(due).includes(stored));
});

test('delete endpoint requires POST, the trusted Origin and a session; the order parameter is validated', async () => {
  const db = createSqliteD1();
  const id = seedVideo(db, { n: 1, discoveredAgoMs: 3600_000, durationMs: 100_000 });
  const env = { DB: db, APP_ENV: 'development', AUTH_MODE: 'access', ACCESS_DEV_BYPASS: 'true', WEB_ORIGIN: 'https://site.example' };
  const call = (method, headers = {}, path = `/api/catalog/${id}/delete`) => worker.fetch(new Request(`https://site.example${path}`, { method, headers }), env);

  assert.equal((await call('GET')).status, 405);
  assert.equal((await call('POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', { Origin: 'https://site.example' })).status, 401); // no session in access mode
  assert.equal((await call('GET', {}, '/api/catalog?order=random')).status, 401);

  // With a valid session (development bypass) the full flow works.
  const open = { ...env, AUTH_MODE: 'access', DEV_AUTH_BYPASS: 'true' };
  const post = (path, headers = { Origin: 'https://site.example' }) => worker.fetch(new Request(`https://site.example${path}`, { method: 'POST', headers }), open);
  const first = await post(`/api/catalog/${id}/delete`);
  assert.equal(first.status, 202);
  assert.deepEqual((await first.json()).data, { id, status: 'deleting' });
  assert.equal((await post(`/api/catalog/${id}/delete`)).status, 410); // already deleting
  const list = await worker.fetch(new Request('https://site.example/api/catalog?order=longest'), open);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data, []);
  assert.equal((await worker.fetch(new Request('https://site.example/api/catalog?order=random'), open)).status, 400);
});

test('unopened retention days: default 4, configurable from 1 to 7, validated everywhere', async () => {
  assert.equal(resolveUnopenedDays(undefined), 4);
  assert.equal(resolveUnopenedDays(''), 4);
  assert.equal(resolveUnopenedDays('7'), 7);
  assert.equal(resolveUnopenedDays(' 2 '), 2);
  for (const bad of ['0', '8', '2.5', 'abc', '-1']) assert.throws(() => resolveUnopenedDays(bad), RangeError);
  const base = '2026-11-01T12:00:00.000Z';
  assert.equal(isValidUnopenedExpiry(base, '2026-11-05T12:00:00.000Z'), true);
  assert.equal(isValidUnopenedExpiry(base, '2026-11-08T12:00:00.000Z'), true);
  assert.equal(isValidUnopenedExpiry(base, '2026-11-09T12:00:00.000Z'), false);
  assert.equal(isValidUnopenedExpiry(base, '2026-11-05T13:00:00.000Z'), false);
  const config = loadRunnerConfig({ APP_ENV: 'production', COLLECTOR_API_URL: 'https://x.example/internal/collector', COLLECTOR_API_TOKEN: 'a'.repeat(40), UNOPENED_RETENTION_DAYS: '7' });
  assert.equal(config.unopenedRetentionDays, 7);
});

test('lowering the retention also shortens videos already stored, once a day, and never touches opened ones', async () => {
  const db = createSqliteD1();
  const repository = new CollectorRepository(db);
  const old = seedVideo(db, { n: 1, discoveredAgoMs: 3 * DAY, durationMs: 1000, uploadedAgoMs: 3 * DAY, expiresInMs: 4 * DAY });   // 7-day item
  const opened = seedVideo(db, { n: 2, discoveredAgoMs: 3 * DAY, durationMs: 1000, uploadedAgoMs: 3 * DAY, expiresInMs: 4 * DAY, status: 'clicked', clicked: true });
  const fresh = seedVideo(db, { n: 3, discoveredAgoMs: 3600_000, durationMs: 1000, uploadedAgoMs: 3600_000, expiresInMs: 4 * DAY - 3600_000 });
  await repository.pruneStale({ now: new Date().toISOString(), unopenedDays: 4 });
  const expiry = (id) => db.sqlite.prepare('SELECT expires_at FROM video_assets WHERE id = ?').get(id).expires_at;
  const uploaded = (id) => db.sqlite.prepare('SELECT uploaded_at FROM video_assets WHERE id = ?').get(id).uploaded_at;
  assert.equal(Date.parse(expiry(old)) - Date.parse(uploaded(old)), 4 * DAY);
  assert.ok(Date.parse(expiry(opened)) - Date.parse(uploaded(opened)) > 4 * DAY - 1); // keeps its own 24 h rule
  assert.equal(Date.parse(expiry(fresh)) - Date.parse(uploaded(fresh)), 4 * DAY - 3600_000 + 3600_000);
});
