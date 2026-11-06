-- Slice 5: the loop. See docs/p0-spec.md.

-- When a save aged into the Morgue (status 'morgue'): kept or acted-on copy
-- nobody touched for 30 days. NULL for everything else.
ALTER TABLE saves ADD COLUMN morgue_at TEXT;

-- One row per email the Worker tried to send, so a morning gets at most one
-- of each kind, and a failure shows on the Desk.
CREATE TABLE mail_log (
  date    TEXT NOT NULL,              -- YYYY-MM-DD, local to EDITION_TZ
  kind    TEXT NOT NULL CHECK (kind IN ('morning', 'missed')),
  sent_at TEXT,                       -- ISO 8601 UTC; NULL if it failed
  error   TEXT,                       -- why it failed, or NULL
  tried_at TEXT NOT NULL,
  PRIMARY KEY (date, kind)
);
