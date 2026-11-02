import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFirstClickAndGetShareUrl } from '../../apps/api/src/repositories/catalog-repository.js';

function makeDb(existing, afterUpdate = existing) {
  const calls = [];
  let firstCount = 0;
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          firstCount += 1;
          calls.push({ type: 'first', sql, params: this.params });
          return firstCount === 1 ? existing : afterUpdate;
        },
        async run() {
          calls.push({ type: 'run', sql, params: this.params });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

const NOW = '2026-11-01T00:00:00.000Z';

test('first click validates a MEGA link before setting the 24-hour deadline', async () => {
  const shareUrl = 'https://mega.nz/file/AbCd#secret';
  const db = makeDb({ share_url: shareUrl }, { share_url: shareUrl, status: 'clicked' });
  assert.equal(await recordFirstClickAndGetShareUrl(db, 'a'.repeat(32), NOW), shareUrl);
  assert.deepEqual(db.calls.map((call) => call.type), ['first', 'run', 'first']);
  assert.match(db.calls[1].sql, /COALESCE\(first_clicked_at/u);
  assert.match(db.calls[1].sql, /CASE WHEN first_clicked_at IS NULL/u);
  assert.equal(db.calls[1].params[1], '2026-11-02T00:00:00.000Z');
});

test('invalid share URLs do not consume the first-click retention window', async () => {
  const db = makeDb({ share_url: 'https://mega.nz.evil.example/file/AbCd#key' });
  assert.equal(await recordFirstClickAndGetShareUrl(db, 'a'.repeat(32), NOW), null);
  assert.deepEqual(db.calls.map((call) => call.type), ['first']);
});

test('missing or expired catalog rows do not set a click timestamp', async () => {
  const db = makeDb(null);
  assert.equal(await recordFirstClickAndGetShareUrl(db, 'a'.repeat(32), NOW), null);
  assert.deepEqual(db.calls.map((call) => call.type), ['first']);
});
