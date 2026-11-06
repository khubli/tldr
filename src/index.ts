import { checkAccess, type AccessEnv } from "./access";
import { handleMcp, isMcpPath, type McpEnv } from "./mcp";
import { listSaves, saveCapture, type CaptureSource, type SaveResult } from "./capture";
import { isTap, listKept, listSpiked, loadCounts, loadDesk, rescueSave, tapAction } from "./desk";
import { ageOut, checkMissedRun, isSunday, lastMailError, listAged, restoreSave, weekCirculation, type MailEnv } from "./loop";
import { runEditor, type EditorEnv } from "./editor";
import { syncStars, type GitHubEnv } from "./github";
import { sourceStatuses } from "./sources";
import { lookupVideo, syncPlaylist, youTubeVideoId, type YouTubeEnv } from "./youtube";
import { readFlash, readUndo, renderDeskPage, renderFilePage, renderMorguePage, renderReadingPage, type Flash } from "./page";
import { finishConnect, getStatus, isConfigured, isXPostUrl, lookupPost, startConnect, syncBookmarks, type XEnv } from "./x";

export interface Env extends AccessEnv, XEnv, McpEnv, MailEnv, GitHubEnv, YouTubeEnv, EditorEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  EDITION_TZ?: string;
}

// Applied to every response: nothing is cached, nothing is framed, and pages
// load scripts and styles only from this site (plus Google Fonts).
const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "script-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The MCP endpoint is called by Claude's servers, which can't log in to
    // Access. It has an Access bypass and checks its own token (src/mcp.ts).
    if (isMcpPath(new URL(request.url).pathname)) {
      try {
        return withHeaders(await handleMcp(request, env));
      } catch (err) {
        console.error("MCP request failed:", err instanceof Error ? err.message : err);
        return withHeaders(new Response(null, { status: 500 }));
      }
    }

    // Fail closed: no verified Access login, no content. Not even a 404.
    const reader = await checkAccess(request, env);
    if (!reader) return withHeaders(new Response(null, { status: 403 }));

    try {
      return withHeaders(await route(request, env));
    } catch (err) {
      console.error("Request failed:", err instanceof Error ? err.message : err);
      return withHeaders(new Response("Something went wrong.", { status: 500 }));
    }
  },

  // Cron (wrangler.toml), every 3 hours: sync X bookmarks, age untouched
  // copy into the Morgue, and warn by email if the morning run didn't happen.
  // No request, so no Access check; it reads from X and D1, writes to D1, and
  // only ever emails the reader.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const step = (name: string, work: Promise<unknown>) =>
      work.catch((err) => console.error(`${name} failed:`, err instanceof Error ? err.message : err));
    // Sync first, so the editor (mode B, only with an AI key) sees the fresh
    // saves; then the missed-run check, so it sees a run that just published.
    ctx.waitUntil(
      Promise.all([
        step(
          "X sync",
          syncBookmarks(env).then((result) => {
            if (result.kind === "error") console.error("X sync failed:", result.message);
          }),
        ),
        step("GitHub stars sync", syncStars(env, now)),
        step("YouTube sync", syncPlaylist(env, now)),
        step("Morgue", ageOut(env.DB, now)),
      ])
        .then(() =>
          step(
            "Editor",
            runEditor(env, now).then((result) => {
              if (result.kind === "failed") console.error("Editor failed:", result.message);
            }),
          ),
        )
        .then(() => step("Missed-run check", checkMissedRun(env, now))),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  const isRead = request.method === "GET" || request.method === "HEAD";
  const now = new Date();
  const timeZone = env.EDITION_TZ || "UTC";

  // The Desk: the one page (D11).
  if (pathname === "/" && isRead) {
    const sunday = isSunday(now, timeZone);
    const [desk, x, mailError, week, sources] = await Promise.all([
      loadDesk(env.DB, now),
      getStatus(env),
      lastMailError(env.DB),
      sunday ? weekCirculation(env.DB, now) : Promise.resolve(null),
      sourceStatuses(env.DB),
    ]);
    return html(renderDeskPage({ desk, x, sources, mailError, week, flash: readFlash(url), undo: readUndo(url), now, timeZone }));
  }
  if (pathname === "/reading" && isRead) {
    const [list, counts] = await Promise.all([listKept(env.DB, readPage(url)), loadCounts(env.DB, now)]);
    return html(renderReadingPage({ list, counts, now, timeZone }));
  }
  if (pathname === "/morgue" && isRead) {
    const page = readPage(url);
    const [list, aged, counts] = await Promise.all([
      listSpiked(env.DB, page),
      page === 1 ? listAged(env.DB) : Promise.resolve(null),
      loadCounts(env.DB, now),
    ]);
    return html(renderMorguePage({ list, aged, counts, flash: readFlash(url), now, timeZone }));
  }
  if (pathname === "/file" && isRead) {
    const [saves, waiting, counts] = await Promise.all([
      listSaves(env.DB, 100, "new"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'").first<{ n: number }>(),
      loadCounts(env.DB, now),
    ]);
    return html(renderFilePage({ saves, waiting: waiting?.n ?? 0, counts, flash: readFlash(url), now, timeZone }));
  }

  // Done / Snooze / Drop on an action, and "open" to undo.
  const actionMatch = pathname.match(/^\/actions\/(\d{1,15})$/);
  if (actionMatch && request.method === "POST") {
    if (!isSameSite(request)) return new Response(null, { status: 403 });
    const tap = formString(await request.formData(), "do");
    if (!isTap(tap)) return new Response(null, { status: 400 });
    const id = Number(actionMatch[1]);
    const ok = await tapAction(env.DB, id, tap, now, timeZone);
    if (!ok) return redirect(url, "/", { flash: "gone" });
    const flash = tap === "done" ? "done" : tap === "snooze" ? "snoozed" : tap === "drop" ? "dropped" : "reopened";
    return redirect(url, "/", tap === "open" ? { flash } : { flash, undo: String(id) });
  }

  // Rescue a spiked save from the Morgue.
  const rescueMatch = pathname.match(/^\/saves\/(\d{1,15})\/rescue$/);
  if (rescueMatch && request.method === "POST") {
    if (!isSameSite(request)) return new Response(null, { status: 403 });
    const ok = await rescueSave(env.DB, Number(rescueMatch[1]));
    return redirect(url, "/morgue", { flash: ok ? "rescued" : "gone" });
  }

  // Bring an aged-out save back from the Morgue.
  const restoreMatch = pathname.match(/^\/saves\/(\d{1,15})\/restore$/);
  if (restoreMatch && request.method === "POST") {
    if (!isSameSite(request)) return new Response(null, { status: 403 });
    const ok = await restoreSave(env.DB, Number(restoreMatch[1]), now);
    return redirect(url, "/morgue", { flash: ok ? "restored" : "gone" });
  }

  // POST /share is the PWA share target; POST /save is the paste box.
  if ((pathname === "/share" || pathname === "/save") && request.method === "POST") {
    if (!isSameSite(request)) return new Response(null, { status: 403 });
    const source: CaptureSource = pathname === "/share" ? "share" : "paste";
    const form = await request.formData();
    const result = await saveCapture(
      env.DB,
      source,
      { title: formString(form, "title"), text: formString(form, "text"), url: formString(form, "url") },
      now,
      (link) => (isXPostUrl(link) ? lookupPost(link) : youTubeVideoId(link) ? lookupVideo(link) : Promise.resolve(null)),
    );
    return redirectAfterFiling(url, result);
  }

  // X login. Both steps sit behind the Access check like everything else.
  if (pathname === "/auth/x/connect" && request.method === "GET") {
    if (!isConfigured(env)) return flashHome(url, "x_unset");
    return Response.redirect(await startConnect(env, url.origin), 302);
  }
  if (pathname === "/auth/x/callback" && request.method === "GET") {
    if (!isConfigured(env)) return flashHome(url, "x_unset");
    const result = await finishConnect(env, url);
    if (!result.ok) console.error("X connect failed:", result.reason);
    return flashHome(url, result.ok ? "x_connected" : "x_failed");
  }

  // "Sync now" button: X, plus GitHub stars and YouTube when they're set up.
  // Their results show on the status line; the flash reports X.
  if (pathname === "/x/sync" && request.method === "POST") {
    if (!isSameSite(request)) return new Response(null, { status: 403 });
    const [result] = await Promise.all([syncBookmarks(env), syncStars(env, now), syncPlaylist(env, now)]);
    return flashHome(url, result.kind === "ok" ? "x_synced" : "x_sync_failed");
  }

  if (request.method === "GET" || request.method === "HEAD") {
    return env.ASSETS.fetch(request);
  }
  return new Response(null, { status: 405 });
}

// Blocks other sites from posting into tldr with the reader's cookie. A share
// from the phone's share sheet arrives as a top-level navigation the browser
// marks "none"; the paste box is "same-origin".
function isSameSite(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site" || site === "same-site") return false;
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null" && origin !== new URL(request.url).origin) return false;
  return true;
}

// After filing, a share from the phone lands on the Desk; the paste box
// returns to its own page so another can be filed.
function redirectAfterFiling(url: URL, result: SaveResult): Response {
  const flash = result.kind === "saved" ? "filed" : result.kind;
  return redirect(url, url.pathname === "/save" ? "/file" : "/", { flash });
}

function flashHome(url: URL, flash: NonNullable<Flash>): Response {
  return redirect(url, "/", { flash });
}

function redirect(url: URL, path: string, params: Record<string, string>): Response {
  const location = new URL(path, url.origin);
  for (const [k, v] of Object.entries(params)) location.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { Location: location.toString() } });
}

function readPage(url: URL): number {
  const value = url.searchParams.get("page") ?? "";
  return /^\d{1,6}$/.test(value) ? Math.max(1, Number(value)) : 1;
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function formString(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" ? value : null;
}

function withHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}
