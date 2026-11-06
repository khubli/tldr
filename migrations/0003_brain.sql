-- Slice 3: the brain (MCP). See docs/p0-spec.md and docs/brain.md.
--
-- D11 (5 Nov 2026) replaced dated daily editions with an always-current Desk.
-- The old `editions` table becomes `runs`: one record per morning run, with
-- the editor's lede and the run's numbers. It feeds the Desk and the email;
-- nothing is laid out by date.
ALTER TABLE editions RENAME TO runs;
ALTER TABLE runs RENAME COLUMN item_ids TO highlight_ids;

-- At most one action per save, so re-triaging a save never duplicates it.
CREATE UNIQUE INDEX actions_save ON actions (save_id);
CREATE INDEX actions_updated_at ON actions (updated_at);
CREATE INDEX triage_triaged_at ON triage (triaged_at);
