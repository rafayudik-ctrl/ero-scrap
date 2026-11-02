-- Stage 3: catalog delivery, thumbnail metadata, and durable retention jobs.
-- The video_assets columns for storage and expiry were introduced in 0001.

ALTER TABLE video_assets
  ADD COLUMN thumbnail_content_type TEXT
  CHECK (thumbnail_content_type IS NULL OR thumbnail_content_type = 'image/webp');

CREATE INDEX IF NOT EXISTS idx_video_assets_retention_due
  ON video_assets (expires_at, id)
  WHERE status IN ('stored', 'clicked', 'delete_pending');

CREATE INDEX IF NOT EXISTS idx_jobs_retention_claim
  ON job_records (job_type, status, available_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_video_assets_thumbnail
  ON video_assets (thumbnail_key)
  WHERE thumbnail_key IS NOT NULL;
