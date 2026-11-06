-- One small row remembers which Erome albums were already examined (see scan-service.js).
-- D1 free plan = 100,000 row writes/day: only posts that match the keyword are stored now.
CREATE TABLE IF NOT EXISTS scan_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
