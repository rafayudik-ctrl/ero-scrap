import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';
import { CollectorRepository } from '../../apps/api/src/repositories/collector-repository.js';
import {
  loadThumbnail, saveThumbnail, thumbnailBackend, thumbnailDeleter, thumbnailKey, thumbnailStorageReady,
} from '../../apps/api/src/lib/thumbnail-store.js';

const NOW = '2026-11-03T12:00:00.000Z';
const FUTURE = '2026-11-10T12:00:00.000Z';
const WEBP = Uint8Array.from([
  ...Buffer.from('RIFF'), 0x1a, 0, 0, 0, ...Buffer.from('WEBP'), 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4, 250, 251, 252, 253,
]);

async function storedAsset(db) {
  const repository = new CollectorRepository(db);
  await repository.upsertListingPosts([{ id: 'AbCd1234', canonicalUrl: 'https://www.erome.com/a/AbCd1234', title: 'Authorized sample post', publishedAt: null }], NOW);
  await repository.savePostInspection({
    postId: 'AbCd1234', title: 'Authorized sample post', tags: [{ name: 'sample', normalizedName: 'sample' }],
    videos: [{ sourceVideoId: 'Video1234', durationMs: 59_000 }], inspectedAt: NOW,
  }, NOW);
  const { id } = db.sqlite.prepare('SELECT id FROM video_assets LIMIT 1').get();
  db.sqlite.prepare(`UPDATE video_assets SET status = 'stored', storage_provider = 'mega', storage_object_id = '/x/${id}/a.mp4',
    share_url = 'https://mega.nz/file/abc#key', uploaded_at = ?, expires_at = ? WHERE id = ?`).run(NOW, FUTURE, id);
  return id;
}

test('backend selection: d1 is the default, r2 is opt-in, anything else is refused', () => {
  const db = { prepare() {}, batch() {} };
  assert.equal(thumbnailBackend({}), 'd1');
  assert.equal(thumbnailBackend({ THUMBNAIL_STORE: ' R2 ' }), 'r2');
  assert.equal(thumbnailBackend({ THUMBNAIL_STORE: 'ftp' }), null);
  assert.equal(thumbnailStorageReady({ DB: db }), true);
  assert.equal(thumbnailStorageReady({ DB: db, THUMBNAIL_STORE: 'r2' }), false, 'r2 needs its binding');
  assert.equal(thumbnailStorageReady({ DB: db, THUMBNAIL_STORE: 'r2', THUMBNAILS: { put() {}, get() {} } }), true);
  assert.equal(thumbnailStorageReady({ THUMBNAIL_STORE: 'd1' }), false, 'no database, no storage');
  assert.equal(thumbnailStorageReady({ DB: db, THUMBNAIL_STORE: 'ftp' }), false);
});

test('d1 backend saves, serves byte-identical data and disappears with the catalog row', async () => {
  const db = createSqliteD1();
  try {
    const id = await storedAsset(db);
    assert.equal(await saveThumbnail({ DB: db }, id, WEBP, NOW), true);
    const row = db.sqlite.prepare('SELECT thumbnail_key, thumbnail_content_type FROM video_assets WHERE id = ?').get(id);
    assert.equal(row.thumbnail_key, thumbnailKey(id));
    assert.equal(row.thumbnail_content_type, 'image/webp');

    const loaded = await loadThumbnail({ DB: db }, id);
    assert.deepEqual(Buffer.from(loaded.body), Buffer.from(WEBP));
    assert.equal(loaded.size, WEBP.byteLength);

    // Saving again replaces rather than duplicating.
    await saveThumbnail({ DB: db }, id, WEBP, NOW);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM thumbnails').get().n, 1);

    // Retention removes the catalog row; the preview must go with it (ON DELETE CASCADE).
    db.sqlite.prepare("UPDATE video_assets SET status = 'delete_pending' WHERE id = ?").run(id);
    db.sqlite.prepare('DELETE FROM video_assets WHERE id = ?').run(id);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM thumbnails').get().n, 0);
    assert.equal(await loadThumbnail({ DB: db }, id), null);
    await thumbnailDeleter({ DB: db }).delete('ignored'); // no-op, must not throw
  } finally { db.sqlite.close(); }
});

test('d1 backend refuses expired or not-stored items and leaves no orphan row', async () => {
  const db = createSqliteD1();
  try {
    const id = await storedAsset(db);
    assert.equal(await saveThumbnail({ DB: db }, id, WEBP, '2026-12-01T00:00:00.000Z'), false, 'expired');
    db.sqlite.prepare("UPDATE video_assets SET status = 'processing' WHERE id = ?").run(id);
    assert.equal(await saveThumbnail({ DB: db }, id, WEBP, NOW), false, 'not stored');
    assert.equal(await saveThumbnail({ DB: db }, 'f'.repeat(32), WEBP, NOW), false, 'unknown item');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM thumbnails').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT thumbnail_key FROM video_assets WHERE id = ?').get(id).thumbnail_key, null);
  } finally { db.sqlite.close(); }
});

test('r2 backend keeps the original behavior, including cleanup when the item is not eligible', async () => {
  const db = createSqliteD1();
  try {
    const id = await storedAsset(db);
    const objects = new Map();
    const bucket = {
      async put(key, bytes) { objects.set(key, bytes); },
      async get(key) { const bytes = objects.get(key); return bytes ? { body: bytes, size: bytes.byteLength, httpEtag: '"e"' } : null; },
      async delete(key) { objects.delete(key); },
    };
    const env = { DB: db, THUMBNAIL_STORE: 'r2', THUMBNAILS: bucket };
    assert.equal(await saveThumbnail(env, id, WEBP, NOW), true);
    assert.equal(objects.size, 1);
    assert.equal((await loadThumbnail(env, id)).etag, '"e"');
    assert.equal(thumbnailDeleter(env), bucket);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM thumbnails').get().n, 0, 'r2 mode never writes preview data to D1');

    objects.clear();
    assert.equal(await saveThumbnail(env, id, WEBP, '2026-12-01T00:00:00.000Z'), false);
    assert.equal(objects.size, 0, 'the object is removed when the item was not eligible');
    assert.equal(thumbnailDeleter({ DB: db, THUMBNAIL_STORE: 'r2' }), undefined, 'retention defers when the bucket is missing');
  } finally { db.sqlite.close(); }
});

test('wrangler.jsonc ships with d1 selected and no R2 binding that could break the first deploy', async () => {
  const text = await readFile('wrangler.jsonc', 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ''));
  assert.equal(config.vars.THUMBNAIL_STORE, 'd1');
  assert.deepEqual(config.r2_buckets, []);
  assert.equal(config.d1_databases[0].binding, 'DB');
});
