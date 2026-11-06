// The loop (slice 5): what keeps tldr running for a week without help.
// - The Morgue: kept or acted-on copy nobody touched for 30 days ages out.
// - Circulation: the week's numbers for the Sunday box.
// - The morning email and the missed-run warning (src/mail.ts lays them out).
// Plain functions over D1, like src/desk.ts.

import { localDate } from "./brain";
import { loadDesk, validZone } from "./desk";
import { composeMorning, composeMissed, type MailContent, type Highlight } from "./mail";

export const MORGUE_DAYS = 30;
export const MISSED_AFTER_HOUR = 8; // no run by 8am local: send a warning instead
const ACTIONS_IN_MAIL = 7;

// ── the Morgue ──────────────────────────────────────────────────────────────

/**
 * Moves untouched copy to the Morgue: kept saves with no action, triaged more
 * than 30 days ago, and saves whose action has sat open (or woken from a
 * snooze) for 30 days. Done and dropped actions are finished, not untouched.
 * Spiked saves stay in the spiked list (with Rescue) even if an old action
 * survived a re-triage.
 * Returns how many saves moved. Safe to run as often as you like.
 */
export async function ageOut(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MORGUE_DAYS * 86_400_000).toISOString();
  const at = now.toISOString();
  const res = await db
    .prepare(
      `UPDATE saves SET status = 'morgue', morgue_at = ?1
       WHERE status = 'triaged' AND id IN (
         SELECT t.save_id FROM triage t
         WHERE t.verdict = 'keep' AND t.triaged_at < ?2
           AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.save_id = t.save_id)
         UNION
         SELECT a.save_id FROM actions a JOIN triage t ON t.save_id = a.save_id
         WHERE t.verdict = 'keep' AND a.updated_at < ?2
           AND (a.state = 'open' OR (a.state = 'snoozed' AND (a.due IS NULL OR a.due <= ?1)))
       )`,
    )
    .bind(at, cutoff)
    .run();
  return res.meta.changes ?? 0;
}

export interface AgedSave {
  save_id: number;
  headline: string | null;
  action_text: string | null;
  url: string | null;
  author: string | null;
  source: string;
  saved_at: string;
  morgue_at: string | null;
}

/** What aged out, most recent first. */
export async function listAged(db: D1Database, limit = 100): Promise<{ items: AgedSave[]; total: number }> {
  const [rows, total] = await db.batch<any>([
    db
      .prepare(
        `SELECT s.id AS save_id, t.headline, t.action_text, s.url, s.author, s.source, s.saved_at, s.morgue_at
         FROM saves s JOIN triage t ON t.save_id = s.id
         WHERE s.status = 'morgue'
         ORDER BY s.morgue_at DESC, s.id DESC LIMIT ?`,
      )
      .bind(limit),
    db.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'morgue'"),
  ]);
  return { items: rows.results as AgedSave[], total: total.results[0]?.n ?? 0 };
}

/**
 * Brings an aged-out save back. Its action, if open, counts as touched today,
 * so it gets another 30 days. Returns false when the save isn't in the Morgue.
 */
export async function restoreSave(db: D1Database, saveId: number, now: Date): Promise<boolean> {
  const [res] = await db.batch([
    db.prepare("UPDATE saves SET status = 'triaged', morgue_at = NULL WHERE id = ? AND status = 'morgue'").bind(saveId),
    db
      .prepare("UPDATE actions SET state = 'open', due = NULL, updated_at = ? WHERE save_id = ? AND state IN ('open', 'snoozed')")
      .bind(now.toISOString(), saveId),
  ]);
  return (res.meta.changes ?? 0) > 0;
}

// ── circulation (the Sunday box) ────────────────────────────────────────────

export interface Circulation {
  saved: number; // filed in the last 7 days
  kept: number;
  spiked: number;
  acted: number; // actions marked done
  slop: number | null; // spiked / (kept + spiked), as a whole percent
}

export async function weekCirculation(db: D1Database, now: Date): Promise<Circulation> {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [saved, verdicts, acted] = await db.batch<any>([
    db.prepare("SELECT COUNT(*) AS n FROM saves WHERE saved_at >= ?").bind(from),
    db.prepare("SELECT verdict, COUNT(*) AS n FROM triage WHERE triaged_at >= ? GROUP BY verdict").bind(from),
    db.prepare("SELECT COUNT(*) AS n FROM actions WHERE state = 'done' AND updated_at >= ?").bind(from),
  ]);
  let kept = 0;
  let spiked = 0;
  for (const r of verdicts.results as { verdict: string; n: number }[]) {
    if (r.verdict === "keep") kept += r.n;
    else spiked += r.n;
  }
  const judged = kept + spiked;
  return {
    saved: saved.results[0]?.n ?? 0,
    kept,
    spiked,
    acted: acted.results[0]?.n ?? 0,
    slop: judged ? Math.round((spiked / judged) * 100) : null,
  };
}

export function isSunday(now: Date, timeZone: string): boolean {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: validZone(timeZone) }).format(now) === "Sunday";
}

// ── email ───────────────────────────────────────────────────────────────────

export interface MailEnv {
  DB: D1Database;
  MAILER?: SendEmail; // [[send_email]] binding, see wrangler.toml
  MAIL_FROM?: string; // e.g. tldr@yourdomain.example, on a domain with Cloudflare Email Routing
  MAIL_TO?: string; // defaults to ALLOWED_EMAIL
  ALLOWED_EMAIL?: string;
  SITE_URL?: string;
  EDITION_TZ?: string;
}

export type MailKind = "morning" | "missed";
export type MailOutcome = "sent" | "already sent" | "off" | `failed: ${string}`;

function mailSetup(env: MailEnv): { from: string; to: string } | null {
  const from = env.MAIL_FROM?.trim();
  const to = (env.MAIL_TO || env.ALLOWED_EMAIL)?.trim();
  if (!env.MAILER || !from || !to) return null;
  return { from, to };
}

/** Sends the morning email for today's run, once per morning. */
export async function sendMorningMail(env: MailEnv, now: Date): Promise<MailOutcome> {
  const tz = validZone(env.EDITION_TZ || "UTC");
  const date = localDate(now, tz);
  return sendOnce(env, date, "morning", now, async () => {
    const run = await env.DB.prepare("SELECT lede, highlight_ids, stats FROM runs WHERE date = ?")
      .bind(date)
      .first<{ lede: string; highlight_ids: string; stats: string }>();
    if (!run) return null;
    const [desk, highlights, week] = await Promise.all([
      loadDesk(env.DB, now),
      loadHighlights(env.DB, parseIds(run.highlight_ids)),
      isSunday(now, tz) ? weekCirculation(env.DB, now) : Promise.resolve(null),
    ]);
    return composeMorning({
      now,
      timeZone: tz,
      siteUrl: siteUrl(env),
      lede: run.lede,
      stats: parseStats(run.stats),
      actions: desk.open.slice(0, ACTIONS_IN_MAIL),
      actionsOpen: desk.open.length,
      highlights,
      week,
    });
  });
}

/**
 * Called by the cron. After 8am local, if the editor hasn't published today,
 * sends one short warning with what's on the Desk, so a broken scheduled task
 * never goes unnoticed for long.
 */
export async function checkMissedRun(env: MailEnv, now: Date): Promise<MailOutcome | "not yet" | "ran"> {
  const tz = validZone(env.EDITION_TZ || "UTC");
  if (localHour(now, tz) < MISSED_AFTER_HOUR) return "not yet";
  const date = localDate(now, tz);
  const ran = await env.DB.prepare("SELECT 1 AS ok FROM runs WHERE date = ?").bind(date).first();
  if (ran) return "ran";
  return sendOnce(env, date, "missed", now, async () => {
    const desk = await loadDesk(env.DB, now);
    return composeMissed({
      now,
      timeZone: tz,
      siteUrl: siteUrl(env),
      waiting: desk.waiting,
      actions: desk.open.slice(0, ACTIONS_IN_MAIL),
      actionsOpen: desk.open.length,
    });
  });
}

/** The last email problem, for the Desk's status line. Null when all is well. */
export async function lastMailError(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT error FROM mail_log ORDER BY tried_at DESC LIMIT 1")
    .first<{ error: string | null }>();
  return row?.error ?? null;
}

async function sendOnce(
  env: MailEnv,
  date: string,
  kind: MailKind,
  now: Date,
  compose: () => Promise<MailContent | null>,
): Promise<MailOutcome> {
  const setup = mailSetup(env);
  if (!setup) return "off";
  const prior = await env.DB.prepare("SELECT sent_at FROM mail_log WHERE date = ? AND kind = ?")
    .bind(date, kind)
    .first<{ sent_at: string | null }>();
  if (prior?.sent_at) return "already sent";
  const content = await compose();
  if (!content) return "off";

  let error: string | null = null;
  try {
    await env.MAILER!.send({ from: { name: "The tl;dr", email: setup.from }, to: setup.to, ...content });
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 300) || "unknown error";
    console.error(`${kind} email failed:`, error);
  }
  await env.DB.prepare(
    `INSERT INTO mail_log (date, kind, sent_at, error, tried_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (date, kind) DO UPDATE SET sent_at = excluded.sent_at, error = excluded.error, tried_at = excluded.tried_at`,
  )
    .bind(date, kind, error ? null : now.toISOString(), error, now.toISOString())
    .run();
  return error ? `failed: ${error}` : "sent";
}

async function loadHighlights(db: D1Database, ids: number[]): Promise<Highlight[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(
      `SELECT t.save_id, t.headline, t.tldr, t.why_you, s.url FROM triage t JOIN saves s ON s.id = t.save_id
       WHERE t.save_id IN (${ids.map(() => "?").join(", ")}) AND t.verdict = 'keep'`,
    )
    .bind(...ids)
    .all<Highlight & { save_id: number }>();
  const byId = new Map(results.map((r) => [r.save_id, r]));
  return ids.map((id) => byId.get(id)).filter((h): h is Highlight & { save_id: number } => !!h);
}

function parseIds(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function parseStats(raw: string): { triaged: number; kept: number; spiked: number; spiked_by_reason: Record<string, number> } {
  try {
    const v = JSON.parse(raw);
    return {
      triaged: Number(v.triaged) || 0,
      kept: Number(v.kept) || 0,
      spiked: Number(v.spiked) || 0,
      spiked_by_reason: v.spiked_by_reason && typeof v.spiked_by_reason === "object" ? v.spiked_by_reason : {},
    };
  } catch {
    return { triaged: 0, kept: 0, spiked: 0, spiked_by_reason: {} };
  }
}

function siteUrl(env: MailEnv): string {
  const raw = env.SITE_URL?.trim() || "";
  return /^https:\/\/[^/]+/.test(raw) ? raw.replace(/\/+$/, "") : "";
}

function localHour(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now);
  return Number(h);
}

