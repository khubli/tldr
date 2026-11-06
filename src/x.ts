// X sync: OAuth 2.0 (PKCE) login, token refresh, and bookmark sync.
//
// Only bookmarks are read (owned reads, $0.001 per post). The bookmarks API
// has no date filter and returns newest first, so:
//   - the first sync pages through everything X will return (the backfill);
//   - later syncs read small pages and stop at the first page with nothing new.
// That way each run pays for new bookmarks plus one small page of old ones.

export interface XEnv {
  DB: D1Database;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
}

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_API = "https://api.x.com/2";
export const CALLBACK_PATH = "/auth/x/callback";
export const SCOPES = "bookmark.read tweet.read users.read offline.access";

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 2 * 60 * 1000;
export const BACKFILL_PAGE_SIZE = 100;
export const BACKFILL_MAX_PAGES = 20; // hard stop at 2,000 posts (about $2)
export const SYNC_PAGE_SIZE = 10;
export const SYNC_MAX_PAGES = 10;

export interface XAccount {
  user_id: string;
  username: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  backfill_done: number;
  last_sync_at: string | null;
  last_sync_added: number | null;
  last_error: string | null;
}

export type XStatus =
  | { connected: false; configured: boolean }
  | { connected: true; username: string; lastSyncAt: string | null; lastSyncAdded: number | null; lastError: string | null };

export function isConfigured(env: XEnv): boolean {
  return Boolean(env.X_CLIENT_ID?.trim() && env.X_CLIENT_SECRET?.trim());
}

export async function getAccount(db: D1Database): Promise<XAccount | null> {
  return db.prepare("SELECT * FROM x_account WHERE id = 1").first<XAccount>();
}

export async function getStatus(env: XEnv): Promise<XStatus> {
  const account = await getAccount(env.DB);
  if (!account) return { connected: false, configured: isConfigured(env) };
  return {
    connected: true,
    username: account.username,
    lastSyncAt: account.last_sync_at,
    lastSyncAdded: account.last_sync_added,
    lastError: account.last_error,
  };
}

// ---------------------------------------------------------------- OAuth

/** Starts the login: stores a one-time state and PKCE verifier, returns X's authorize URL. */
export async function startConnect(env: XEnv, origin: string, now = new Date()): Promise<string> {
  const state = randomToken(24);
  const verifier = randomToken(48);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM x_oauth_state WHERE created_at < ?").bind(new Date(now.getTime() - STATE_TTL_MS).toISOString()),
    env.DB.prepare("INSERT INTO x_oauth_state (state, code_verifier, created_at) VALUES (?, ?, ?)").bind(state, verifier, now.toISOString()),
  ]);
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.X_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", origin + CALLBACK_PATH);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type ConnectResult = { ok: true; username: string } | { ok: false; reason: string };

/** Finishes the login: checks state, swaps the code for tokens, looks up who connected. */
export async function finishConnect(env: XEnv, url: URL, now = new Date()): Promise<ConnectResult> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return { ok: false, reason: "X login was cancelled." };
  if (!state || !code) return { ok: false, reason: "X login came back incomplete." };

  // One-time use: the state row is deleted whether or not it is still fresh.
  const row = await env.DB.prepare("DELETE FROM x_oauth_state WHERE state = ? RETURNING code_verifier, created_at")
    .bind(state)
    .first<{ code_verifier: string; created_at: string }>();
  if (!row) return { ok: false, reason: "X login expired. Try again." };
  if (now.getTime() - new Date(row.created_at).getTime() > STATE_TTL_MS) return { ok: false, reason: "X login expired. Try again." };

  const tokens = await requestToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: url.origin + CALLBACK_PATH,
    code_verifier: row.code_verifier,
  });
  if (!tokens) return { ok: false, reason: "X didn't accept the login. Try again." };

  const me = await fetch(`${X_API}/users/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!me.ok) return { ok: false, reason: "Couldn't read the X account." };
  const user = ((await me.json()) as { data?: { id?: string; username?: string } }).data;
  if (!user?.id || !user.username) return { ok: false, reason: "Couldn't read the X account." };

  await env.DB.prepare(
    `INSERT INTO x_account (id, user_id, username, access_token, refresh_token, expires_at, connected_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       backfill_done = CASE WHEN x_account.user_id = excluded.user_id THEN x_account.backfill_done ELSE 0 END,
       user_id = excluded.user_id, username = excluded.username,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, connected_at = excluded.connected_at, last_error = NULL`,
  )
    .bind(user.id, user.username, tokens.access_token, tokens.refresh_token ?? null, expiresAt(tokens, now), now.toISOString())
    .run();
  return { ok: true, username: user.username };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function requestToken(env: XEnv, params: Record<string, string>): Promise<TokenResponse | null> {
  const id = env.X_CLIENT_ID!.trim();
  const secret = env.X_CLIENT_SECRET!.trim();
  const res = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
    },
    body: new URLSearchParams({ ...params, client_id: id }).toString(),
  });
  if (!res.ok) {
    console.error("X token request failed:", res.status);
    return null;
  }
  const body = (await res.json()) as TokenResponse;
  return typeof body.access_token === "string" ? body : null;
}

function expiresAt(tokens: TokenResponse, now: Date): string {
  const seconds = typeof tokens.expires_in === "number" ? tokens.expires_in : 7200;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/** Returns a usable access token, refreshing it first if it is about to expire. */
async function freshToken(env: XEnv, account: XAccount, now: Date, force = false): Promise<string | null> {
  if (!force && new Date(account.expires_at).getTime() - now.getTime() > REFRESH_EARLY_MS) return account.access_token;
  if (!account.refresh_token) return null;
  const tokens = await requestToken(env, { grant_type: "refresh_token", refresh_token: account.refresh_token });
  if (!tokens) return null;
  // X rotates refresh tokens: the old one stops working once used.
  const refresh = tokens.refresh_token ?? account.refresh_token;
  await env.DB.prepare("UPDATE x_account SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = 1")
    .bind(tokens.access_token, refresh, expiresAt(tokens, now))
    .run();
  account.access_token = tokens.access_token;
  account.refresh_token = refresh;
  return tokens.access_token;
}

// ---------------------------------------------------------------- Sync

export interface Bookmark {
  id: string;
  text: string;
  username: string | null;
}

export type SyncResult =
  | { kind: "not_connected" }
  | { kind: "error"; message: string }
  | { kind: "ok"; added: number; pages: number; backfill: boolean };

export async function syncBookmarks(env: XEnv, now = new Date()): Promise<SyncResult> {
  if (!isConfigured(env)) return { kind: "not_connected" };
  const account = await getAccount(env.DB);
  if (!account) return { kind: "not_connected" };

  const backfill = !account.backfill_done;
  const pageSize = backfill ? BACKFILL_PAGE_SIZE : SYNC_PAGE_SIZE;
  const maxPages = backfill ? BACKFILL_MAX_PAGES : SYNC_MAX_PAGES;

  const fresh: Bookmark[] = [];
  let pages = 0;
  let token: string | undefined;
  let reachedEnd = false;
  let lastPageNew = 0;
  try {
    while (pages < maxPages) {
      const page = await fetchPage(env, account, now, pageSize, token);
      pages++;
      const newOnes = await unseen(env.DB, page.bookmarks);
      lastPageNew = newOnes.length;
      fresh.push(...newOnes);
      if (!page.next) {
        reachedEnd = true;
        break;
      }
      // Newest first: a page with nothing new means the rest is already here.
      if (!backfill && newOnes.length === 0) break;
      token = page.next;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DB.prepare("UPDATE x_account SET last_error = ? WHERE id = 1").bind(message).run();
    // Keep whatever was read before the failure.
    await insertBookmarks(env.DB, fresh, now);
    return { kind: "error", message };
  }

  const added = await insertBookmarks(env.DB, fresh, now);
  // A normal sync that hit its page cap while still finding new bookmarks
  // (say, after days of failed syncs) would stop at the saved top page next
  // time and miss the rest. Run a full pass next time instead.
  const fellBehind = !backfill && !reachedEnd && pages >= maxPages && lastPageNew > 0;
  const backfillDone = backfill ? 1 : fellBehind ? 0 : 1;
  await env.DB.prepare(
    `UPDATE x_account SET last_sync_at = ?, last_sync_added = ?, last_error = NULL, backfill_done = ?
     WHERE id = 1`,
  )
    .bind(now.toISOString(), added, backfillDone)
    .run();
  return { kind: "ok", added, pages, backfill };
}

interface Page {
  bookmarks: Bookmark[];
  next?: string;
}

class XApiError extends Error {}

async function fetchPage(env: XEnv, account: XAccount, now: Date, size: number, paginationToken?: string): Promise<Page> {
  const url = new URL(`${X_API}/users/${encodeURIComponent(account.user_id)}/bookmarks`);
  url.searchParams.set("max_results", String(size));
  url.searchParams.set("tweet.fields", "author_id,created_at,note_tweet");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

  let access = await freshToken(env, account, now);
  if (!access) throw new XApiError("X login has expired. Reconnect X.");
  let res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  if (res.status === 401) {
    access = await freshToken(env, account, now, true);
    if (!access) throw new XApiError("X login has expired. Reconnect X.");
    res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  }
  if (res.status === 429) throw new XApiError("X rate limit hit. The next sync will pick up from here.");
  if (res.status === 402) throw new XApiError("X API credits are used up or the spending limit was reached.");
  if (!res.ok) throw new XApiError(`X bookmarks request failed (${res.status}).`);
  return parsePage(await res.json());
}

interface RawPage {
  data?: { id: string; text?: string; author_id?: string; note_tweet?: { text?: string } }[];
  includes?: { users?: { id: string; username?: string }[] };
  meta?: { next_token?: string; result_count?: number };
}

export function parsePage(body: unknown): Page {
  const raw = (body ?? {}) as RawPage;
  const users = new Map((raw.includes?.users ?? []).map((u) => [u.id, u.username ?? null]));
  const bookmarks = (raw.data ?? [])
    .filter((p) => typeof p.id === "string" && /^\d+$/.test(p.id))
    .map((p) => ({
      id: p.id,
      // Long posts carry their full text in note_tweet; `text` is cut short.
      text: (p.note_tweet?.text || p.text || "").trim(),
      username: (p.author_id && users.get(p.author_id)) || null,
    }));
  return { bookmarks, next: raw.meta?.next_token || undefined };
}

export function postUrl(b: Bookmark): string {
  return `https://x.com/${b.username ?? "i"}/status/${b.id}`;
}

/** Bookmarks not yet in saves, by post id or (for posts shared from the phone) by link. */
async function unseen(db: D1Database, bookmarks: Bookmark[]): Promise<Bookmark[]> {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string | null>();
  // D1 allows 100 bound values per query: 2 per bookmark, so 50 at a time.
  for (let i = 0; i < bookmarks.length; i += 50) {
    const chunk = bookmarks.slice(i, i + 50);
    const marks = Array(chunk.length).fill("?").join(",");
    const { results } = await db
      .prepare(
        `SELECT source_id, url FROM saves
         WHERE (source = 'x_bookmark' AND source_id IN (${marks})) OR url IN (${marks})`,
      )
      .bind(...chunk.map((b) => b.id), ...chunk.map(postUrl))
      .all<{ source_id: string; url: string | null }>();
    for (const r of results) {
      seenIds.add(r.source_id);
      seenUrls.add(r.url);
    }
  }
  return bookmarks.filter((b) => !seenIds.has(b.id) && !seenUrls.has(postUrl(b)));
}

/**
 * X doesn't say when something was bookmarked, so saved_at is the time tldr
 * first saw it. Rows go in oldest first so the newest bookmark sorts on top.
 */
async function insertBookmarks(db: D1Database, bookmarks: Bookmark[], now: Date): Promise<number> {
  if (bookmarks.length === 0) return 0;
  const savedAt = now.toISOString();
  const stmts = [...bookmarks].reverse().map((b) =>
    db
      .prepare(
        `INSERT INTO saves (source, source_id, url, author, text, saved_at)
         VALUES ('x_bookmark', ?, ?, ?, ?, ?)
         ON CONFLICT (source, source_id) DO NOTHING`,
      )
      .bind(b.id, postUrl(b), b.username ? `@${b.username}` : null, b.text || null, savedAt),
  );
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// ---------------------------------------------------------------- oEmbed

const X_STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/;

export function isXPostUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "x.com" && X_STATUS_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Author and text for a post shared from the phone, from X's free public
 * embed endpoint. Returns null on any failure; the save is kept either way.
 */
export async function lookupPost(url: string): Promise<{ author: string; text: string | null } | null> {
  try {
    const endpoint = new URL("https://publish.twitter.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("omit_script", "1");
    endpoint.searchParams.set("dnt", "true");
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { author_url?: string; html?: string };
    const handle = body.author_url ? new URL(body.author_url).pathname.split("/").filter(Boolean)[0] : null;
    if (!handle) return null;
    return { author: `@${handle}`, text: embedText(body.html ?? "") };
  } catch {
    return null;
  }
}

/** The post text is the first <p> of the embed's blockquote. */
export function embedText(html: string): string | null {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return null;
  const text = decodeEntities(match[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  return text || null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------- helpers

function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
