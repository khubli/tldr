// The editor's tools: what the daily Claude run reads and writes over MCP.
// Each function takes the database and plain input, and returns plain data.
// Input comes from a model, so everything is checked here before it touches
// D1. Bad items are reported back, not thrown, so one bad item never sinks a
// whole batch.

export const VERDICTS = ["keep", "spike"] as const;
export const SPIKE_REASONS = ["hype", "bait", "repost", "stale", "basic", "offtopic"] as const;
export const ACTION_TYPES = ["try", "read", "apply", "post", "file"] as const;

const TEXT_CAP = 4000; // characters of a save's text sent to the editor
const MAX_BATCH = 50;
const MAX_HIGHLIGHTS = 10;

export class ToolInputError extends Error {}

// Open on the Desk: open, or snoozed and due again (see src/desk.ts).
// Same rule as the Desk: aged-out saves (status 'morgue', see src/loop.ts)
// and saves whose triage no longer carries an action (re-triaged as a spike)
// are off it.
const OPEN_ON_DESK =
  "(state = 'open' OR (state = 'snoozed' AND (due IS NULL OR due <= ?))) " +
  "AND save_id NOT IN (SELECT id FROM saves WHERE status = 'morgue') " +
  "AND save_id IN (SELECT save_id FROM triage WHERE action_type IS NOT NULL)";

// ── get_profile ─────────────────────────────────────────────────────────────

export interface Profile {
  version: number | null;
  updated_at: string | null;
  markdown: string;
}

export async function getProfile(db: D1Database): Promise<Profile> {
  const row = await db
    .prepare("SELECT version, markdown, updated_at FROM profile ORDER BY version DESC LIMIT 1")
    .first<{ version: number; markdown: string; updated_at: string }>();
  if (!row) {
    return {
      version: null,
      updated_at: null,
      markdown: "No profile loaded yet. Triage on general merit and say in the lede that the profile is missing.",
    };
  }
  return row;
}

// ── list_untriaged ──────────────────────────────────────────────────────────

export interface UntriagedSave {
  id: number;
  source: string;
  url: string | null;
  title: string | null;
  author: string | null;
  text: string | null;
  enriched_text: string | null;
  saved_at: string;
}

export async function listUntriaged(
  db: D1Database,
  limit: unknown,
): Promise<{ items: UntriagedSave[]; remaining: number }> {
  const n = intInRange(limit ?? 20, 1, MAX_BATCH, "limit");
  // Oldest first, so a backlog drains in order across runs.
  const { results } = await db
    .prepare(
      `SELECT id, source, url, title, author,
              substr(text, 1, ${TEXT_CAP}) AS text,
              substr(enriched_text, 1, ${TEXT_CAP}) AS enriched_text,
              saved_at
       FROM saves WHERE status = 'new'
       ORDER BY saved_at ASC, id ASC LIMIT ?`,
    )
    .bind(n)
    .all<UntriagedSave>();
  const total = await db.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'").first<{ n: number }>();
  return { items: results, remaining: Math.max(0, (total?.n ?? 0) - results.length) };
}

// ── save_triage ─────────────────────────────────────────────────────────────

interface TriageRow {
  save_id: number;
  verdict: (typeof VERDICTS)[number];
  spike_reason: string | null;
  headline: string;
  tldr: string | null;
  why_you: string | null;
  action_type: string | null;
  action_project: string | null;
  action_text: string | null;
  rank: number;
  tags: string[];
}

export interface SaveTriageResult {
  saved: number;
  actions_opened: number;
  errors: { id: unknown; error: string }[];
}

export async function saveTriage(db: D1Database, items: unknown, now: Date): Promise<SaveTriageResult> {
  if (!Array.isArray(items) || items.length === 0) throw new ToolInputError("items must be a non-empty array.");
  if (items.length > MAX_BATCH) throw new ToolInputError(`At most ${MAX_BATCH} items per call.`);

  const errors: SaveTriageResult["errors"] = [];
  const rows: TriageRow[] = [];
  for (const item of items) {
    try {
      rows.push(parseTriage(item));
    } catch (err) {
      const id = isObject(item) ? (item.id ?? item.save_id) : undefined;
      errors.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Drop ids that don't exist, and duplicates within the batch (last one wins).
  const byId = new Map(rows.map((r) => [r.save_id, r]));
  const known = await existingIds(db, [...byId.keys()]);
  for (const id of byId.keys()) {
    if (!known.has(id)) {
      errors.push({ id, error: "No save with this id." });
      byId.delete(id);
    }
  }
  if (byId.size === 0) return { saved: 0, actions_opened: 0, errors };

  const at = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  const actionStatementIndex: number[] = [];
  for (const r of byId.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO triage (save_id, verdict, spike_reason, headline, tldr, why_you,
                               action_type, action_project, action_text, rank, tags, triaged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (save_id) DO UPDATE SET
             verdict = excluded.verdict, spike_reason = excluded.spike_reason,
             headline = excluded.headline, tldr = excluded.tldr, why_you = excluded.why_you,
             action_type = excluded.action_type, action_project = excluded.action_project,
             action_text = excluded.action_text, rank = excluded.rank, tags = excluded.tags,
             triaged_at = excluded.triaged_at`,
        )
        .bind(
          r.save_id, r.verdict, r.spike_reason, r.headline, r.tldr, r.why_you,
          r.action_type, r.action_project, r.action_text, r.rank, JSON.stringify(r.tags), at,
        ),
      db.prepare("UPDATE saves SET status = 'triaged' WHERE id = ? AND status = 'new'").bind(r.save_id),
    );
    if (r.action_type) {
      // Opens an action once. One already done, snoozed or dropped stays as it is.
      actionStatementIndex.push(statements.length);
      statements.push(
        db
          .prepare("INSERT INTO actions (save_id, state, updated_at) VALUES (?, 'open', ?) ON CONFLICT (save_id) DO NOTHING")
          .bind(r.save_id, at),
      );
    } else {
      // A re-triage that drops the action clears it, unless it was already acted on.
      statements.push(db.prepare("DELETE FROM actions WHERE save_id = ? AND state = 'open'").bind(r.save_id));
    }
  }
  const results = await db.batch(statements);
  const opened = actionStatementIndex.reduce((sum, i) => sum + (results[i].meta.changes ?? 0), 0);
  return { saved: byId.size, actions_opened: opened, errors };
}

function parseTriage(item: unknown): TriageRow {
  if (!isObject(item)) throw new ToolInputError("Each item must be an object.");
  const save_id = intInRange(item.id ?? item.save_id, 1, Number.MAX_SAFE_INTEGER, "id");
  const verdict = oneOf(item.verdict, VERDICTS, "verdict");
  const headline = text(item.headline, 120, "headline", true)!;

  if (verdict === "spike") {
    return {
      save_id,
      verdict,
      spike_reason: oneOf(item.spike_reason, SPIKE_REASONS, "spike_reason"),
      headline,
      tldr: text(item.tldr, 500, "tldr", false),
      why_you: null,
      action_type: null,
      action_project: null,
      action_text: null,
      rank: item.rank == null ? 0 : intInRange(item.rank, 0, 100, "rank"),
      tags: tags(item.tags),
    };
  }

  let action_type: string | null = null;
  let action_project: string | null = null;
  let action_text: string | null = null;
  if (item.action != null) {
    if (!isObject(item.action)) throw new ToolInputError("action must be an object or null.");
    action_type = oneOf(item.action.type, ACTION_TYPES, "action.type");
    action_text = text(item.action.text, 200, "action.text", true);
    action_project = text(item.action.project, 40, "action.project", false)?.toLowerCase() ?? null;
  }
  return {
    save_id,
    verdict,
    spike_reason: null,
    headline,
    tldr: text(item.tldr, 500, "tldr", true),
    why_you: text(item.why_you, 200, "why_you", false),
    action_type,
    action_project,
    action_text,
    // A keep with no rank lands mid-table rather than being thrown away.
    rank: item.rank == null ? 50 : intInRange(item.rank, 0, 100, "rank"),
    tags: tags(item.tags),
  };
}

// ── publish_morning_run ─────────────────────────────────────────────────────

export interface RunStats {
  since: string | null; // the previous run, or null for the first run
  triaged: number;
  kept: number;
  spiked: number;
  spiked_by_reason: Record<string, number>;
  actions_open: number;
  untriaged_left: number;
}

export async function publishMorningRun(
  db: D1Database,
  input: { lede?: unknown; highlight_ids?: unknown },
  now: Date,
  timeZone: string,
): Promise<{ date: string; stats: RunStats; highlight_ids: number[] }> {
  const lede = text(input.lede, 1500, "lede", true)!;
  const highlights = input.highlight_ids == null ? [] : idList(input.highlight_ids, MAX_HIGHLIGHTS, "highlight_ids");
  if (highlights.length) {
    const kept = await keptIds(db, highlights);
    const bad = highlights.filter((id) => !kept.has(id));
    if (bad.length) throw new ToolInputError(`highlight_ids must be kept saves; not kept: ${bad.join(", ")}.`);
  }

  const date = localDate(now, timeZone);
  // Re-running the same morning replaces that morning's record, counted from
  // the run before it.
  const prev = await db
    .prepare("SELECT published_at FROM runs WHERE date < ? ORDER BY date DESC LIMIT 1")
    .bind(date)
    .first<{ published_at: string }>();
  const since = prev?.published_at ?? null;
  const stats = await runStats(db, since, now);

  await db
    .prepare(
      `INSERT INTO runs (date, lede, highlight_ids, stats, published_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (date) DO UPDATE SET lede = excluded.lede, highlight_ids = excluded.highlight_ids,
         stats = excluded.stats, published_at = excluded.published_at`,
    )
    .bind(date, lede, JSON.stringify(highlights), JSON.stringify(stats), now.toISOString())
    .run();
  return { date, stats, highlight_ids: highlights };
}

async function runStats(db: D1Database, since: string | null, now: Date): Promise<RunStats> {
  const after = since ?? "";
  const [byVerdict, open, left] = await db.batch<{ verdict?: string; spike_reason?: string | null; n: number }>([
    db
      .prepare("SELECT verdict, spike_reason, COUNT(*) AS n FROM triage WHERE triaged_at > ? GROUP BY verdict, spike_reason")
      .bind(after),
    db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE ${OPEN_ON_DESK}`).bind(now.toISOString()),
    db.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'"),
  ]);
  const stats: RunStats = {
    since,
    triaged: 0,
    kept: 0,
    spiked: 0,
    spiked_by_reason: {},
    actions_open: open.results[0]?.n ?? 0,
    untriaged_left: left.results[0]?.n ?? 0,
  };
  for (const row of byVerdict.results) {
    stats.triaged += row.n;
    if (row.verdict === "keep") stats.kept += row.n;
    else {
      stats.spiked += row.n;
      const reason = row.spike_reason ?? "unknown";
      stats.spiked_by_reason[reason] = (stats.spiked_by_reason[reason] ?? 0) + row.n;
    }
  }
  return stats;
}

// ── get_feedback ────────────────────────────────────────────────────────────

export interface FeedbackItem {
  save_id: number;
  state: string;
  updated_at: string;
  headline: string | null;
  action_type: string | null;
  action_project: string | null;
  action_text: string | null;
  tags: string[];
}

export async function getFeedback(
  db: D1Database,
  days: unknown,
  now: Date,
): Promise<{
  days: number;
  counts: Record<string, number>;
  by_type: Record<string, Record<string, number>>;
  actions_open: number;
  items: FeedbackItem[];
}> {
  const d = intInRange(days ?? 14, 1, 90, "days");
  const from = new Date(now.getTime() - d * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT a.save_id, a.state, a.updated_at, t.headline, t.action_type, t.action_project, t.action_text, t.tags
       FROM actions a JOIN triage t ON t.save_id = a.save_id
       WHERE a.state IN ('done', 'snoozed', 'dropped') AND a.updated_at >= ?
       ORDER BY a.updated_at DESC LIMIT 200`,
    )
    .bind(from)
    .all<Omit<FeedbackItem, "tags"> & { tags: string }>();
  // Counts cover the whole window; only the item list is capped.
  const { results: totals } = await db
    .prepare(
      `SELECT a.state, t.action_type, COUNT(*) AS n
       FROM actions a JOIN triage t ON t.save_id = a.save_id
       WHERE a.state IN ('done', 'snoozed', 'dropped') AND a.updated_at >= ?
       GROUP BY a.state, t.action_type`,
    )
    .bind(from)
    .all<{ state: string; action_type: string | null; n: number }>();
  const open = await db
    .prepare(`SELECT COUNT(*) AS n FROM actions WHERE ${OPEN_ON_DESK}`)
    .bind(now.toISOString())
    .first<{ n: number }>();

  const counts: Record<string, number> = { done: 0, snoozed: 0, dropped: 0 };
  const byType: Record<string, Record<string, number>> = {};
  for (const r of totals) {
    counts[r.state] = (counts[r.state] ?? 0) + r.n;
    const type = r.action_type ?? "none";
    byType[type] ??= { done: 0, snoozed: 0, dropped: 0 };
    byType[type][r.state] = (byType[type][r.state] ?? 0) + r.n;
  }
  const items = results.map((r) => ({ ...r, tags: parseTags(r.tags) }));
  return { days: d, counts, by_type: byType, actions_open: open?.n ?? 0, items };
}

// ── search_saves ────────────────────────────────────────────────────────────

export interface SearchHit {
  id: number;
  source: string;
  url: string | null;
  title: string | null;
  author: string | null;
  text: string | null;
  saved_at: string;
  status: string;
  verdict: string | null;
  headline: string | null;
  tldr: string | null;
}

export async function searchSaves(db: D1Database, query: unknown, limit: unknown): Promise<{ items: SearchHit[] }> {
  const q = text(query, 200, "query", true)!;
  const n = intInRange(limit ?? 10, 1, 25, "limit");
  // Every word must appear somewhere in the save or its triage.
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const haystack = `lower(coalesce(s.title,'') || ' ' || coalesce(s.text,'') || ' ' || coalesce(s.author,'') || ' ' ||
    coalesce(s.url,'') || ' ' || coalesce(t.headline,'') || ' ' || coalesce(t.tldr,'') || ' ' || coalesce(t.tags,''))`;
  const where = terms.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" AND ");
  const { results } = await db
    .prepare(
      `SELECT s.id, s.source, s.url, s.title, s.author, substr(s.text, 1, 300) AS text, s.saved_at, s.status,
              t.verdict, t.headline, t.tldr
       FROM saves s LEFT JOIN triage t ON t.save_id = s.id
       WHERE ${where}
       ORDER BY s.saved_at DESC LIMIT ?`,
    )
    .bind(...terms.map((t) => `%${t.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`), n)
    .all<SearchHit>();
  return { items: results };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function existingIds(db: D1Database, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { results } = await db
    .prepare(`SELECT id FROM saves WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

async function keptIds(db: D1Database, ids: number[]): Promise<Set<number>> {
  const { results } = await db
    .prepare(`SELECT save_id FROM triage WHERE verdict = 'keep' AND save_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ save_id: number }>();
  return new Set(results.map((r) => r.save_id));
}

/** YYYY-MM-DD in the given time zone. */
export function localDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intInRange(v: unknown, min: number, max: number, name: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolInputError(`${name} must be a number.`);
  const r = Math.round(n);
  if (r < min || r > max) throw new ToolInputError(`${name} must be between ${min} and ${max}.`);
  return r;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ToolInputError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}

function text(v: unknown, max: number, name: string, required: boolean): string | null {
  if (v == null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new ToolInputError(`${name} is required.`);
    return null;
  }
  if (typeof v !== "string") throw new ToolInputError(`${name} must be a string.`);
  const t = v.replace(/\u0000/g, "").trim();
  if (t.length > max) throw new ToolInputError(`${name} is too long (max ${max} characters).`);
  return t;
}

function tags(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ToolInputError("tags must be an array of strings.");
  const out = new Set<string>();
  for (const t of v) {
    if (typeof t !== "string") throw new ToolInputError("tags must be an array of strings.");
    const clean = t.trim().toLowerCase().slice(0, 30);
    if (clean) out.add(clean);
  }
  return [...out].slice(0, 8);
}

function idList(v: unknown, max: number, name: string): number[] {
  if (!Array.isArray(v)) throw new ToolInputError(`${name} must be an array of save ids.`);
  if (v.length > max) throw new ToolInputError(`${name} takes at most ${max} ids.`);
  return [...new Set(v.map((x) => intInRange(x, 1, Number.MAX_SAFE_INTEGER, name)))];
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
