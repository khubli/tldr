// The morning email: "your Desk this morning", set like a small front page.
// Plain functions that turn data into { subject, text, html }; src/loop.ts
// sends it. Email clients ignore web fonts and style sheets, so styles are
// inline and the type falls back to Georgia and Arial. Same paper, ink and
// one spot red as docs/design-brief.md.

import type { DeskAction } from "./desk";
import { escapeHtml, formatEditionDate } from "./page";
import type { Circulation } from "./loop";

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

export interface Highlight {
  headline: string | null;
  tldr: string | null;
  why_you: string | null;
  url: string | null;
}

export interface MorningInput {
  now: Date;
  timeZone: string;
  siteUrl: string; // "" when unknown: links to the Desk are left out
  lede: string;
  stats: { triaged: number; kept: number; spiked: number; spiked_by_reason: Record<string, number> };
  actions: DeskAction[]; // the top of the Desk
  actionsOpen: number;
  highlights: Highlight[];
  week: Circulation | null; // Sundays only
}

export interface MissedInput {
  now: Date;
  timeZone: string;
  siteUrl: string;
  waiting: number;
  actions: DeskAction[];
  actionsOpen: number;
}

const PAPER = "#F3EFE6";
const INK = "#141310";
const GREY = "#4A463F"; // secondary text, as on the site (passes 4.5:1)
const RULE = "#8A857A";
const RED = "#C2362B";
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const SANS = "'IBM Plex Sans', Arial, Helvetica, sans-serif";
const MONO = "'IBM Plex Mono', 'Courier New', monospace";

export function composeMorning(input: MorningInput): MailContent {
  const { stats, week } = input;
  const day = shortDay(input.now, input.timeZone);
  const edition = week ? "Sunday edition" : "Your Desk this morning";
  const subject = `${edition}, ${day}: ${plural(input.actionsOpen, "to do", "to do")}, ${stats.kept} kept, ${stats.spiked} spiked`;
  const reasons = spikeReasons(stats.spiked_by_reason);

  const text = [
    `THE TL;DR · ${formatEditionDate(input.now, input.timeZone)}`,
    "",
    input.lede,
    "",
    `ON THE DESK (${input.actionsOpen} open)`,
    ...textActions(input.actions, input.actionsOpen),
    ...(input.highlights.length ? ["", "WORTH READING", ...input.highlights.flatMap(textHighlight)] : []),
    "",
    `Spiked this run: ${stats.spiked}${reasons ? ` (${reasons})` : ""}.`,
    ...(week ? ["", ...textCirculation(week)] : []),
    ...(input.siteUrl ? ["", `Open the Desk: ${input.siteUrl}/`] : []),
  ].join("\n");

  const html = page(
    input,
    `${p(escapeHtml(input.lede), `font-family:${SERIF};font-size:18px;line-height:1.55;margin:0 0 20px`)}
${htmlActions(input.actions, input.actionsOpen, input.siteUrl)}
${input.highlights.length ? htmlHighlights(input.highlights) : ""}
${p(
  `Spiked this run: ${stats.spiked}${reasons ? ` · ${escapeHtml(reasons)}` : ""}${input.siteUrl ? ` · <a href="${attr(input.siteUrl)}/morgue" style="color:${GREY}">The Morgue</a>` : ""}`,
  `font-family:${SANS};font-size:14px;color:${GREY};border-top:1px solid ${RULE};padding-top:10px;margin:20px 0 0`,
)}
${week ? htmlCirculation(week) : ""}`,
  );
  return { subject, text, html };
}

export function composeMissed(input: MissedInput): MailContent {
  const day = shortDay(input.now, input.timeZone);
  const subject = `No morning run today, ${day}: ${input.waiting} saves waiting`;
  const note =
    `The editor hasn't run this morning, so ${plural(input.waiting, "save is", "saves are")} still waiting. ` +
    "Check the tldr morning run in Claude: it may have failed to load the tldr connector, or hit a usage limit. " +
    "Your Desk is below as it stands.";
  const text = [
    `THE TL;DR · ${formatEditionDate(input.now, input.timeZone)}`,
    "",
    note,
    "",
    `ON THE DESK (${input.actionsOpen} open)`,
    ...textActions(input.actions, input.actionsOpen),
    ...(input.siteUrl ? ["", `Open the Desk: ${input.siteUrl}/`] : []),
  ].join("\n");
  const html = page(
    input,
    `${p(`<span style="font-family:${MONO};color:${RED};border:1px solid ${RED};padding:1px 6px;text-transform:uppercase">No run</span>`, "margin:0 0 10px")}
${p(escapeHtml(note), `font-family:${SERIF};font-size:18px;line-height:1.55;margin:0 0 20px`)}
${htmlActions(input.actions, input.actionsOpen, input.siteUrl)}`,
  );
  return { subject, text, html };
}

// ── pieces ──────────────────────────────────────────────────────────────────

function page(input: { now: Date; timeZone: string; siteUrl: string }, body: string): string {
  const name = input.siteUrl
    ? `<a href="${attr(input.siteUrl)}/" style="color:${INK};text-decoration:none">The tl;dr</a>`
    : "The tl;dr";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK}">
<div style="max-width:600px;margin:0 auto;padding:20px 16px;background:${PAPER};color:${INK}">
<h1 style="font-family:'UnifrakturMaguntia',${SERIF};font-size:34px;font-weight:700;margin:0;line-height:1.1">${name}</h1>
<p style="font-family:${MONO};font-size:12px;text-transform:uppercase;color:${GREY};margin:6px 0 0;padding-bottom:8px;border-bottom:3px double ${INK}">${escapeHtml(formatEditionDate(input.now, input.timeZone))}</p>
<div style="padding-top:18px">
${body}
</div>
</div>
</body></html>`;
}

function htmlActions(actions: DeskAction[], open: number, siteUrl: string): string {
  const head = sectionHead("On the Desk", `${open} open`);
  if (!actions.length) return `${head}${p("Nothing on the Desk.", `font-family:${SERIF};font-size:16px;color:${GREY};margin:8px 0 0`)}`;
  const rows = actions
    .map((a, i) => {
      const kicker = a.action_project ? `${cap(a.action_type)} · ${a.action_project}` : cap(a.action_type);
      return `<li style="padding:10px 0;border-bottom:1px solid ${RULE};list-style:none">
<p style="font-family:${SANS};font-size:14px;margin:0;color:${i === 0 ? RED : GREY}">${escapeHtml(kicker)}</p>
<p style="font-family:${SERIF};font-size:18px;font-weight:600;line-height:1.3;margin:2px 0 0">${escapeHtml(a.action_text || a.headline || "Untitled")}</p>
${a.headline ? `<p style="font-family:${SANS};font-size:14px;color:${GREY};margin:4px 0 0">From ${link(a.headline, a.url)}</p>` : ""}
</li>`;
    })
    .join("\n");
  const more = open - actions.length;
  const jump = siteUrl
    ? `<p style="font-family:${SANS};font-size:14px;margin:10px 0 0"><a href="${attr(siteUrl)}/" style="color:${INK}">${more > 0 ? `${more} more, continued on the Desk` : "Done, Snooze or Drop on the Desk"} ›</a></p>`
    : "";
  return `${head}<ol style="margin:0;padding:0">\n${rows}\n</ol>${jump}`;
}

function htmlHighlights(items: Highlight[]): string {
  const rows = items
    .map(
      (h) => `<li style="padding:10px 0;border-bottom:1px solid ${RULE};list-style:none">
<p style="font-family:${SERIF};font-size:18px;font-weight:600;line-height:1.3;margin:0">${link(h.headline || "Untitled", h.url, INK)}</p>
${h.tldr ? `<p style="font-family:${SERIF};font-size:16px;line-height:1.5;margin:4px 0 0">${escapeHtml(h.tldr)}</p>` : ""}
${h.why_you ? `<p style="font-family:${SANS};font-size:14px;color:${GREY};margin:4px 0 0">Why you: ${escapeHtml(h.why_you)}</p>` : ""}
</li>`,
    )
    .join("\n");
  return `<div style="margin-top:20px">${sectionHead("Worth reading", "the editor's picks")}<ol style="margin:0;padding:0">\n${rows}\n</ol></div>`;
}

function htmlCirculation(w: Circulation): string {
  const cell = (label: string, value: string) =>
    `<td style="padding:6px 8px;text-align:center"><p style="font-family:${SERIF};font-size:24px;font-weight:700;margin:0">${value}</p><p style="font-family:${SANS};font-size:14px;color:${GREY};margin:0">${label}</p></td>`;
  return `<div style="margin-top:24px;border:1px solid ${INK};padding:10px 8px">
<p style="font-family:${SANS};font-size:14px;font-weight:600;margin:0 0 4px;text-align:center">Circulation, the last 7 days</p>
<table role="presentation" style="width:100%;border-collapse:collapse"><tr>
${cell("saved", String(w.saved))}${cell("kept", String(w.kept))}${cell("spiked", String(w.spiked))}${cell("acted", String(w.acted))}
</tr></table>
${w.slop === null ? "" : `<p style="font-family:${SERIF};font-size:16px;margin:6px 0 0;text-align:center">Slop ratio: <strong style="color:${RED}">${w.slop}%</strong> of what the editor read was spiked.</p>`}
</div>`;
}

function sectionHead(title: string, note: string): string {
  return `<p style="font-family:${SERIF};font-size:20px;font-weight:700;margin:0;padding-bottom:4px;border-bottom:1px solid ${INK}">${escapeHtml(title)} <span style="font-family:${SANS};font-size:14px;font-weight:400;color:${GREY}">· ${escapeHtml(note)}</span></p>`;
}

function textActions(actions: DeskAction[], open: number): string[] {
  if (!actions.length) return ["Nothing on the Desk."];
  const lines = actions.map((a) => {
    const kicker = a.action_project ? `${cap(a.action_type)} · ${a.action_project}` : cap(a.action_type);
    return `- [${kicker}] ${a.action_text || a.headline || "Untitled"}${a.url ? `\n  ${a.url}` : ""}`;
  });
  if (open > actions.length) lines.push(`  ...and ${open - actions.length} more on the Desk.`);
  return lines;
}

function textHighlight(h: Highlight): string[] {
  return [`- ${h.headline || "Untitled"}`, ...(h.tldr ? [`  ${h.tldr.replace(/\n/g, "\n  ")}`] : []), ...(h.url ? [`  ${h.url}`] : [])];
}

function textCirculation(w: Circulation): string[] {
  return [
    "CIRCULATION, THE LAST 7 DAYS",
    `Saved ${w.saved} · kept ${w.kept} · spiked ${w.spiked} · acted ${w.acted}`,
    ...(w.slop === null ? [] : [`Slop ratio: ${w.slop}% of what the editor read was spiked.`]),
  ];
}

function spikeReasons(byReason: Record<string, number>): string {
  return Object.entries(byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, n]) => `${r} ${n}`)
    .join(", ");
}

function link(label: string, url: string | null, color = GREY): string {
  if (!url || !/^https?:\/\//i.test(url)) return escapeHtml(label);
  return `<a href="${attr(url)}" style="color:${color}">${escapeHtml(label)}</a>`;
}

function p(inner: string, style: string): string {
  return `<p style="${style}">${inner}</p>`;
}

function attr(value: string): string {
  return escapeHtml(value);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(now);
}
