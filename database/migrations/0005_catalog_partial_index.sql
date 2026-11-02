-- Catalog listing only ever reads stored/clicked videos, newest first.
-- A partial index in exactly that order removes the in-memory sort and keeps
-- the page query proportional to the page size, however many discovered,
-- ignored or too-long rows exist.
CREATE INDEX IF NOT EXISTS idx_video_assets_catalog
  ON video_assets (discovered_at DESC, id DESC)
  WHERE status IN ('stored', 'clicked');
