-- Stage 3 hardening: ownership token for each retention lease.
-- A stale runner must never complete or reschedule a job claimed by a newer runner.
ALTER TABLE job_records ADD COLUMN lease_token TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_retention_active_lease
  ON job_records (job_type, status, lease_expires_at, lease_token);
