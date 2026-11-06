// Shared sync bookkeeping for the plug-in sources (GitHub stars, YouTube).
// Each source reads from an official API on the cron, writes new saves, and
// records how the last sync went in `source_state` for the Desk's status line.

export type SourceId = "github_star" | "youtube";

export interface SourceStatus {
  source: SourceId;
  lastSyncAt: string | null;
  lastSyncAdded: number | null;
  lastError: string | null;
}

export type SourceSyncResult =
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ok"; added: number };

export interface NewSave {
  source_id: string;
  url: string;
  title: string | null;
  author: string | null;
  text: string | null;
  enriched_text?: string | null;
  saved_at: string; // ISO 8601 UTC
}

export async function getState(db: D1Database, source: SourceId): Promise<{ backfill_done: number } | null> {
  return db.prepare("SELECT backfill_done FROM source_state WHERE source = ?").bind(source).first();
}

export async function sourceStatuses(db: D1Database): Promise<SourceStatus[]> {
  const { results } = await db
    .prepare("SELECT source, last_sync_at, last_sync_added, last_error FROM source_state ORDER BY source")
    .all<{ source: SourceId; last_sync_at: string | null; last_sync_added: number | null; last_error: string | null }>();
  return results.map((r) => ({ source: r.source, lastSyncAt: r.last_sync_at, lastSyncAdded: r.last_sync_added, lastError: r.last_error }));
}

export async function recordOk(db: D1Database, source: SourceId, added: number, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_state (source, last_sync_at, last_sync_added, last_error, backfill_done) VALUES (?, ?, ?, NULL, 1)
       ON CONFLICT (source) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_sync_added = excluded.last_sync_added,
         last_error = NULL, backfill_done = 1`,
    )
    .bind(source, now.toISOString(), added)
    .run();
}

export async function recordError(db: D1Database, source: SourceId, message: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO source_state (source, last_error) VALUES (?, ?)
       ON CONFLICT (source) DO UPDATE SET last_error = excluded.last_error`,
    )
    .bind(source, message.slice(0, 300))
    .run();
}

/** The source ids from this list that are already saved. */
export async function knownIds(db: D1Database, source: SourceId, ids: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT source_id FROM saves WHERE source = ? AND source_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(source, ...chunk)
      .all<{ source_id: string }>();
    for (const r of results) known.add(r.source_id);
  }
  return known;
}

/** Inserts saves, oldest first; a save already there (same source id or same link) is skipped. */
export async function insertSaves(db: D1Database, source: SourceId, saves: NewSave[]): Promise<number> {
  if (saves.length === 0) return 0;
  const ordered = [...saves].sort((a, b) => a.saved_at.localeCompare(b.saved_at));
  const stmts = ordered.map((s) =>
    db
      .prepare(
        `INSERT INTO saves (source, source_id, url, title, author, text, enriched_text, saved_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE NOT EXISTS (SELECT 1 FROM saves WHERE url = ?3)
         ON CONFLICT (source, source_id) DO NOTHING`,
      )
      .bind(source, s.source_id, s.url, s.title, s.author, s.text, s.enriched_text ?? null, s.saved_at),
  );
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
