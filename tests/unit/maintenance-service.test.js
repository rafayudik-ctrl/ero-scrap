import test from 'node:test';
import assert from 'node:assert/strict';
import { MaintenanceService } from '../../apps/runner/src/services/maintenance-service.js';
import { executeCollectorCommand } from '../../apps/api/src/services/collector-service.js';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';

const quiet = { info() {}, error() {} };

test('maintenance stops after the first partial batch', async () => {
  let calls = 0;
  const service = new MaintenanceService({
    repository: { async pruneStale() { calls += 1; return { videos: 3, posts: 1, scans: 0, jobs: 0 }; } },
    logger: quiet, batchSize: 500,
  });
  const totals = await service.runOnce();
  assert.equal(calls, 1);
  assert.deepEqual(totals, { videos: 3, posts: 1, scans: 0, jobs: 0, batches: 1 });
});

test('maintenance repeats full batches but never more than the cap', async () => {
  let calls = 0;
  const service = new MaintenanceService({
    repository: { async pruneStale() { calls += 1; return { videos: 0, posts: 500, scans: 0, jobs: 0 }; } },
    logger: quiet, batchSize: 500, maxBatches: 4,
  });
  await service.runOnce();
  assert.equal(calls, 4);
});

test('maintenance.prune is an allowlisted Worker command that cleans a real database', async () => {
  const d1 = createSqliteD1();
  d1.sqlite.prepare(`INSERT INTO posts (id, canonical_url, title, normalized_title, discovered_at, created_at, updated_at)
    VALUES ('OLDPOST1', 'https://www.erome.com/a/OLDPOST1', 'T', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  const result = await executeCollectorCommand(d1, 'maintenance.prune', { now: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(result, { videos: 0, posts: 1, scans: 0, jobs: 0 });
  await assert.rejects(executeCollectorCommand(d1, 'maintenance.prune', {}), /ISO date/u);
});

test('daily housekeeping only runs inside its UTC hour', async () => {
  let calls = 0;
  const repository = { async pruneStale() { calls += 1; return { videos: 0, posts: 0, scans: 0, jobs: 0 }; } };
  const at = (iso) => new MaintenanceService({ repository, logger: quiet, now: () => new Date(iso) });
  assert.equal(await at('2026-11-01T12:07:00Z').runIfDue(), null);
  assert.equal(calls, 0);
  const totals = await at('2026-11-01T03:17:00Z').runIfDue();
  assert.equal(calls, 1);
  assert.equal(totals.batches, 1);
});

test('prune removes dead process_video jobs but keeps dead deletion jobs', async () => {
  const d1 = createSqliteD1();
  const insert = d1.sqlite.prepare(`INSERT INTO job_records
    (id, job_type, subject_id, status, idempotency_key, available_at, created_at, updated_at)
    VALUES (?, ?, 'AAAA', 'dead', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  insert.run('00000000-0000-4000-8000-000000000001', 'process_video', 'process:x');
  insert.run('00000000-0000-4000-8000-000000000002', 'delete_video', 'retention:x');
  const result = await executeCollectorCommand(d1, 'maintenance.prune', { now: '2026-11-01T00:00:00.000Z' });
  assert.equal(result.jobs, 1);
  const left = d1.sqlite.prepare('SELECT job_type FROM job_records').all().map((row) => row.job_type);
  assert.deepEqual(left, ['delete_video']);
});
