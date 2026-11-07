import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  normalizeTag,
  matchesKeywordRules,
  evaluateDuration,
  DURATION_STATUS,
  classifyMediaCandidate,
  selectVideoCandidates,
  calculateExpiry,
  registerFirstClick,
  isExpired,
} from '../../packages/domain/src/index.js';

const fixedUpload = '2026-11-01T12:00:00.000Z';

test('normalizes accents, case and whitespace deterministically', () => {
  assert.equal(normalizeText('  CÂMERA   LENTA  '), 'camera lenta');
  assert.equal(normalizeTag('#AÇÃO'), 'acao');
});

test('matches title OR tags, independent of case and accents', () => {
  assert.equal(matchesKeywordRules({ title: 'Uma publicação', tags: ['Ação'], terms: ['acao'] }), true);
  assert.equal(matchesKeywordRules({ title: 'Ação especial', tags: [], terms: ['especial'] }), true);
  assert.equal(matchesKeywordRules({ title: 'Sem correspondência', tags: ['outro'], terms: ['xyz'] }), false);
  assert.equal(matchesKeywordRules({ title: 'qualquer coisa', tags: [], terms: [] }), false);
});

test('duration accepts exactly 600 seconds and rejects unknown or invalid values', () => {
  assert.equal(evaluateDuration(600_000), DURATION_STATUS.ACCEPTED);
  assert.equal(evaluateDuration(600_001), DURATION_STATUS.TOO_LONG);
  assert.equal(evaluateDuration(null), DURATION_STATUS.UNKNOWN);
  assert.equal(evaluateDuration(undefined), DURATION_STATUS.UNKNOWN);
  assert.equal(evaluateDuration(0), DURATION_STATUS.INVALID);
  assert.equal(evaluateDuration(1.5), DURATION_STATUS.INVALID);
});

test('image candidates are rejected before video processing', () => {
  assert.equal(classifyMediaCandidate({ type: 'image' }), 'ignored_image');
  assert.equal(classifyMediaCandidate({ type: 'video' }), 'video_candidate');
  assert.equal(classifyMediaCandidate({ type: 'audio' }), 'unsupported_media');
});

test('image-only posts yield no assets and mixed posts yield every video only', () => {
  assert.deepEqual(selectVideoCandidates([{ type: 'image' }, { type: 'image' }]), []);
  const selected = selectVideoCandidates([
    { type: 'image', id: 'image-1' },
    { type: 'video', id: 'video-1' },
    { type: 'image', id: 'image-2' },
    { type: 'video', id: 'video-2' },
  ]);
  assert.deepEqual(selected.map((item) => item.id), ['video-1', 'video-2']);
});

test('unopened retention is the configured number of days (default 4) after successful upload', () => {
  assert.equal(calculateExpiry({ uploadedAt: fixedUpload }), '2026-11-05T12:00:00.000Z');
});

test('first click changes retention to 24 hours after first click', () => {
  const result = registerFirstClick({
    uploadedAt: fixedUpload,
    clickedAt: '2026-11-03T14:30:00.000Z',
  });
  assert.equal(result.firstClickedAt, '2026-11-03T14:30:00.000Z');
  assert.equal(result.expiresAt, '2026-11-04T14:30:00.000Z');
  assert.equal(result.changed, true);
});

test('subsequent clicks never extend the original deadline', () => {
  const result = registerFirstClick({
    uploadedAt: fixedUpload,
    firstClickedAt: '2026-11-03T14:30:00.000Z',
    clickedAt: '2026-11-04T10:00:00.000Z',
  });
  assert.equal(result.expiresAt, '2026-11-04T14:30:00.000Z');
  assert.equal(result.changed, false);
});

test('retention rejects invalid timestamps and click before upload', () => {
  assert.throws(() => calculateExpiry({ uploadedAt: 'invalid' }), /uploadedAt/);
  assert.throws(() => registerFirstClick({
    uploadedAt: fixedUpload,
    clickedAt: '2026-11-01T11:59:00.000Z',
  }), /earlier/);
});

test('expiry boundary is inclusive', () => {
  assert.equal(isExpired('2026-11-02T00:00:00.000Z', new Date('2026-11-02T00:00:00.000Z')), true);
  assert.equal(isExpired('2026-11-02T00:00:00.000Z', new Date('2026-11-01T23:59:59.999Z')), false);
});
