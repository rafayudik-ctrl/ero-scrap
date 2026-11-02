import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';
import { CollectorRepository } from '../../apps/api/src/repositories/collector-repository.js';

const NOW = '2026-11-01T12:00:00.000Z';
const ASSET_ID = 'a'.repeat(32);
const JOB_ID = '00000000-0000-4000-8000-000000000123';
const LEASE_TOKEN = 'b'.repeat(32);

async function createEligibleAsset() {
  const db = createSqliteD1();
  const repository = new CollectorRepository(db);
  await repository.upsertListingPosts([{
    id: 'AbCd1234',
    canonicalUrl: 'https://www.erome.com/a/AbCd1234',
    title: 'Authorized sample post',
    publishedAt: null,
  }], NOW);
  await repository.savePostInspection({
    postId: 'AbCd1234',
    title: 'Authorized sample post',
    tags: [{ name: 'sample', normalizedName: 'sample' }],
    videos: [{ sourceVideoId: 'Video1234', durationMs: 599_000 }],
    inspectedAt: NOW,
  }, NOW);
  const row = db.sqlite.prepare('SELECT id FROM video_assets LIMIT 1').get();
  assert.ok(row);
  await repository.updateEvaluations([{ id: row.id, status: 'eligible' }], NOW);
  return { db, repository, assetId: row.id };
}

test('eligible evaluations enqueue one idempotent process job and a lease returns only the matching video', async () => {
  const { db, repository, assetId } = await createEligibleAsset();
  try {
    await repository.updateEvaluations([{ id: assetId, status: 'eligible' }], NOW);
    const count = db.sqlite.prepare("SELECT COUNT(*) AS count FROM job_records WHERE job_type = 'process_video'").get().count;
    assert.equal(count, 1);

    const jobs = await repository.claimProcessVideoJobs({ now: NOW, limit: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].assetId, assetId);
    assert.equal(jobs[0].canonicalUrl, 'https://www.erome.com/a/AbCd1234');
    assert.equal(jobs[0].sourceVideoId, 'Video1234');
    assert.equal(jobs[0].durationMs, 599_000);
    assert.match(jobs[0].leaseToken, /^[a-f0-9]{32}$/u);
    assert.equal(db.sqlite.prepare('SELECT status FROM video_assets WHERE id = ?').get(assetId).status, 'processing');
  } finally {
    db.sqlite.close();
  }
});

test('process job completion stores MEGA metadata only with the current lease and a seven-day expiry', async () => {
  const { db, repository, assetId } = await createEligibleAsset();
  try {
    const jobs = await repository.claimProcessVideoJobs({ now: NOW, limit: 1 });
    const job = jobs[0];
    const uploadedAt = '2026-11-01T12:05:00.000Z';
    const expiresAt = '2026-11-08T12:05:00.000Z';
    const result = await repository.completeProcessVideoJob({
      jobId: job.jobId,
      assetId,
      leaseToken: job.leaseToken,
      objectId: `/Ero-Scrap/${assetId}/Video1234.mp4`,
      shareUrl: 'https://mega.nz/file/AbCdEf#privateKey',
      durationMs: 599_500,
      uploadedAt,
      expiresAt,
    });
    assert.deepEqual(result, { stored: true });
    const asset = db.sqlite.prepare('SELECT status, storage_provider, storage_object_id, share_url, uploaded_at, expires_at FROM video_assets WHERE id = ?').get(assetId);
    assert.equal(asset.status, 'stored');
    assert.equal(asset.storage_provider, 'mega');
    assert.equal(asset.storage_object_id, `/Ero-Scrap/${assetId}/Video1234.mp4`);
    assert.equal(asset.share_url, 'https://mega.nz/file/AbCdEf#privateKey');
    assert.equal(asset.expires_at, expiresAt);
    assert.equal(db.sqlite.prepare('SELECT status FROM job_records WHERE id = ?').get(job.jobId).status, 'succeeded');
  } finally {
    db.sqlite.close();
  }
});

test('stale process leases cannot complete or fail a job claimed by a newer runner', async () => {
  const { db, repository, assetId } = await createEligibleAsset();
  try {
    const first = (await repository.claimProcessVideoJobs({ now: NOW, limit: 1 }))[0];
    const later = '2026-11-01T12:31:00.000Z';
    const second = (await repository.claimProcessVideoJobs({ now: later, limit: 1 }))[0];
    assert.notEqual(first.leaseToken, second.leaseToken);
    await assert.rejects(repository.completeProcessVideoJob({
      jobId: first.jobId,
      assetId,
      leaseToken: first.leaseToken,
      objectId: `/Ero-Scrap/${assetId}/Video1234.mp4`,
      shareUrl: 'https://mega.nz/file/AbCdEf#privateKey',
      durationMs: 599_000,
      uploadedAt: later,
      expiresAt: '2026-11-08T12:31:00.000Z',
    }), (error) => error.code === 'media_lease_stale');
    const failure = await repository.failProcessVideoJob({
      jobId: first.jobId, assetId, leaseToken: first.leaseToken, attempts: 1,
      errorCode: 'media_network_error', now: later,
    });
    assert.equal(failure.stale, true);
  } finally {
    db.sqlite.close();
  }
});


test('process due probe detects pending and expired-leased jobs without claiming them', async () => {
  const { db, repository, assetId } = await createEligibleAsset();
  try {
    assert.equal(await repository.hasDueProcessVideoJobs({ now: NOW }), true);
    const claimed = await repository.claimProcessVideoJobs({ now: NOW, limit: 1 });
    assert.equal(claimed.length, 1);
    assert.equal(await repository.hasDueProcessVideoJobs({ now: NOW }), false,
      'an active lease is not due');
    const later = '2026-11-01T12:31:00.000Z';
    assert.equal(await repository.hasDueProcessVideoJobs({ now: later }), true,
      'an expired lease becomes due for recovery');
    assert.equal(db.sqlite.prepare('SELECT status FROM video_assets WHERE id = ?').get(assetId).status, 'processing');
  } finally {
    db.sqlite.close();
  }
});

test('retention due probe detects only expired assets or available deletion jobs', async () => {
  const { db, repository, assetId } = await createEligibleAsset();
  try {
    assert.equal(await repository.hasDueDeletionJobs({ now: NOW }), false);

    db.sqlite.prepare(`UPDATE video_assets
      SET status = 'stored', storage_provider = 'mega', storage_object_id = ?,
          uploaded_at = ?, expires_at = ? WHERE id = ?`).run(
      `/Ero-Scrap/${assetId}/clip.mp4`,
      '2026-11-01T11:00:00.000Z',
      '2026-11-02T11:00:00.000Z',
      assetId,
    );
    assert.equal(await repository.hasDueDeletionJobs({ now: NOW }), false);

    db.sqlite.prepare('UPDATE video_assets SET expires_at = ? WHERE id = ?')
      .run('2026-11-01T11:59:59.000Z', assetId);
    assert.equal(await repository.hasDueDeletionJobs({ now: NOW }), true);

    const claimed = await repository.claimDueDeletionJobs({ now: NOW, limit: 1 });
    assert.equal(claimed.length, 1);
    assert.equal(await repository.hasDueDeletionJobs({ now: NOW }), false,
      'a currently leased deletion is not due until its lease expires');

    const later = '2026-11-01T12:31:00.000Z';
    assert.equal(await repository.hasDueDeletionJobs({ now: later }), true,
      'an expired lease must be detected for recovery');
  } finally {
    db.sqlite.close();
  }
});
