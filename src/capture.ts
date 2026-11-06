// Capture: turns what the phone shares (or what is pasted) into a save.

export type CaptureSource = "share" | "paste";

export interface CaptureInput {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

export interface Capture {
  url: string | null;
  title: string | null;
  text: string | null;
}

export interface Save {
  id: number;
  source: string;
  url: string | null;
  title: string | null;
  author: string | null;
  text: string | null;
  saved_at: string;
  status: string;
}

export type SaveResult = { kind: "saved"; id: number } | { kind: "duplicate"; id: number } | { kind: "empty" };

const MAX_TITLE = 500;
const MAX_TEXT = 10_000;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i;

// Query parameters that only track where a link was shared from.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "si",
]);
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "www.twitter.com", "www.x.com"]);

/**
 * Android apps share in different ways: some fill `url`, many put the link
 * inside `text` (the X app sends "Post by @someone https://x.com/..."). Find
 * the link wherever it is and keep the rest as text.
 */
export function parseCapture(input: CaptureInput): Capture {
  const title = clean(input.title, MAX_TITLE);
  let text = clean(input.text, MAX_TEXT);
  let url = cleanUrl(input.url);

  if (!url && text) {
    const found = findUrl(text);
    if (found) {
      url = cleanUrl(found);
      // If the text was only the link, there is no text left to keep.
      const rest = text.replace(found, "").trim();
      text = /^[\s\p{P}]*$/u.test(rest) ? null : rest;
    }
  }
  if (!url && title) {
    const found = findUrl(title);
    if (found) url = cleanUrl(found);
  }
  return { url, title, text };
}

export function findUrl(value: string): string | null {
  const match = value.match(URL_PATTERN);
  if (!match) return null;
  // Drop sentence punctuation that tends to cling to the end of a link.
  return match[0].replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Returns a cleaned http(s) URL, or null if it isn't one. */
export function cleanUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";

  if (X_HOSTS.has(u.hostname)) {
    u.hostname = "x.com";
    u.protocol = "https:";
    u.searchParams.delete("s");
    u.searchParams.delete("t");
  }
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

/** Looks up author and text for a link (used for X posts). Null when unknown. */
export type PostLookup = (url: string) => Promise<{ author: string; text: string | null; title?: string | null } | null>;

export async function saveCapture(
  db: D1Database,
  source: CaptureSource,
  input: CaptureInput,
  now = new Date(),
  lookup?: PostLookup,
): Promise<SaveResult> {
  const capture = parseCapture(input);
  if (!capture.url && !capture.text && !capture.title) return { kind: "empty" };

  // The same link saved twice (from any source) is one save.
  if (capture.url) {
    const existing = await db.prepare("SELECT id FROM saves WHERE url = ? LIMIT 1").bind(capture.url).first<{ id: number }>();
    if (existing) return { kind: "duplicate", id: existing.id };
  }

  // A shared X post or YouTube video arrives as just a link. Fill in the
  // author (and the video's title) from the site's free public embed lookup.
  let author: string | null = null;
  if (capture.url && lookup) {
    const found = await lookup(capture.url);
    if (found) {
      author = found.author;
      if (found.text) capture.text = found.text.slice(0, MAX_TEXT);
      if (found.title && !capture.title) capture.title = found.title.slice(0, 300);
    }
  }

  const sourceId = capture.url ? `url:${capture.url}` : `text:${await sha256(`${capture.title ?? ""}\n${capture.text ?? ""}`)}`;
  const row = await db
    .prepare(
      `INSERT INTO saves (source, source_id, url, title, author, text, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, source_id) DO NOTHING
       RETURNING id`,
    )
    .bind(source, sourceId, capture.url, capture.title, author, capture.text, now.toISOString())
    .first<{ id: number }>();

  if (row) return { kind: "saved", id: row.id };

  const existing = await db
    .prepare("SELECT id FROM saves WHERE source = ? AND source_id = ?")
    .bind(source, sourceId)
    .first<{ id: number }>();
  return { kind: "duplicate", id: existing?.id ?? 0 };
}

/** Saves newest first; pass a status to see only those (e.g. 'new' = not yet triaged). */
export async function listSaves(db: D1Database, limit = 100, status?: Save["status"]): Promise<Save[]> {
  const where = status ? "WHERE status = ?" : "";
  const { results } = await db
    .prepare(
      `SELECT id, source, url, title, author, text, saved_at, status
       FROM saves ${where} ORDER BY saved_at DESC, id DESC LIMIT ?`,
    )
    .bind(...(status ? [status, limit] : [limit]))
    .all<Save>();
  return results;
}

export async function countSaves(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM saves").first<{ n: number }>();
  return row?.n ?? 0;
}

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\u0000/g, "").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
