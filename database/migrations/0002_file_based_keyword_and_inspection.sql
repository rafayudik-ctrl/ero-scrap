-- The search term has exactly one source of truth: config/search-keyword.txt.
-- Never edit migration 0001 after it has been applied; retire its old table here.
DROP INDEX IF EXISTS idx_keyword_rules_enabled;
DROP TABLE IF EXISTS keyword_rules;

-- Posts are inspected once to cache tags and video metadata. This allows a
-- keyword change to re-evaluate recent posts without repeatedly fetching them.
ALTER TABLE posts ADD COLUMN details_checked_at TEXT;
CREATE INDEX IF NOT EXISTS idx_posts_details_pending
  ON posts (details_checked_at, discovered_at DESC);
