-- Ero-Scrap Stage 1 schema.
-- Media rows represent videos only. Image candidates are discarded before persistence.
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  normalized_title TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  source_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  source_video_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'discovered', 'eligible', 'copy_blocked', 'queued', 'processing',
    'stored', 'clicked', 'delete_pending', 'deleted', 'ignored',
    'too_long', 'duration_unknown', 'error'
  )),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  storage_provider TEXT CHECK (storage_provider IS NULL OR storage_provider IN ('mega')),
  storage_object_id TEXT,
  share_url TEXT,
  thumbnail_key TEXT,
  discovered_at TEXT NOT NULL,
  uploaded_at TEXT,
  first_clicked_at TEXT,
  expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (post_id, source_video_id),
  CHECK (first_clicked_at IS NULL OR uploaded_at IS NOT NULL),
  CHECK (expires_at IS NULL OR uploaded_at IS NOT NULL),
  CHECK (status != 'stored' OR first_clicked_at IS NULL),
  CHECK (status != 'clicked' OR first_clicked_at IS NOT NULL),
  CHECK (status NOT IN ('stored', 'clicked', 'delete_pending') OR (uploaded_at IS NOT NULL AND expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK (pages_scanned BETWEEN 0 AND 2),
  posts_seen INTEGER NOT NULL DEFAULT 0 CHECK (posts_seen >= 0),
  matching_posts INTEGER NOT NULL DEFAULT 0 CHECK (matching_posts >= 0),
  video_candidates INTEGER NOT NULL DEFAULT 0 CHECK (video_candidates >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_records (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN (
    'scan', 'inspect_post', 'process_video', 'delete_video', 'cleanup'
  )),
  subject_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'succeeded', 'retry', 'dead', 'cancelled'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  leased_at TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Dedupe keys intentionally survive deletion of the media row for a retention window.
CREATE TABLE IF NOT EXISTS dedupe_keys (
  dedupe_key TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS keyword_rules (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_discovered_at
  ON posts (discovered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_normalized_title
  ON posts (normalized_title);
CREATE INDEX IF NOT EXISTS idx_tags_normalized_name
  ON tags (normalized_name);
CREATE INDEX IF NOT EXISTS idx_video_assets_status_expiry
  ON video_assets (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_video_assets_post
  ON video_assets (post_id);
CREATE INDEX IF NOT EXISTS idx_video_assets_discovered
  ON video_assets (discovered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_scan_runs_started
  ON scan_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_available
  ON job_records (status, available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry
  ON job_records (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_dedupe_expiry
  ON dedupe_keys (expires_at);
CREATE INDEX IF NOT EXISTS idx_keyword_rules_enabled
  ON keyword_rules (enabled, normalized_term);
CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
  ON audit_events (occurred_at DESC);
