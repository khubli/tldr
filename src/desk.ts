// The Desk (D11): the one page. Reads what the editor kept and the open
// actions, and records the reader's Done / Snooze / Drop taps.
// Plain functions over D1; src/page.ts lays the results out.

export const SNOOZE_DAYS = 3; // a snoozed action comes back this many days later
export const SNOOZE_HOUR = 6; // ...at 6am local, in time for the morning run
const READING_ON_DESK = 10;
const LIST_CAP = 200;
export const PAGE_SIZE = 100; // rows per back page (/reading, /morgue)

export interface Paged<T> {
  items: T[];
  total: number;
  page: number; // 1-based
  pages: number;
}

export interface DeskAction {
  id: number;
  save_id: number;
  state: string;
  due: string | null;
  action_type: string;
  action_project: string | null;
  action_text: string | null;
  headline: string | null;
  url: string | null;
  author: string | null;
  source: string;
  saved_at: string;
}

export interface KeptSave {
  save_id: number;
  headline: string | null;
  tldr: string | null;
  why_you: string | null;
  rank: number | null;
  url: string | null;
  author: string | null;
  source: string;
  saved_at: string;
}

export interface SpikedSave {
  save_id: number;
  headline: string | null;
  spike_reason: string | null;
  url: string | null;
  author: string | null;
  source: string;
  saved_at: string;
}

export interface Desk {
  open: DeskAction[];
  snoozed: DeskAction[];
  doneThisWeek: number;
  reading: KeptSave[];
  readingTotal: number;
  spiked: number;
  spikedByReason: { reason: string; n: number }[];
  waiting: number; // saves the editor hasn't triaged yet
  aged: number; // saves that aged into the Morgue (src/loop.ts)
}

// An action is on the Desk when it is open, or snoozed and its time is up.
// Snoozes wake on read, so nothing has to run on a timer.
const AWAKE = "(a.state = 'open' OR (a.state = 'snoozed' AND (a.due IS NULL OR a.due <= ?1)))";
const ASLEEP = "(a.state = 'snoozed' AND a.due > ?1)";

const ACTION_COLUMNS = `a.id, a.save_id, a.state, a.due, t.action_type, t.action_project, t.action_text, t.headline,
  s.url, s.author, s.source, s.saved_at
  FROM actions a JOIN triage t ON t.save_id = a.save_id JOIN saves s ON s.id = a.save_id`;

// Kept saves that never got an action. Saves with an action live on the Desk
// (or are finished with), so they don't show twice.
const KEPT_WHERE = `t.verdict = 'keep' AND s.status = 'triaged'
  AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.save_id = t.save_id)`;
const KEPT_COLUMNS = `t.save_id, t.headline, t.tldr, t.why_you, t.rank, s.url, s.author, s.source, s.saved_at
  FROM triage t JOIN saves s ON s.id = t.save_id`;

export async function loadDesk(db: D1Database, now: Date): Promise<Desk> {
  const at = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [open, snoozed, done, reading, readingTotal, spiked, waiting, aged] = await db.batch<any>([
    db
      .prepare(
        `SELECT ${ACTION_COLUMNS}
         WHERE ${AWAKE} AND t.action_type IS NOT NULL AND s.status != 'morgue'
         ORDER BY t.rank DESC, a.id ASC LIMIT ${LIST_CAP}`,
      )
      .bind(at),
    db
      .prepare(
        `SELECT ${ACTION_COLUMNS}
         WHERE ${ASLEEP} AND t.action_type IS NOT NULL AND s.status != 'morgue'
         ORDER BY a.due ASC, a.id ASC LIMIT ${LIST_CAP}`,
      )
      .bind(at),
    db.prepare("SELECT COUNT(*) AS n FROM actions WHERE state = 'done' AND updated_at >= ?").bind(weekAgo),
    db.prepare(`SELECT ${KEPT_COLUMNS} WHERE ${KEPT_WHERE} ORDER BY t.rank DESC, s.saved_at DESC, s.id DESC LIMIT ?`).bind(READING_ON_DESK),
    db.prepare(`SELECT COUNT(*) AS n FROM triage t JOIN saves s ON s.id = t.save_id WHERE ${KEPT_WHERE}`),
    db.prepare(
      `SELECT coalesce(t.spike_reason, 'other') AS reason, COUNT(*) AS n
       FROM triage t JOIN saves s ON s.id = t.save_id
       WHERE t.verdict = 'spike' AND s.status = 'triaged'
       GROUP BY reason ORDER BY n DESC, reason ASC`,
    ),
    db.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'"),
    db.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'morgue'"),
  ]);
  const byReason = spiked.results as { reason: string; n: number }[];
  return {
    open: open.results as DeskAction[],
    snoozed: snoozed.results as DeskAction[],
    doneThisWeek: done.results[0]?.n ?? 0,
    reading: reading.results as KeptSave[],
    readingTotal: readingTotal.results[0]?.n ?? 0,
    spiked: byReason.reduce((sum, r) => sum + r.n, 0),
    spikedByReason: byReason,
    waiting: waiting.results[0]?.n ?? 0,
    aged: aged.results[0]?.n ?? 0,
  };
}

/** Every kept save without an action, best first (the "more in the pile" page). */
export async function listKept(db: D1Database, page = 1): Promise<Paged<KeptSave>> {
  const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [rows, total] = await db.batch<any>([
    db
      .prepare(`SELECT ${KEPT_COLUMNS} WHERE ${KEPT_WHERE} ORDER BY t.rank DESC, s.saved_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .bind(PAGE_SIZE, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM triage t JOIN saves s ON s.id = t.save_id WHERE ${KEPT_WHERE}`),
  ]);
  return paged(rows.results as KeptSave[], total.results[0]?.n ?? 0, page);
}

const SPIKED_WHERE = "t.verdict = 'spike' AND s.status = 'triaged'";

/** The numbers beside each section in the section bar. */
export interface SectionCounts {
  desk: number;
  reading: number;
  morgue: number;
}

export function countsFromDesk(desk: Desk): SectionCounts {
  return { desk: desk.open.length, reading: desk.readingTotal, morgue: desk.spiked + desk.aged };
}

/** Section counts for the back pages, which don't load the whole Desk. */
export async function loadCounts(db: D1Database, now: Date): Promise<SectionCounts> {
  const [desk, reading, morgue] = await db.batch<{ n: number }>([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM actions a JOIN triage t ON t.save_id = a.save_id JOIN saves s ON s.id = a.save_id
         WHERE ${AWAKE} AND t.action_type IS NOT NULL AND s.status != 'morgue'`,
      )
      .bind(now.toISOString()),
    db.prepare(`SELECT COUNT(*) AS n FROM triage t JOIN saves s ON s.id = t.save_id WHERE ${KEPT_WHERE}`),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM triage t JOIN saves s ON s.id = t.save_id WHERE ${SPIKED_WHERE})
            + (SELECT COUNT(*) FROM saves WHERE status = 'morgue') AS n`,
    ),
  ]);
  return { desk: desk.results[0]?.n ?? 0, reading: reading.results[0]?.n ?? 0, morgue: morgue.results[0]?.n ?? 0 };
}

/** What the editor spiked, newest verdict first (the Morgue page). */
export async function listSpiked(db: D1Database, page = 1): Promise<Paged<SpikedSave>> {
  const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
  const [rows, total] = await db.batch<any>([
    db
      .prepare(
        `SELECT t.save_id, t.headline, t.spike_reason, s.url, s.author, s.source, s.saved_at
         FROM triage t JOIN saves s ON s.id = t.save_id
         WHERE ${SPIKED_WHERE}
         ORDER BY t.triaged_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(PAGE_SIZE, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM triage t JOIN saves s ON s.id = t.save_id WHERE ${SPIKED_WHERE}`),
  ]);
  return paged(rows.results as SpikedSave[], total.results[0]?.n ?? 0, page);
}

function paged<T>(items: T[], total: number, page: number): Paged<T> {
  return { items, total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

// ── taps ────────────────────────────────────────────────────────────────────

export const TAPS = ["done", "snooze", "drop", "open"] as const;
export type Tap = (typeof TAPS)[number];

export function isTap(value: unknown): value is Tap {
  return typeof value === "string" && (TAPS as readonly string[]).includes(value);
}

/**
 * Records a tap on an action. "open" is the undo. Returns false when there is
 * no such action. The new state is what get_feedback reads, so the editor
 * learns from it.
 */
export async function tapAction(db: D1Database, id: number, tap: Tap, now: Date, timeZone: string): Promise<boolean> {
  const state = tap === "done" ? "done" : tap === "drop" ? "dropped" : tap === "snooze" ? "snoozed" : "open";
  const due = tap === "snooze" ? snoozeUntil(now, timeZone).toISOString() : null;
  const res = await db
    .prepare("UPDATE actions SET state = ?, due = ?, updated_at = ? WHERE id = ?")
    .bind(state, due, now.toISOString(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Brings a spiked save back as a keep, mid-table. Returns false when the save
 * isn't spiked. The triage time is left alone so run stats don't count it twice.
 */
export async function rescueSave(db: D1Database, saveId: number): Promise<boolean> {
  const [res] = await db.batch([
    db
      .prepare("UPDATE triage SET verdict = 'keep', spike_reason = NULL, rank = max(coalesce(rank, 0), 50) WHERE save_id = ? AND verdict = 'spike'")
      .bind(saveId),
    // A spiked save may still carry an action from an earlier keep (done,
    // snoozed or dropped). It would hide the rescue from the reading list.
    db
      .prepare("DELETE FROM actions WHERE save_id = ? AND EXISTS (SELECT 1 FROM triage WHERE save_id = ? AND action_type IS NULL)")
      .bind(saveId, saveId),
  ]);
  return (res.meta.changes ?? 0) > 0;
}

/** SNOOZE_DAYS from today, at SNOOZE_HOUR local time. */
export function snoozeUntil(now: Date, timeZone: string): Date {
  const tz = validZone(timeZone);
  const later = new Date(now.getTime() + SNOOZE_DAYS * 86_400_000);
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(later)
    .split("-")
    .map(Number);
  const guess = Date.UTC(y, m - 1, d, SNOOZE_HOUR);
  return new Date(guess - zoneOffsetMs(new Date(guess), tz));
}

// How far the zone's wall clock is ahead of UTC at this instant.
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

export function validZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}
