// The pages, set in the broadsheet type from docs/design-brief.md.
//
// D11: home is the Desk. Top to bottom: masthead, the section bar, one sync
// line, open actions with Done / Snooze / Drop, the ranked "Worth reading"
// list, and one quiet line to the Morgue. Every page carries the section bar
// (Desk, Reading, Morgue, + Add), so nothing is hidden behind a footer link.

import type { Save } from "./capture";
import type { Desk, DeskAction, KeptSave, Paged, SectionCounts, SpikedSave } from "./desk";
import { countsFromDesk, SNOOZE_DAYS, validZone } from "./desk";
import type { AgedSave, Circulation } from "./loop";
import { MORGUE_DAYS } from "./loop";
import type { SourceStatus } from "./sources";
import type { XStatus } from "./x";

const FLASHES = [
  "filed", "duplicate", "empty",
  "x_connected", "x_failed", "x_unset", "x_synced", "x_sync_failed",
  "done", "snoozed", "dropped", "reopened", "gone", "rescued", "restored",
] as const;
export type Flash = (typeof FLASHES)[number] | null;

export function readFlash(url: URL): Flash {
  const value = url.searchParams.get("flash");
  return (FLASHES as readonly string[]).includes(value ?? "") ? (value as Flash) : null;
}

/** The action id an "Undo" should reopen, if the URL carries a valid one. */
export function readUndo(url: URL): number | null {
  const value = url.searchParams.get("undo") ?? "";
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

// ── the Desk (home) ─────────────────────────────────────────────────────────

export interface DeskPageInput {
  desk: Desk;
  x?: XStatus;
  sources?: SourceStatus[]; // GitHub stars, YouTube: only once they've synced
  mailError?: string | null; // the last morning email failed
  week?: Circulation | null; // Sundays: the circulation box
  flash: Flash;
  undo: number | null;
  now: Date;
  timeZone: string;
}

export function renderDeskPage({ desk, x, sources, mailError, week, flash, undo, now, timeZone }: DeskPageInput): string {
  const tz = validZone(timeZone);
  return shell(
    "The tl;dr",
    `${masthead(now, tz, "desk", countsFromDesk(desk))}
${renderStatusLine(x, desk.waiting, now)}
${renderSourcesLine(sources ?? [], now)}
${mailError ? `<p class="status kicker"><span class="status-error">Morning email didn't send: ${escapeHtml(mailError)}</span></p>` : ""}
${renderFlash(flash, undo)}
<main class="desk-page">
${week ? renderCirculation(week) : ""}
${renderActions(desk, now, tz)}
${renderReading(desk, now)}
</main>
${renderSpikedLine(desk)}`,
  );
}

// One line under the masthead: X's last sync, plus copy waiting for the editor.
function renderStatusLine(x: XStatus | undefined, waiting: number, now: Date): string {
  const waitingNote = waiting > 0 ? ` · ${waiting} waiting for the editor` : "";
  if (!x) return `<p class="status kicker">${waitingNote.slice(3)}</p>`;
  if (!x.connected) {
    const action = x.configured ? `<a href="/auth/x/connect">Connect X</a>` : "X not set up";
    return `<p class="status kicker">${action}${waitingNote}</p>`;
  }
  const synced = x.lastSyncAt ? `Synced ${relativeTime(x.lastSyncAt, now)}, ${x.lastSyncAdded ?? 0} new` : "Not synced yet";
  const error = x.lastError
    ? `\n  <span class="status-error">${escapeHtml(x.lastError)}${/reconnect/i.test(x.lastError) ? ` <a href="/auth/x/connect">Reconnect</a>` : ""}</span>`
    : "";
  return `<form class="status kicker" method="post" action="/x/sync">
  <span>X @${escapeHtml(x.username)} · ${escapeHtml(synced)}${waitingNote} · <button class="link" type="submit">Sync now</button></span>${error}
</form>`;
}

// One more quiet line for the other sources, once they've synced at least once.
function renderSourcesLine(sources: SourceStatus[], now: Date): string {
  if (!sources.length) return "";
  const parts = sources.map((s) => {
    const name = s.source === "github_star" ? "GitHub stars" : "YouTube";
    const synced = s.lastSyncAt ? `synced ${relativeTime(s.lastSyncAt, now)}, ${s.lastSyncAdded ?? 0} new` : "not synced yet";
    return `${name} ${escapeHtml(synced)}`;
  });
  const errors = sources
    .filter((s) => s.lastError)
    .map((s) => `<span class="status-error">${s.source === "github_star" ? "GitHub" : "YouTube"}: ${escapeHtml(s.lastError!)}</span>`)
    .join("");
  return `<p class="status kicker"><span>${parts.join(" · ")}</span>${errors}</p>`;
}

function renderActions(desk: Desk, now: Date, tz: string): string {
  const count = `${desk.open.length} open${desk.doneThisWeek ? ` · ${desk.doneThisWeek} done this week` : ""}`;
  const items = desk.open.length
    ? `<ol class="actions">\n${desk.open.map((a, i) => renderAction(a, i === 0, now)).join("\n")}\n</ol>`
    : `<p class="empty">Nothing on the Desk. The editor adds to it each morning.</p>`;
  const snoozed = desk.snoozed.length
    ? `<details class="snoozed">
  <summary class="kicker">${desk.snoozed.length} snoozed</summary>
  <ol class="actions">\n${desk.snoozed.map((a) => renderSnoozed(a, tz)).join("\n")}\n  </ol>
</details>`
    : "";
  return `<section class="desk" id="desk" aria-labelledby="desk-label">
  <header class="section-head">
    <h2 id="desk-label">The Desk</h2>
    <span class="kicker">${count}</span>
  </header>
  ${items}
  ${snoozed}
</section>`;
}

function renderAction(a: DeskAction, lead: boolean, now: Date): string {
  return `<li class="action${lead ? " lead" : ""}" id="a${a.id}">
  <p class="kicker${lead ? " spot" : ""}">${escapeHtml(actionKicker(a))}</p>
  <h3>${escapeHtml(a.action_text || a.headline || "Untitled")}</h3>
  <p class="from">From ${sourceLink(a.headline || "the original", a.url)}, saved ${escapeHtml(relativeTime(a.saved_at, now))}.</p>
  <form class="stamps" method="post" action="/actions/${a.id}">
    <button name="do" value="done" type="submit">Done</button>
    <button name="do" value="snooze" type="submit">Snooze ${SNOOZE_DAYS} days</button>
    <button name="do" value="drop" type="submit">Drop</button>
  </form>
</li>`;
}

function renderSnoozed(a: DeskAction, tz: string): string {
  return `<li class="action asleep">
  <p class="kicker">${escapeHtml(actionKicker(a))} · Back ${escapeHtml(shortDay(a.due, tz))}</p>
  <h3>${escapeHtml(a.action_text || a.headline || "Untitled")}</h3>
  <form class="stamps" method="post" action="/actions/${a.id}">
    <button name="do" value="open" type="submit">Wake</button>
  </form>
</li>`;
}

function actionKicker(a: DeskAction): string {
  const type = a.action_type.charAt(0).toUpperCase() + a.action_type.slice(1);
  return a.action_project ? `${type} · ${a.action_project}` : type;
}

function renderReading(desk: Desk, now: Date): string {
  const more = desk.readingTotal - desk.reading.length;
  const items = desk.reading.length
    ? `<ol class="reading">\n${desk.reading.map((k, i) => renderKept(k, now, i === 0)).join("\n")}\n</ol>`
    : `<p class="empty">Nothing kept yet. Once the editor reads your saves, the best of them land here.</p>`;
  return `<section class="worth" aria-labelledby="worth-label">
  <header class="section-head">
    <h2 id="worth-label">Worth reading</h2>
    <span class="kicker">${desk.readingTotal} kept · by value to you</span>
  </header>
  ${items}
  ${more > 0 ? `<p class="jump kicker"><a href="/reading">${more} more in the pile ›</a></p>` : ""}
</section>`;
}

function renderKept(k: KeptSave, now: Date, lead = false): string {
  return `<li class="kept${lead ? " lead" : ""}">
  <h3>${sourceLink(k.headline || "Untitled", k.url)}</h3>
  ${k.tldr ? `<p class="tldr">${escapeHtml(k.tldr)}</p>` : ""}
  ${k.why_you ? `<p class="why"><span class="why-label">Why you:</span> ${escapeHtml(k.why_you)}</p>` : ""}
  <p class="byline">${escapeHtml(byline(k))} · ${escapeHtml(relativeTime(k.saved_at, now))}</p>
</li>`;
}

// Sundays: the week in numbers, boxed like a newspaper's circulation notice.
function renderCirculation(w: Circulation): string {
  const figure = (n: number, label: string) => `<div><span class="figure">${n}</span> ${label}</div>`;
  return `<aside class="circulation" aria-labelledby="circ-label">
  <h2 id="circ-label" class="kicker">Circulation, the last 7 days</h2>
  <div class="figures">${figure(w.saved, "saved")}${figure(w.kept, "kept")}${figure(w.spiked, "spiked")}${figure(w.acted, "acted")}</div>
  ${w.slop === null ? "" : `<p class="slop">Slop ratio <strong>${w.slop}%</strong> of what the editor read was spiked.</p>`}
</aside>`;
}

function renderSpikedLine(desk: Desk): string {
  if (desk.spiked === 0) return `<footer class="spiked-line kicker">Nothing spiked yet</footer>`;
  const reasons = desk.spikedByReason
    .slice(0, 3)
    .map((r) => `${r.reason} ${r.n}`)
    .join(", ");
  return `<footer class="spiked-line kicker"><a href="/morgue">${desk.spiked} spiked · ${escapeHtml(reasons)} ›</a></footer>`;
}

// ── the pile: every kept save ───────────────────────────────────────────────

export function renderReadingPage({ list, counts, now, timeZone }: { list: Paged<KeptSave>; counts: SectionCounts; now: Date; timeZone: string }): string {
  const { items } = list;
  const tz = validZone(timeZone);
  return shell(
    "Worth reading · The tl;dr",
    `${masthead(now, tz, "reading", counts)}
<main>
<section class="worth" aria-labelledby="worth-label">
  <header class="section-head">
    <h2 id="worth-label">Worth reading</h2>
    <span class="kicker">${list.total} kept · by value to you</span>
  </header>
  ${items.length ? `<ol class="reading">\n${items.map((k) => renderKept(k, now)).join("\n")}\n</ol>` : `<p class="empty">Nothing kept yet.</p>`}
  ${pager("/reading", list)}
</section>
</main>`,
  );
}

// ── the Morgue: what was spiked, with a way back ────────────────────────────

export function renderMorguePage({
  list,
  aged,
  counts,
  flash,
  now,
  timeZone,
}: {
  list: Paged<SpikedSave>;
  aged?: { items: AgedSave[]; total: number } | null; // page 1 only
  counts: SectionCounts;
  flash: Flash;
  now: Date;
  timeZone: string;
}): string {
  const { items } = list;
  const tz = validZone(timeZone);
  return shell(
    "The Morgue · The tl;dr",
    `${masthead(now, tz, "morgue", counts)}
${renderFlash(flash, null)}
<main>
<section class="morgue" aria-labelledby="morgue-label">
  <header class="section-head">
    <h2 id="morgue-label">The Morgue</h2>
    <span class="kicker">${list.total} spiked</span>
  </header>
  <p class="note">What the editor cut, and why. Rescue anything that deserved better; it goes back on the reading list.</p>
  ${items.length ? `<ol class="spiked">\n${items.map((s) => renderSpiked(s, now)).join("\n")}\n</ol>` : `<p class="empty">Nothing spiked yet.</p>`}
  ${pager("/morgue", list)}
</section>
${aged && aged.total ? renderAgedSection(aged, now) : ""}
</main>`,
  );
}

function renderAgedSection(aged: { items: AgedSave[]; total: number }, now: Date): string {
  const rows = aged.items
    .map(
      (a) => `<li class="cut">
  <p class="kicker">Untouched ${MORGUE_DAYS} days · moved ${escapeHtml(a.morgue_at ? relativeTime(a.morgue_at, now) : "earlier")}</p>
  <h3>${sourceLink(a.action_text || a.headline || "Untitled", a.url)}</h3>
  <p class="byline">${escapeHtml(byline(a))}</p>
  <form class="stamps" method="post" action="/saves/${a.save_id}/restore">
    <button type="submit">Bring back</button>
  </form>
</li>`,
    )
    .join("\n");
  const more = aged.total - aged.items.length;
  return `<section class="morgue aged" aria-labelledby="aged-label">
  <header class="section-head">
    <h2 id="aged-label">Aged out</h2>
    <span class="kicker">${aged.total} untouched for ${MORGUE_DAYS} days</span>
  </header>
  <p class="note">Kept copy and actions nobody touched for ${MORGUE_DAYS} days move here, so the Desk stays short. Bring back anything you still want.</p>
  <ol class="spiked">\n${rows}\n</ol>
  ${more > 0 ? `<p class="jump kicker">${more} older not shown</p>` : ""}
</section>`;
}

// "‹ Newer · Page 2 of 3 · Older ›" under a long back page.
function pager(path: string, list: Paged<unknown>): string {
  if (list.pages <= 1) return "";
  const parts = [
    list.page > 1 ? `<a href="${path}?page=${list.page - 1}">‹ Newer</a>` : null,
    `Page ${list.page} of ${list.pages}`,
    list.page < list.pages ? `<a href="${path}?page=${list.page + 1}">Older ›</a>` : null,
  ].filter(Boolean);
  return `<p class="jump kicker">${parts.join(" · ")}</p>`;
}

function renderSpiked(s: SpikedSave, now: Date): string {
  return `<li class="cut">
  <p class="kicker"><span class="reason">${escapeHtml(s.spike_reason ?? "spiked")}</span> · saved ${escapeHtml(relativeTime(s.saved_at, now))}</p>
  <h3><s>${sourceLink(s.headline || "Untitled", s.url)}</s></h3>
  <p class="byline">${escapeHtml(byline(s))}</p>
  <form class="stamps" method="post" action="/saves/${s.save_id}/rescue">
    <button type="submit">Rescue</button>
  </form>
</li>`;
}

// ── filing copy by hand, plus the raw wire ──────────────────────────────────

export interface FilePageInput {
  saves: Save[]; // untriaged, newest first
  waiting: number;
  counts: SectionCounts;
  flash: Flash;
  now: Date;
  timeZone: string;
}

export function renderFilePage({ saves, waiting, counts, flash, now, timeZone }: FilePageInput): string {
  const tz = validZone(timeZone);
  return shell(
    "Add · The tl;dr",
    `${masthead(now, tz, "file", counts)}
<main>
<section class="file-copy" aria-labelledby="file-copy-label">
  <form method="post" action="/save">
    <label id="file-copy-label" class="kicker" for="paste">Add a link or a note</label>
    <textarea id="paste" name="text" rows="4" maxlength="10000" placeholder="Paste a link or a few lines" required></textarea>
    <button type="submit">File it</button>
  </form>
  ${renderFlash(flash, null)}
  <p class="note">On your phone, share straight to tl;dr from any app instead.</p>
</section>
<section class="wire" aria-labelledby="wire-label">
  <h2 id="wire-label" class="kicker">The wire · ${waiting} waiting for the editor</h2>
  ${saves.length === 0 ? `<p class="empty">No copy waiting. The editor reads everything each morning.</p>` : `<ol class="saves">\n${saves.map((s) => renderSave(s, now)).join("\n")}\n</ol>`}
</section>
</main>`,
  );
}

function renderSave(save: Save, now: Date): string {
  const host = save.url ? hostOf(save.url) : null;
  // With no title, the first line of the shared text stands in as headline.
  const headline = save.title || (save.text ? firstLine(save.text) : null) || host || "Untitled";
  const via = [save.author ? `By ${save.author}` : null, host ? `via ${host}` : null].filter(Boolean).join(", ");
  const body = save.title ? save.text : restAfterFirstLine(save.text);
  return `<li class="save">
  <p class="dateline">Saved ${escapeHtml(relativeTime(save.saved_at, now))} · ${escapeHtml(sourceLabel(save.source))}</p>
  <h3>${sourceLink(headline, save.url)}</h3>
  ${via ? `<p class="byline">${escapeHtml(via)}</p>` : ""}
  ${body ? `<p class="body">${escapeHtml(truncate(body, 280))}</p>` : ""}
</li>`;
}

// ── shared pieces ───────────────────────────────────────────────────────────

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F3EFE6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16140F" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=UnifrakturMaguntia&display=swap">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body>
${body}
</body>
</html>`;
}

type Section = "desk" | "reading" | "morgue" | "file";

function masthead(now: Date, tz: string, active: Section, counts: SectionCounts): string {
  return `<header class="masthead">
  <div class="masthead-row">
    <h1><a href="/">The tl;dr</a></h1>
    <time class="edition-line" datetime="${now.toISOString()}" title="Vol. I · ${escapeHtml(formatEditionDate(now, tz))}">${escapeHtml(shortDay(now.toISOString(), tz))}</time>
  </div>
</header>
${sectionNav(active, counts)}`;
}

// The section bar: every page, always in the same place, with counts.
function sectionNav(active: Section, counts: SectionCounts): string {
  const tab = (section: Section, href: string, label: string, count: number | null) =>
    `<a href="${href}"${section === active ? ` aria-current="page"` : ""}>${label}${count === null ? "" : ` <span class="count">${count}</span>`}</a>`;
  return `<nav class="sections" aria-label="Sections">
  ${tab("desk", "/", "Desk", counts.desk)}
  ${tab("reading", "/reading", "Reading", counts.reading)}
  ${tab("morgue", "/morgue", "Morgue", counts.morgue)}
  ${tab("file", "/file", "+ Add", null)}
</nav>`;
}

function renderFlash(flash: Flash, undo: number | null): string {
  const undoForm = (label: string) =>
    undo
      ? `<form class="flash-row" method="post" action="/actions/${undo}" role="status">
  <span class="stamp">${label}</span>
  <button class="link" name="do" value="open" type="submit">Undo</button>
</form>`
      : `<p class="flash" role="status"><span class="stamp">${label}</span></p>`;
  switch (flash) {
    case "done":
      return undoForm("Done");
    case "snoozed":
      return undoForm("Snoozed");
    case "dropped":
      return undoForm("Dropped");
    case "reopened":
      return `<p class="flash" role="status">Back on the Desk.</p>`;
    case "gone":
      return `<p class="flash" role="status">That item is no longer here.</p>`;
    case "restored":
      return `<p class="flash" role="status"><span class="stamp">Restored</span> It has another ${MORGUE_DAYS} days.</p>`;
    case "rescued":
      return `<p class="flash" role="status"><span class="stamp">Rescued</span> It's back on the reading list.</p>`;
    case "filed":
      return `<p class="flash" role="status"><span class="stamp">Filed</span> On the wire for the next morning run.</p>`;
    case "duplicate":
      return `<p class="flash" role="status">Already on the wire.</p>`;
    case "empty":
      return `<p class="flash" role="status">Nothing to file. Paste a link or some text.</p>`;
    case "x_connected":
      return `<p class="flash" role="status"><span class="stamp">X connected</span></p>`;
    case "x_failed":
      return `<p class="flash" role="status">X login didn't finish. Try again.</p>`;
    case "x_unset":
      return `<p class="flash" role="status">X isn't set up yet. See docs/setup.md.</p>`;
    case "x_synced":
      return `<p class="flash" role="status">X bookmarks synced.</p>`;
    case "x_sync_failed":
      return `<p class="flash" role="status">X sync failed. See the X line above.</p>`;
    default:
      return "";
  }
}

// A headline linked to the original, if it has a web link.
function sourceLink(label: string, url: string | null): string {
  if (!url || !/^https?:\/\//i.test(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(label)}</a>`;
}

function byline(s: { author: string | null; url: string | null; source: string; saved_at: string }): string {
  const via = s.source.startsWith("x_")
    ? "X"
    : s.source === "github_star"
      ? "GitHub"
      : s.source === "youtube"
        ? "YouTube"
        : s.url
          ? hostOf(s.url)
          : sourceLabel(s.source);
  return [s.author ? `By ${s.author}` : null, via ? `via ${via}` : null].filter(Boolean).join(", ");
}

function sourceLabel(source: string): string {
  switch (source) {
    case "share":
      return "Shared";
    case "paste":
      return "Pasted";
    case "x_bookmark":
      return "X bookmark";
    case "x_like":
      return "X like";
    case "github_star":
      return "GitHub star";
    case "youtube":
      return "YouTube";
    default:
      return source;
  }
}

function shortDay(iso: string | null, tz: string): string {
  if (!iso) return "soon";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(new Date(iso));
}

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function formatEditionDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: validZone(timeZone),
  })
    .format(now)
    .replace(",", "")
    .replace(/^(\w+)/, "$1,")
    .toUpperCase();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return truncate(text.split("\n")[0], 120);
}

function restAfterFirstLine(text: string | null): string | null {
  if (!text) return null;
  const [first, ...rest] = text.split("\n");
  const remainder = rest.join("\n").trim();
  // A first line too long to be a headline keeps its full text as the body.
  if (first.length > 120) return text;
  return remainder || null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
