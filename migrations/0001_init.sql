-- tldr P0 schema. See docs/p0-spec.md, "Data (D1)".

-- Everything captured: X bookmarks and likes, phone shares, pastes.
CREATE TABLE saves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- 'share' | 'paste' | 'x_bookmark' | 'x_like' | ...
  source_id     TEXT NOT NULL,              -- stable id within the source, used to dedupe
  url           TEXT,                       -- cleaned link, if there is one
  title         TEXT,
  author        TEXT,
  text          TEXT,                       -- what was shared or posted
  enriched_text TEXT,                       -- readable text of the linked page (filled later)
  saved_at      TEXT NOT NULL,              -- ISO 8601 UTC
  status        TEXT NOT NULL DEFAULT 'new' -- 'new' | 'triaged' | 'morgue'
                CHECK (status IN ('new', 'triaged', 'morgue')),
  UNIQUE (source, source_id)
);
CREATE INDEX saves_saved_at ON saves (saved_at DESC);
CREATE INDEX saves_url ON saves (url);
CREATE INDEX saves_status ON saves (status);

-- The editor's verdict, one row per save.
CREATE TABLE triage (
  save_id        INTEGER PRIMARY KEY REFERENCES saves (id) ON DELETE CASCADE,
  verdict        TEXT NOT NULL CHECK (verdict IN ('keep', 'spike')),
  spike_reason   TEXT CHECK (spike_reason IN ('hype', 'bait', 'repost', 'stale', 'basic', 'offtopic')),
  headline       TEXT,
  tldr           TEXT,
  why_you        TEXT,
  action_type    TEXT CHECK (action_type IN ('try', 'read', 'apply', 'post', 'file')),
  action_project TEXT,
  action_text    TEXT,
  rank           INTEGER CHECK (rank BETWEEN 0 AND 100),
  tags           TEXT NOT NULL DEFAULT '[]', -- JSON array
  triaged_at     TEXT NOT NULL
);

-- The Desk: things to do.
CREATE TABLE actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  save_id    INTEGER NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'snoozed', 'dropped')),
  due        TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX actions_state ON actions (state);

-- One edition per day.
CREATE TABLE editions (
  date         TEXT PRIMARY KEY,            -- YYYY-MM-DD
  lede         TEXT NOT NULL,
  item_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array of save ids
  stats        TEXT NOT NULL DEFAULT '{}',  -- JSON
  published_at TEXT NOT NULL
);

-- The reader's profile (the lens for triage). Each edit is a new version.
-- Lives only in the deployed database, never in the repo.
CREATE TABLE profile (
  version    INTEGER PRIMARY KEY AUTOINCREMENT,
  markdown   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
