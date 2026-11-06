import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import { getFeedback } from "../src/brain";
import worker from "../src/index";
import { ageOut, checkMissedRun, isSunday, sendMorningMail, weekCirculation, type MailEnv } from "../src/loop";
import { composeMorning } from "../src/mail";
import { authed, form, ORIGIN, stubCerts } from "./helpers";

// Fictional fixtures only: Contoso, Fabrikam, Woodgrove Bank.
const TOKEN = "test-mcp-token-0123456789abcdef0123456789abcdef";
const TZ = "Asia/Kolkata";
const DAY = 86_400_000;

// Fri 6 Nov 2026, 06:45 IST and 09:00 IST; Sun 8 Nov 2026, 06:45 IST.
const FRI_MORNING = new Date("2026-11-06T01:15:00.000Z");
const FRI_LATE = new Date("2026-11-06T03:30:00.000Z");
const SUNDAY = new Date("2026-11-08T01:15:00.000Z");

interface Sent {
  from: { name: string; email: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}

function mailEnv(fail = false): MailEnv & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    ...env,
    EDITION_TZ: TZ,
    MAIL_FROM: "tldr@contoso.example",
    SITE_URL: "https://tldr.contoso.example",
    sent,
    MAILER: {
      send: vi.fn(async (msg: Sent) => {
        if (fail) throw new Error("destination address not verified");
        sent.push(msg);
        return { messageId: "m1" };
      }),
    } as unknown as SendEmail,
  };
}

async function addSave(id: number, opts: { verdict?: "keep" | "spike"; triaged?: Date; action?: { state: string; updated: Date; due?: string }; headline?: string } = {}) {
  const triaged = (opts.triaged ?? FRI_MORNING).toISOString();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO saves (id, source, source_id, url, author, text, saved_at, status) VALUES (?, 'x_bookmark', ?, ?, '@fabrikam', 'text', ?, 'triaged')",
    ).bind(id, `p${id}`, `https://x.com/fabrikam/status/${id}`, triaged),
    env.DB.prepare(
      `INSERT INTO triage (save_id, verdict, spike_reason, headline, tldr, action_type, action_text, rank, triaged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 70, ?)`,
    ).bind(
      id,
      opts.verdict ?? "keep",
      opts.verdict === "spike" ? "hype" : null,
      opts.headline ?? `Fabrikam note ${id}`,
      opts.verdict === "spike" ? null : `Short point ${id}.`,
      // A spike keeps no action text, even if an old action row survives.
      opts.action && opts.verdict !== "spike" ? "try" : null,
      opts.action && opts.verdict !== "spike" ? `Try Fabrikam idea ${id}` : null,
      triaged,
    ),
  ];
  if (opts.action) {
    stmts.push(
      env.DB.prepare("INSERT INTO actions (id, save_id, state, due, updated_at) VALUES (?, ?, ?, ?, ?)").bind(
        id * 10, id, opts.action.state, opts.action.due ?? null, opts.action.updated.toISOString(),
      ),
    );
  }
  await env.DB.batch(stmts);
}

async function publishRun(date: string, lede: string, highlights: number[] = []) {
  await env.DB.prepare("INSERT INTO runs (date, lede, highlight_ids, stats, published_at) VALUES (?, ?, ?, ?, ?)")
    .bind(date, lede, JSON.stringify(highlights), JSON.stringify({ triaged: 5, kept: 2, spiked: 3, spiked_by_reason: { hype: 2, bait: 1 } }), FRI_MORNING.toISOString())
    .run();
}

async function callTool(e: object, name: string, args: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request(`https://tldr.example/mcp/${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    e as typeof env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return JSON.parse(body.result.content[0].text);
}

const get = async (path: string, e: object = env) => (await worker.fetch(await authed(path), e as typeof env)).text();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM actions"),
    env.DB.prepare("DELETE FROM triage"),
    env.DB.prepare("DELETE FROM saves"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM mail_log"),
  ]);
  resetAccessKeyCache();
  await stubCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("the morning email", () => {
  it("goes out once when the run publishes", async () => {
    await addSave(1, { action: { state: "open", updated: FRI_MORNING } });
    await addSave(2);
    const e = mailEnv();
    const first = await callTool(e, "publish_morning_run", { lede: "Fabrikam's idea leads the Desk.", highlight_ids: [2] });
    expect(first.email).toBe("sent");
    expect(e.sent).toHaveLength(1);
    const mail = e.sent[0];
    expect(mail.to).toBe("reader@contoso.example"); // ALLOWED_EMAIL
    expect(mail.from.email).toBe("tldr@contoso.example");
    expect(mail.subject).toMatch(/: 1 to do, 2 kept, 0 spiked$/);
    expect(mail.text).toContain("Fabrikam's idea leads the Desk.");
    expect(mail.text).toContain("[Try] Try Fabrikam idea 1");
    expect(mail.text).toContain("Fabrikam note 2");
    expect(mail.html).toContain("Fabrikam&#39;s idea leads the Desk.");
    expect(mail.html).toContain('href="https://tldr.contoso.example/"');

    // Re-publishing the same morning replaces the run but sends nothing new.
    const again = await callTool(e, "publish_morning_run", { lede: "Second pass." });
    expect(again.email).toBe("already sent");
    expect(e.sent).toHaveLength(1);
  });

  it("is off until the mailer and sender are set", async () => {
    const res = await callTool({ ...env }, "publish_morning_run", { lede: "No mail set up." });
    expect(res.email).toBe("off");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_log").first("n")).toBe(0);
  });

  it("a failed send never fails the run, and shows on the Desk", async () => {
    const e = mailEnv(true);
    const res = await callTool(e, "publish_morning_run", { lede: "Mail will fail." });
    expect(res.date).toBeTruthy();
    expect(res.email).toBe("failed: destination address not verified");
    const html = await get("/", e);
    expect(html).toContain("Morning email didn't send: destination address not verified");
  });

  it("escapes what the editor wrote", () => {
    const out = composeMorning({
      now: FRI_MORNING,
      timeZone: TZ,
      siteUrl: "",
      lede: "<script>alert(1)</script> Contoso",
      stats: { triaged: 1, kept: 1, spiked: 0, spiked_by_reason: {} },
      actions: [],
      actionsOpen: 0,
      highlights: [{ headline: "<b>x</b>", tldr: null, why_you: null, url: "javascript:alert(1)" }],
      week: null,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out.subject).toBe("Your Desk this morning, Fri 6 Nov: 0 to do, 1 kept, 0 spiked");
  });

  it("carries the circulation box on Sundays", async () => {
    await addSave(1, { triaged: new Date(SUNDAY.getTime() - DAY) });
    await addSave(2, { verdict: "spike", triaged: new Date(SUNDAY.getTime() - DAY) });
    await addSave(3, { verdict: "spike", triaged: new Date(SUNDAY.getTime() - 2 * DAY) });
    await addSave(4, { verdict: "spike", triaged: new Date(SUNDAY.getTime() - 20 * DAY) }); // outside the week
    await addSave(5, { action: { state: "done", updated: new Date(SUNDAY.getTime() - DAY) }, triaged: new Date(SUNDAY.getTime() - DAY) });
    expect(isSunday(SUNDAY, TZ)).toBe(true);
    expect(isSunday(FRI_MORNING, TZ)).toBe(false);
    expect(await weekCirculation(env.DB, SUNDAY)).toEqual({ saved: 4, kept: 2, spiked: 2, acted: 1, slop: 50 });

    await publishRun("2026-11-08", "Sunday lede.");
    const e = mailEnv();
    expect(await sendMorningMail(e, SUNDAY)).toBe("sent");
    expect(e.sent[0].subject).toMatch(/^Sunday edition, Sun 8 Nov/);
    expect(e.sent[0].text).toContain("Saved 4 · kept 2 · spiked 2 · acted 1");
    expect(e.sent[0].html).toContain("Slop ratio");
  });
});

describe("the missed-run warning", () => {
  it("waits until 8am, then warns once if the editor hasn't run", async () => {
    await addSave(1, { action: { state: "open", updated: FRI_MORNING } });
    const e = mailEnv();
    expect(await checkMissedRun(e, FRI_MORNING)).toBe("not yet");
    expect(await checkMissedRun(e, FRI_LATE)).toBe("sent");
    expect(e.sent[0].subject).toBe("No morning run today, Fri 6 Nov: 0 saves waiting");
    expect(e.sent[0].text).toContain("Try Fabrikam idea 1");
    expect(await checkMissedRun(e, new Date(FRI_LATE.getTime() + 3 * 3600_000))).toBe("already sent");
    expect(e.sent).toHaveLength(1);
  });

  it("stays quiet when the run happened", async () => {
    await publishRun("2026-11-06", "Ran fine.");
    const e = mailEnv();
    expect(await checkMissedRun(e, FRI_LATE)).toBe("ran");
    expect(e.sent).toHaveLength(0);
  });
});

describe("the 30-day Morgue", () => {
  const now = FRI_MORNING;
  const old = new Date(now.getTime() - 31 * DAY);
  const recent = new Date(now.getTime() - 10 * DAY);

  beforeEach(async () => {
    await addSave(1, { triaged: old, headline: "Old Contoso keep" }); // ages out
    await addSave(2, { triaged: recent, headline: "Recent Woodgrove keep" }); // stays
    await addSave(3, { triaged: old, action: { state: "open", updated: old } }); // ages out
    await addSave(4, { triaged: old, action: { state: "done", updated: old } }); // finished: stays
    await addSave(5, { triaged: old, action: { state: "open", updated: recent } }); // touched lately: stays
    await addSave(6, { triaged: old, verdict: "spike" }); // spiked copy already lives in the Morgue
    // Re-triaged as a spike after it got an action: stays spiked, with Rescue.
    await addSave(7, { triaged: old, verdict: "spike", action: { state: "snoozed", updated: old, due: old.toISOString() } });
  });

  it("moves untouched copy off the Desk and the reading list", async () => {
    expect(await ageOut(env.DB, now)).toBe(2);
    const statuses = (await env.DB.prepare("SELECT id, status FROM saves ORDER BY id").all<{ id: number; status: string }>()).results;
    expect(statuses.filter((s) => s.status === "morgue").map((s) => s.id)).toEqual([1, 3]);
    expect(await ageOut(env.DB, now)).toBe(0); // idempotent

    const desk = await get("/");
    expect(desk).not.toContain("Try Fabrikam idea 3");
    expect(desk).toContain("Try Fabrikam idea 5");
    expect(desk).not.toContain("Old Contoso keep");
    expect(desk).toContain('<a href="/morgue">Morgue <span class="count">4</span></a>'); // 2 spiked + 2 aged

    // The editor doesn't count aged-out actions as open.
    expect((await getFeedback(env.DB, 14, now)).actions_open).toBe(1);

    const morgue = await get("/morgue");
    expect(morgue).toContain("Aged out");
    expect(morgue).toContain("Old Contoso keep");
    expect(morgue).toContain('action="/saves/3/restore"');
    expect(morgue).toContain('action="/saves/7/rescue"'); // still spiked, not aged
  });

  it("Bring back restores a save for another 30 days", async () => {
    await ageOut(env.DB, now);
    const f = form({});
    const blocked = await worker.fetch(
      await authed("/saves/3/restore", { method: "POST", body: f.body, headers: { ...f.headers, "Sec-Fetch-Site": "cross-site" } }),
      env,
    );
    expect(blocked.status).toBe(403);

    const res = await worker.fetch(
      await authed("/saves/3/restore", { method: "POST", body: f.body, headers: { ...f.headers, "Sec-Fetch-Site": "same-origin" } }),
      env,
    );
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/morgue?flash=restored`);
    const row = await env.DB.prepare("SELECT s.status, a.updated_at FROM saves s JOIN actions a ON a.save_id = s.id WHERE s.id = 3").first<{ status: string; updated_at: string }>();
    expect(row!.status).toBe("triaged");
    expect(new Date(row!.updated_at).getTime()).toBeGreaterThan(now.getTime());
    expect(await get("/")).toContain("Try Fabrikam idea 3");

    const gone = await worker.fetch(
      await authed("/saves/2/restore", { method: "POST", body: f.body, headers: { ...f.headers, "Sec-Fetch-Site": "same-origin" } }),
      env,
    );
    expect(gone.headers.get("Location")).toBe(`${ORIGIN}/morgue?flash=gone`);
  });
});
