-- Optional thumbnail backend that needs no extra service (no R2, no credit card).
-- Selected with the THUMBNAIL_STORE variable ("d1" or "r2"). WebP previews are a
-- few kilobytes; they are stored as base64 text because the D1 client contract for
-- BLOB columns differs between runtimes. ON DELETE CASCADE removes a preview
-- together with its catalog row, so retention and pruning need no extra code.
CREATE TABLE IF NOT EXISTS thumbnails (
  asset_id TEXT PRIMARY KEY REFERENCES video_assets(id) ON DELETE CASCADE,
  data_b64 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 12 AND 262144),
  created_at TEXT NOT NULL
);
