-- Durable Erome-to-storage media pipeline. URLs are never stored here;
-- process_video payloads contain only an asset ID and are resolved against
-- posts/video_assets when a runner claims the lease.
CREATE INDEX IF NOT EXISTS idx_jobs_process_claim
  ON job_records (job_type, status, available_at, lease_expires_at)
  WHERE job_type = 'process_video';

CREATE INDEX IF NOT EXISTS idx_video_assets_processing
  ON video_assets (status, updated_at)
  WHERE status IN ('eligible', 'processing', 'error');
