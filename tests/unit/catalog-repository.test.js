import test from 'node:test';
import assert from 'node:assert/strict';
import { listCatalogItems } from '../../apps/api/src/repositories/catalog-repository.js';

function createMockDb(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return {
            async all() { return { results: rows }; },
          };
        },
      };
    },
  };
}

const rows = [
  { id: 'c', title: 'C', duration_ms: 10_000, discovered_at: '2026-11-03T00:00:00.000Z', uploaded_at: '2026-11-03T00:00:00.000Z', expires_at: null, status: 'stored' },
  { id: 'b', title: 'B', duration_ms: 20_000, discovered_at: '2026-11-02T00:00:00.000Z', uploaded_at: '2026-11-02T00:00:00.000Z', expires_at: null, status: 'stored' },
  { id: 'a', title: 'A', duration_ms: 30_000, discovered_at: '2026-11-01T00:00:00.000Z', uploaded_at: '2026-11-01T00:00:00.000Z', expires_at: null, status: 'clicked' },
];

test('catalog uses bounded cursor pagination and requests one extra row', async () => {
  const db = createMockDb(rows);
  const page = await listCatalogItems(db, { limit: 2, cursor: null, query: '' });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  assert.equal(db.calls[0].bindings.at(-1), 3);
  assert.match(db.calls[0].sql, /ORDER BY a\.discovered_at DESC, a\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/i);
});

test('catalog normalizes search and binds terms instead of interpolating SQL', async () => {
  const db = createMockDb(rows.slice(0, 1));
  await listCatalogItems(db, { limit: 24, cursor: null, query: ' AÇÃO ' });
  assert.equal(db.calls[0].bindings[1], 'acao');
  assert.equal(db.calls[0].bindings[2], 'acao');
  assert.equal(db.calls[0].bindings.at(-1), 25);
  assert.match(db.calls[0].sql, /instr\(p\.normalized_title, \?\)/);
  assert.match(db.calls[0].sql, /a\.expires_at > \?/);
  assert.doesNotMatch(db.calls[0].sql, /AÇÃO/);
});

test('invalid cursors are rejected before reaching the database', async () => {
  const db = createMockDb(rows);
  const page = await listCatalogItems(db, { limit: 24, cursor: 'invalid', query: '' });
  assert.equal(page.invalidCursor, true);
  assert.equal(db.calls.length, 0);
});
