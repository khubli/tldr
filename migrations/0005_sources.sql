-- More sources: GitHub stars and a YouTube playlist. See docs/p0-spec.md.

-- Sync state for each plug-in source (one row per source). X keeps its own
-- table because it also holds OAuth tokens; these sources need none here.
CREATE TABLE source_state (
  source          TEXT PRIMARY KEY,         -- 'github_star' | 'youtube'
  last_sync_at    TEXT,                     -- ISO 8601 UTC, last finished sync
  last_sync_added INTEGER,
  last_error      TEXT,
  backfill_done   INTEGER NOT NULL DEFAULT 0
);
