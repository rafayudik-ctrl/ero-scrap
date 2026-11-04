-- Failed-login counters for AUTH_MODE="password". One small row per client IP
-- plus one global row, rewritten only on a failed attempt and pruned daily.
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_start TEXT NOT NULL
);
