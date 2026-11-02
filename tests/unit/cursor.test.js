import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../../apps/api/src/lib/cursor.js';

const cursorValue = {
  discoveredAt: '2026-11-01T10:00:00.000Z',
  id: 'video_01',
};

test('cursor round-trips validated pagination values', () => {
  const encoded = encodeCursor(cursorValue);
  assert.deepEqual(decodeCursor(encoded), cursorValue);
});

test('invalid cursor tokens are rejected safely', () => {
  assert.equal(decodeCursor('not-a-valid-cursor'), null);
  assert.equal(decodeCursor('x'.repeat(600)), null);
  assert.equal(decodeCursor(''), null);
});

test('cursor encoder rejects malformed input', () => {
  assert.throws(() => encodeCursor({ discoveredAt: 'bad', id: 'id' }), /timestamp/);
  assert.throws(() => encodeCursor({ discoveredAt: cursorValue.discoveredAt, id: '' }), /id/);
});
