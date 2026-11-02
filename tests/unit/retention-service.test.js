import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../../apps/runner/src/services/retention-service.js';

const NOW = '2026-11-01T00:00:00.000Z';

function makeJob(overrides = {}) {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'b'.repeat(32),
    assetId: 'a'.repeat(32),
    attempts: 1,
    storageProvider: 'mega',
    storageObjectId: `/Ero-Scrap/${'a'.repeat(32)}/clip.mp4`,
    thumbnailKey: `thumbnails/${'a'.repeat(32)}.webp`,
    ...overrides,
  };
}

test('retention removes the remote object before completing catalog deletion', async () => {
  const events = [];
  const service = new RetentionService({
    repository: {
      async claimDueDeletionJobs(params) { events.push(['claim', params]); return [makeJob()]; },
      async completeDeletion(params) { events.push(['complete', params]); },
      async failDeletion() { throw new Error('must not fail'); },
    },
    storageProviders: {
      mega: {
        async deleteObject(params) { events.push(['remote-delete', params]); return { deleted: true }; },
      },
    },
    now: () => new Date(NOW),
    logger: { info() {}, error() {} },
  });

  const result = await service.runOnce();
  assert.deepEqual(result, { claimed: 1, deleted: 1, retried: 0, dead: 0, stale: 0 });
  assert.deepEqual(events.map(([name]) => name), ['claim', 'remote-delete', 'complete']);
  assert.equal(events[2][1].leaseToken, 'b'.repeat(32));
});

test('retention does not remove catalog metadata when the remote deletion is unconfirmed', async () => {
  let completed = false;
  let failed = null;
  const service = new RetentionService({
    repository: {
      async claimDueDeletionJobs() { return [makeJob()]; },
      async completeDeletion() { completed = true; },
      async failDeletion(params) { failed = params; return { retry: true, dead: false }; },
    },
    storageProviders: {
      mega: { async deleteObject() { return { deleted: false }; } },
    },
    now: () => new Date(NOW),
    logger: { info() {}, error() {} },
  });

  const result = await service.runOnce();
  assert.equal(completed, false);
  assert.equal(failed.errorCode, 'storage_delete_unconfirmed');
  assert.deepEqual(result, { claimed: 1, deleted: 0, retried: 1, dead: 0, stale: 0 });
});

test('retention rejects unknown providers and records a bounded retry', async () => {
  let failure;
  const service = new RetentionService({
    repository: {
      async claimDueDeletionJobs() { return [makeJob({ storageProvider: 'unknown' })]; },
      async completeDeletion() { throw new Error('must not complete'); },
      async failDeletion(params) { failure = params; return { retry: false, dead: true }; },
    },
    storageProviders: {},
    now: () => new Date(NOW),
    logger: { info() {}, error() {} },
  });
  const result = await service.runOnce();
  assert.equal(failure.errorCode, 'storage_provider_unavailable');
  assert.deepEqual(result, { claimed: 1, deleted: 0, retried: 0, dead: 1, stale: 0 });
});


test('retention ignores a job when its lease was replaced by another runner', async () => {
  const events = [];
  const service = new RetentionService({
    repository: {
      async claimDueDeletionJobs() { return [makeJob()]; },
      async completeDeletion() { throw Object.assign(new Error('stale lease'), { code: 'retention_lease_stale' }); },
      async failDeletion(params) { events.push(params); return { retry: false, dead: false, stale: true }; },
    },
    storageProviders: { mega: { async deleteObject() { return { deleted: true }; } } },
    now: () => new Date(NOW),
    logger: { info() {}, error() {} },
  });
  const result = await service.runOnce();
  assert.equal(events[0].leaseToken, 'b'.repeat(32));
  assert.deepEqual(result, { claimed: 1, deleted: 0, retried: 0, dead: 0, stale: 1 });
});


test('retention keeps draining while batches come back full, within the batch cap', async () => {
  const claims = [];
  const queue = [[makeJob({ jobId: '1'.repeat(36) }), makeJob({ jobId: '2'.repeat(36) })],
    [makeJob({ jobId: '3'.repeat(36) }), makeJob({ jobId: '4'.repeat(36) })], [makeJob({ jobId: '5'.repeat(36) })]];
  const service = new RetentionService({
    repository: {
      async claimDueDeletionJobs(params) { claims.push(params.limit); return queue.shift() ?? []; },
      async completeDeletion() {},
      async failDeletion() { throw new Error('must not fail'); },
    },
    storageProviders: { mega: { async deleteObject() { return { deleted: true }; } } },
    now: () => new Date(NOW), limit: 2, maxBatches: 5,
    logger: { info() {}, error() {} },
  });
  const result = await service.runOnce();
  assert.equal(result.deleted, 5);
  assert.deepEqual(claims, [2, 2, 2], 'stops after the first partial batch');

  const capped = new RetentionService({
    repository: {
      async claimDueDeletionJobs() { return [makeJob(), makeJob()]; },
      async completeDeletion() {},
      async failDeletion() {},
    },
    storageProviders: { mega: { async deleteObject() { return { deleted: true }; } } },
    now: () => new Date(NOW), limit: 2, maxBatches: 3,
    logger: { info() {}, error() {} },
  });
  assert.equal((await capped.runOnce()).claimed, 6, 'never loops past maxBatches');
});


test('retention due-check delegates to the private repository with the current time', async () => {
  let received;
  const service = new RetentionService({
    repository: {
      async hasDueDeletionJobs(params) { received = params; return true; },
      async claimDueDeletionJobs() { return []; },
      async completeDeletion() {},
      async failDeletion() {},
    },
    storageProviders: {},
    now: () => new Date(NOW),
    logger: { info() {}, error() {} },
  });
  assert.equal(await service.hasDue(), true);
  assert.deepEqual(received, { now: NOW });
});
