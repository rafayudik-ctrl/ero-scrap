-- The scan log accepted at most 2 pages (CHECK ... BETWEEN 0 AND 2). Scans can now read
-- up to 6 pages. SQLite cannot alter a CHECK, so rebuild the small log table, keeping only
-- the most recent rows (the catalog reads just the latest scan), which keeps writes tiny.
CREATE TABLE scan_runs_new (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  pages_scanned INTEGER NOT NULL DEFAULT 0 CHECK (pages_scanned BETWEEN 0 AND 6),
  posts_seen INTEGER NOT NULL DEFAULT 0 CHECK (posts_seen >= 0),
  matching_posts INTEGER NOT NULL DEFAULT 0 CHECK (matching_posts >= 0),
  video_candidates INTEGER NOT NULL DEFAULT 0 CHECK (video_candidates >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO scan_runs_new
  SELECT id, started_at, finished_at, status, pages_scanned, posts_seen, matching_posts,
         video_candidates, error_code, created_at
  FROM scan_runs
  ORDER BY started_at DESC
  LIMIT 20;

DROP TABLE scan_runs;
ALTER TABLE scan_runs_new RENAME TO scan_runs;
