-- Slice 2: X bookmark sync. See docs/p0-spec.md, "Capture".

-- The one connected X account (single row, id = 1). Tokens live only in the
-- deployed database, never in the repo.
CREATE TABLE x_account (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  user_id           TEXT NOT NULL,
  username          TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT,
  expires_at        TEXT NOT NULL,           -- ISO 8601 UTC
  backfill_done     INTEGER NOT NULL DEFAULT 0,
  last_sync_at      TEXT,                    -- ISO 8601 UTC, last finished sync
  last_sync_added   INTEGER,
  last_error        TEXT,
  connected_at      TEXT NOT NULL
);

-- Short-lived OAuth login attempts (state + PKCE verifier), cleared after use.
CREATE TABLE x_oauth_state (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
