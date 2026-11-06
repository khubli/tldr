import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import { getFeedback } from "../src/brain";
import { snoozeUntil } from "../src/desk";
import worker from "../src/index";
import { authed, form, ORIGIN, stubCerts } from "./helpers";

// Fictional fixtures only: Contoso, Fabrikam, Woodgrove Bank.
const T0 = "2026-11-04T01:00:00.000Z";

interface Seed {
  id: number;
  verdict: "keep" | "spike";
  headline: string;
  rank: number;
  tldr?: string;
  why?: string;
  reason?: string;
  action?: { type: string; project?: string; text: string; state?: string; due?: string };
}

const SEEDS: Seed[] = [
  { id: 1, verdict: "keep", headline: "Fabrikam open-sources its eval harness", rank: 90, tldr: "A fixture runner for LLM triage tests.",
    action: { type: "try", project: "ledger", text: "Run Fabrikam's fixture runner against the triage tests" } },
  { id: 2, verdict: "keep", headline: "Contoso's cron notes", rank: 60, tldr: "Notes on scheduled Workers.",
    action: { type: "read", project: "tldr", text: "Read Contoso's cron notes before slice 5" } },
  { id: 3, verdict: "keep", headline: "Woodgrove Bank on dense mobile type", rank: 80, tldr: "Why a 17px serif body reads better on phones.", why: "Your Desk page is mobile-first." },
  { id: 4, verdict: "keep", headline: "A D1 migration pattern worth stealing", rank: 70, tldr: "Forty lines, no downtime." },
  { id: 5, verdict: "spike", headline: "10 AI tools that will replace you", rank: 0, reason: "hype" },
  { id: 6, verdict: "spike", headline: "Repost of the Contoso launch thread", rank: 0, reason: "repost" },
  { id: 7, verdict: "spike", headline: "Another hype thread", rank: 0, reason: "hype" },
];

async function seed(): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const s of SEEDS) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO saves (id, source, source_id, url, author, text, saved_at, status) VALUES (?, 'x_bookmark', ?, ?, '@contoso_dev', 'post text', ?, 'triaged')",
      ).bind(s.id, `post-${s.id}`, `https://x.com/contoso_dev/status/${1000 + s.id}`, T0),
      env.DB.prepare(
        `INSERT INTO triage (save_id, verdict, spike_reason, headline, tldr, why_you, action_type, action_project, action_text, rank, triaged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(s.id, s.verdict, s.reason ?? null, s.headline, s.tldr ?? null, s.why ?? null, s.action?.type ?? null,
        s.action?.project ?? null, s.action?.text ?? null, s.rank, T0),
    );
    if (s.action) {
      stmts.push(
        env.DB.prepare("INSERT INTO actions (id, save_id, state, due, updated_at) VALUES (?, ?, ?, ?, ?)").bind(
          s.id * 10, s.id, s.action.state ?? "open", s.action.due ?? null, T0,
        ),
      );
    }
  }
  // One not yet triaged.
  stmts.push(
    env.DB.prepare(
      "INSERT INTO saves (id, source, source_id, url, text, saved_at) VALUES (8, 'share', 'share-8', 'https://fabrikam.example/a', 'fresh', ?)",
    ).bind(T0),
  );
  await env.DB.batch(stmts);
}

const get = async (path: string) => (await worker.fetch(await authed(path), env)).text();
const post = async (path: string, fields: Record<string, string> = {}, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) => {
  const f = form(fields);
  return worker.fetch(await authed(path, { method: "POST", body: f.body, headers: { ...f.headers, ...headers } }), env);
};
const actionState = async (id: number) =>
  (await env.DB.prepare("SELECT state, due FROM actions WHERE id = ?").bind(id).first<{ state: string; due: string | null }>())!;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM actions"),
    env.DB.prepare("DELETE FROM triage"),
    env.DB.prepare("DELETE FROM saves"),
    env.DB.prepare("DELETE FROM x_account"),
  ]);
  await seed();
  resetAccessKeyCache();
  await stubCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("the Desk", () => {
  it("shows open actions, the ranked reading list and one spiked line", async () => {
    const html = await get("/");
    // Masthead, the section bar with counts, and the one status line.
    expect(html).toContain("The tl;dr");
    expect(html).toContain('<a href="/" aria-current="page">Desk <span class="count">2</span></a>');
    expect(html).toContain('<a href="/reading">Reading <span class="count">2</span></a>');
    expect(html).toContain('<a href="/morgue">Morgue <span class="count">3</span></a>');
    expect(html).toContain('href="/file">+ Add</a>');
    expect(html).toContain("1 waiting for the editor");
    // Open actions, best first, with stamps.
    expect(html).toContain("2 open");
    expect(html).toContain("Try · ledger");
    expect(html.indexOf("Run Fabrikam&#39;s fixture runner")).toBeLessThan(html.indexOf("Read Contoso&#39;s cron notes"));
    expect(html).toContain('action="/actions/10"');
    expect(html).toMatch(/name="do" value="done"[^>]*>Done</);
    expect(html).toMatch(/name="do" value="snooze"[^>]*>Snooze 3 days</);
    expect(html).toMatch(/name="do" value="drop"[^>]*>Drop</);
    // Worth reading: kept saves without an action, by rank, linked to the source.
    const worth = html.slice(html.indexOf("Worth reading"));
    expect(worth).toContain("2 kept · by value to you");
    expect(worth.indexOf("Woodgrove Bank on dense mobile type")).toBeLessThan(worth.indexOf("A D1 migration pattern"));
    expect(worth).toContain('href="https://x.com/contoso_dev/status/1003"');
    expect(worth).toContain("Your Desk page is mobile-first.");
    expect(worth).not.toContain("Fabrikam open-sources its eval harness"); // it's on the Desk
    // Spiked: a count, the top reasons, and the way to the Morgue.
    expect(html).toContain('href="/morgue">3 spiked · hype 2, repost 1 ›</a>');
    expect(html).not.toContain("10 AI tools");
  });

  it("Done sticks, and Undo brings it back", async () => {
    const res = await post("/actions/10", { do: "done" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/?flash=done&undo=10`);
    expect((await actionState(10)).state).toBe("done");

    const html = await get("/?flash=done&undo=10");
    expect(html).not.toContain("Run Fabrikam&#39;s fixture runner");
    expect(html).toContain("1 open · 1 done this week");
    expect(html).toMatch(/action="\/actions\/10"[\s\S]*value="open"[^>]*>Undo</);

    const undo = await post("/actions/10", { do: "open" });
    expect(undo.headers.get("Location")).toBe(`${ORIGIN}/?flash=reopened`);
    expect((await actionState(10)).state).toBe("open");
    expect(await get("/")).toContain("Run Fabrikam&#39;s fixture runner");
  });

  it("Drop sticks", async () => {
    await post("/actions/20", { do: "drop" });
    expect((await actionState(20)).state).toBe("dropped");
    expect(await get("/")).not.toContain("Read Contoso&#39;s cron notes");
  });

  it("Snooze hides an action until its time, then it comes back on its own", async () => {
    await post("/actions/20", { do: "snooze" });
    const { state, due } = await actionState(20);
    expect(state).toBe("snoozed");
    expect(new Date(due!).getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);

    let html = await get("/");
    expect(html).toContain("1 open");
    expect(html).toContain("1 snoozed");
    expect(html.slice(html.indexOf("snoozed</summary>"))).toContain("Read Contoso&#39;s cron notes");

    // Time's up: it is open again, with no job needed to wake it.
    await env.DB.prepare("UPDATE actions SET due = ? WHERE id = 20").bind(new Date(Date.now() - 1000).toISOString()).run();
    html = await get("/");
    expect(html).toContain("2 open");
    expect(html).not.toContain("snoozed</summary>");

    // The editor's count of open actions agrees.
    expect((await getFeedback(env.DB, 14, new Date())).actions_open).toBe(2);
  });

  it("refuses taps from other sites, unknown taps and missing actions", async () => {
    expect((await post("/actions/10", { do: "done" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post("/actions/10", { do: "done" }, { Origin: "https://fabrikam.example" })).status).toBe(403);
    expect((await post("/actions/10", { do: "delete" })).status).toBe(400);
    expect((await actionState(10)).state).toBe("open");
    const missing = await post("/actions/999", { do: "done" });
    expect(missing.headers.get("Location")).toBe(`${ORIGIN}/?flash=gone`);
  });

  it("escapes whatever the editor wrote", async () => {
    await env.DB.prepare("UPDATE triage SET action_text = ?, tldr = ? WHERE save_id = 1")
      .bind('<script>alert("x")</script>', "<img src=x onerror=alert(1)>")
      .run();
    await env.DB.prepare("DELETE FROM actions WHERE id = 20").run();
    const html = await get("/");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("only links to web pages", async () => {
    await env.DB.prepare("UPDATE saves SET url = 'javascript:alert(1)' WHERE id = 3").run();
    expect(await get("/")).not.toContain("javascript:");
  });

  it("shows a calm empty Desk", async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM actions"), env.DB.prepare("DELETE FROM triage")]);
    const html = await get("/");
    expect(html).toContain("Nothing on the Desk");
    expect(html).toContain("Nothing spiked yet");
  });
});

describe("the Morgue and the pile", () => {
  it("lists what was spiked, and Rescue puts it on the reading list", async () => {
    const morgue = await get("/morgue");
    expect(morgue).toContain("3 spiked");
    expect(morgue).toMatch(/<s><a [^>]*>10 AI tools that will replace you<\/a><\/s>/);
    expect(morgue).toContain('action="/saves/5/rescue"');

    const res = await post("/saves/5/rescue");
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/morgue?flash=rescued`);
    const row = await env.DB.prepare("SELECT verdict, spike_reason, rank FROM triage WHERE save_id = 5").first();
    expect(row).toEqual({ verdict: "keep", spike_reason: null, rank: 50 });

    const desk = await get("/");
    expect(desk).toContain("2 spiked");
    expect(desk.slice(desk.indexOf("Worth reading"))).toContain("10 AI tools that will replace you");

    // Rescuing twice, or a keep, does nothing.
    expect((await post("/saves/5/rescue")).headers.get("Location")).toBe(`${ORIGIN}/morgue?flash=gone`);
    expect((await post("/saves/5/rescue", {}, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });

  it("a rescued save with an old action still reaches the reading list", async () => {
    // Kept with an action, acted on, then re-triaged as a spike.
    await env.DB.batch([
      env.DB.prepare("UPDATE actions SET state = 'done' WHERE id = 20"),
      env.DB.prepare("UPDATE triage SET verdict = 'spike', spike_reason = 'stale', action_type = NULL, action_project = NULL, action_text = NULL WHERE save_id = 2"),
    ]);
    await post("/saves/2/rescue");
    const desk = await get("/");
    expect(desk.slice(desk.indexOf("Worth reading"))).toContain("Contoso&#39;s cron notes");
    // Actions of other saves are untouched.
    expect((await actionState(10)).state).toBe("open");
  });

  it("long back pages page through, with true totals", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 200; i < 305; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO saves (id, source, source_id, saved_at, status) VALUES (?, 'paste', ?, ?, 'triaged')").bind(i, `s-${i}`, T0),
        env.DB.prepare("INSERT INTO triage (save_id, verdict, spike_reason, headline, rank, triaged_at) VALUES (?, 'spike', 'bait', ?, 0, ?)")
          .bind(i, `Fabrikam bait ${i}`, new Date(Date.UTC(2026, 10, 5, 0, i)).toISOString()),
      );
    }
    await env.DB.batch(stmts);
    const first = await get("/morgue");
    expect(first).toContain("108 spiked");
    expect(first).toContain('href="/morgue?page=2">Older ›</a>');
    const second = await get("/morgue?page=2");
    expect(second).toContain("Page 2 of 2");
    expect(second).toContain('href="/morgue?page=1">‹ Newer</a>');
    expect(second).toContain("10 AI tools that will replace you"); // the oldest verdicts are still reachable
  });

  it("the pile lists every kept save past the first ten", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 100; i < 112; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO saves (id, source, source_id, saved_at, status) VALUES (?, 'paste', ?, ?, 'triaged')").bind(i, `p-${i}`, T0),
        env.DB.prepare("INSERT INTO triage (save_id, verdict, headline, tldr, rank, triaged_at) VALUES (?, 'keep', ?, 't', 10, ?)").bind(i, `Woodgrove note ${i}`, T0),
      );
    }
    await env.DB.batch(stmts);
    const desk = await get("/");
    expect(desk).toContain('href="/reading">4 more in the pile ›</a>');
    const pile = await get("/reading");
    expect(pile).toContain("14 kept");
    // The back pages carry the same section bar, with their own tab marked.
    expect(pile).toContain('<a href="/reading" aria-current="page">Reading <span class="count">14</span></a>');
    expect(pile).toContain("Woodgrove note 111");
  });
});

describe("privacy", () => {
  it("every Desk page and tap fails closed without an Access login", async () => {
    for (const path of ["/", "/reading", "/morgue", "/file"]) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }
    const f = form({ do: "done" });
    const tap = await worker.fetch(new Request(`${ORIGIN}/actions/10`, { method: "POST", body: f.body, headers: f.headers }), env);
    expect(tap.status).toBe(403);
    expect((await actionState(10)).state).toBe("open");
  });
});

describe("snoozeUntil", () => {
  it("is three days on, at 6am local time", () => {
    const now = new Date("2026-11-05T14:00:00Z"); // Thursday evening in Pune
    expect(snoozeUntil(now, "Asia/Kolkata").toISOString()).toBe("2026-11-08T00:30:00.000Z"); // Sunday 6:00 IST
    expect(snoozeUntil(now, "UTC").toISOString()).toBe("2026-11-08T06:00:00.000Z");
    expect(snoozeUntil(now, "Not/AZone").toISOString()).toBe("2026-11-08T06:00:00.000Z");
  });
});
