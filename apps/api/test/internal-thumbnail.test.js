import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInternalThumbnailUpload } from '../src/services/internal-collector.js';

const TOKEN = 't'.repeat(64);
const ASSET_ID = 'a'.repeat(32);

test('internal thumbnail upload is blocked before touching R2 while COPY_AUTHORIZED is false', async () => {
  let putCalls = 0;
  let dbCalls = 0;
  const response = await handleInternalThumbnailUpload(new Request(`https://api.example.test/internal/thumbnails/${ASSET_ID}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'image/webp',
    },
    body: new Uint8Array([1, 2, 3, 4]),
  }), {
    RUNNER_API_TOKEN: TOKEN,
    DB: { prepare() { dbCalls += 1; throw new Error('database must not be touched'); } },
    THUMBNAILS: { async put() { putCalls += 1; } },
  }, ASSET_ID);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'copy_not_authorized');
  assert.equal(putCalls, 0);
  assert.equal(dbCalls, 0);
});
