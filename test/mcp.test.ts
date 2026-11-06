import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

// Fictional fixtures only: Contoso, Fabrikam, Woodgrove Bank.
const TOKEN = "test-mcp-token-0123456789abcdef0123456789abcdef";
const BASE = "https://tldr.example";

let nextId = 1;

async function rpc(method: string, params: unknown = {}, init: { path?: string; headers?: Record<string, string> } = {}) {
  const res = await worker.fetch(
    new Request(`${BASE}${init.path ?? `/mcp/${TOKEN}`}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...init.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env,
  );
  return res;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0].text;
  return { isError: body.result.isError === true, text, data: body.result.isError ? null : JSON.parse(text) };
}

async function seedSaves(n: number): Promise<void> {
  const companies = ["Contoso", "Fabrikam", "Woodgrove Bank"];
  const stmts = [];
  for (let i = 1; i <= n; i++) {
    const company = companies[i % 3];
    stmts.push(
      env.DB.prepare(
        "INSERT INTO saves (source, source_id, url, author, text, saved_at) VALUES ('x_bookmark', ?, ?, ?, ?, ?)",
      ).bind(
        `post-${i}`,
        `https://x.com/${company.toLowerCase().replace(/ /g, "")}/status/${1000 + i}`,
        `@${company.toLowerCase().replace(/ /g, "_")}`,
        `${company} note ${i}: ${i % 4 === 0 ? "10 AI tools that will replace you" : "how we cut queue latency with SQLite"}`,
        new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      ),
    );
  }
  await env.DB.batch(stmts);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM actions"),
    env.DB.prepare("DELETE FROM triage"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM profile"),
    env.DB.prepare("DELETE FROM saves"),
  ]);
});

describe("/mcp auth", () => {
  it("refuses a missing or wrong token with an empty 404", async () => {
    for (const path of ["/mcp", "/mcp/", "/mcp/wrong-token", `/mcp/${TOKEN}x`, `/mcp/${TOKEN}/extra`]) {
      const res = await rpc("tools/list", {}, { path });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("");
    }
    const bad = await rpc("tools/list", {}, { path: "/mcp", headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(404);
  });

  it("accepts the token in the path or as a bearer header", async () => {
    expect((await rpc("tools/list")).status).toBe(200);
    expect((await rpc("tools/list", {}, { path: "/mcp", headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("stays closed when MCP_TOKEN is unset or too short", async () => {
    for (const MCP_TOKEN of [undefined, "short"]) {
      const res = await worker.fetch(
        new Request(`${BASE}/mcp/${MCP_TOKEN ?? ""}`, { method: "POST", body: "{}" }),
        { ...env, MCP_TOKEN },
      );
      expect(res.status).toBe(404);
    }
  });

  it("refuses browsers on other sites", async () => {
    const res = await rpc("tools/list", {}, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("still keeps the rest of the site behind Access", async () => {
    const res = await worker.fetch(new Request(`${BASE}/`), env);
    expect(res.status).toBe(403);
  });
});

describe("/mcp protocol", () => {
  it("initializes and lists the six tools", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
    expect(init).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "tldr" }, capabilities: { tools: {} } } });

    const list = (await (await rpc("tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      "get_profile",
      "list_untriaged",
      "save_triage",
      "publish_morning_run",
      "get_feedback",
      "search_saves",
    ]);
  });

  it("answers notifications with 202 and only allows POST", async () => {
    const note = await worker.fetch(
      new Request(`${BASE}/mcp/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      env,
    );
    expect(note.status).toBe(202);
    const get = await worker.fetch(new Request(`${BASE}/mcp/${TOKEN}`), env);
    expect(get.status).toBe(405);
  });

  it("reports unknown methods and tools as errors", async () => {
    expect(await (await rpc("resources/list")).json()).toMatchObject({ error: { code: -32601 } });
    expect(await (await rpc("tools/call", { name: "drop_tables" })).json()).toMatchObject({ error: { code: -32602 } });
  });
});

describe("the morning run, end to end", () => {
  it("triages 20 saves and publishes", async () => {
    await env.DB.prepare("INSERT INTO profile (markdown, updated_at) VALUES (?, ?)")
      .bind("# Test reader\nBuilds Contoso Ledger on Workers and D1.", "2026-11-01T00:00:00Z")
      .run();
    await seedSaves(23);

    const profile = await call("get_profile");
    expect(profile.data.markdown).toContain("Contoso Ledger");

    const batch = await call("list_untriaged", { limit: 20 });
    expect(batch.data.items).toHaveLength(20);
    expect(batch.data.remaining).toBe(3);
    expect(batch.data.items[0].text).toContain("note 1:"); // oldest first

    const items = batch.data.items.map((s: { id: number; text: string }, i: number) =>
      s.text.includes("AI tools")
        ? { id: s.id, verdict: "spike", spike_reason: "hype", headline: "Listicle of AI tools" }
        : {
            id: s.id,
            verdict: "keep",
            headline: "Queue latency cut with SQLite",
            tldr: "A write-ahead queue in SQLite halved p99.",
            why_you: "Same pattern fits the Contoso Ledger sync.",
            rank: 50 + i,
            tags: ["sqlite", "Queues", "sqlite"],
            action: i % 2 ? { type: "try", project: "Ledger", text: "Try the WAL queue in the sync job." } : null,
          },
    );
    const saved = await call("save_triage", { items });
    expect(saved.data.errors).toEqual([]);
    expect(saved.data.saved).toBe(20);
    const spikes = items.filter((x: { verdict: string }) => x.verdict === "spike").length;
    expect(spikes).toBe(5);
    expect(saved.data.actions_opened).toBe(items.filter((x: { action?: unknown }) => x.action).length);

    const left = await call("list_untriaged", { limit: 20 });
    expect(left.data.items).toHaveLength(3);

    const keepId = items.find((x: { verdict: string }) => x.verdict === "keep").id;
    const run = await call("publish_morning_run", { lede: "A quiet morning: Contoso's queue trick leads.", highlight_ids: [keepId] });
    expect(run.data.stats).toMatchObject({ triaged: 20, kept: 15, spiked: 5, spiked_by_reason: { hype: 5 }, untriaged_left: 3 });
    expect(run.data.stats.actions_open).toBe(saved.data.actions_opened);

    const row = await env.DB.prepare("SELECT lede, highlight_ids FROM runs").first<{ lede: string; highlight_ids: string }>();
    expect(row?.lede).toContain("queue trick");
    expect(JSON.parse(row!.highlight_ids)).toEqual([keepId]);

    const tags = await env.DB.prepare("SELECT tags, action_project FROM triage WHERE save_id = ?").bind(items[1].id).first<{ tags: string; action_project: string }>();
    expect(JSON.parse(tags!.tags)).toEqual(["sqlite", "queues"]);
    expect(tags!.action_project).toBe("ledger");
  });
});

describe("save_triage checks", () => {
  beforeEach(() => seedSaves(3));

  it("saves the good items and reports the bad ones", async () => {
    const ids = (await env.DB.prepare("SELECT id FROM saves ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    const res = await call("save_triage", {
      items: [
        { id: ids[0], verdict: "keep", headline: "Fine", tldr: "Fine.", rank: 70 },
        { id: ids[1], verdict: "spike", headline: "No reason" },
        { id: ids[2], verdict: "keep", headline: "Bad rank", tldr: "x", rank: 400 },
        { id: 999999, verdict: "spike", spike_reason: "bait", headline: "Ghost" },
        { id: ids[2], verdict: "maybe", headline: "Bad verdict" },
      ],
    });
    expect(res.data.saved).toBe(1);
    expect(res.data.errors.map((e: { error: string }) => e.error)).toEqual([
      "spike_reason must be one of: hype, bait, repost, stale, basic, offtopic.",
      "rank must be between 0 and 100.",
      "verdict must be one of: keep, spike.",
      "No save with this id.",
    ]);
    const status = await env.DB.prepare("SELECT status FROM saves WHERE id = ?").bind(ids[1]).first<{ status: string }>();
    expect(status?.status).toBe("new");
  });

  it("re-triage replaces the verdict, keeps acted-on actions, clears open ones", async () => {
    const [a, b] = (await env.DB.prepare("SELECT id FROM saves ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    const keep = (id: number) => ({ id, verdict: "keep", headline: "H", tldr: "T", rank: 60, action: { type: "read", text: "Read it." } });
    await call("save_triage", { items: [keep(a), keep(b)] });
    await env.DB.prepare("UPDATE actions SET state = 'done' WHERE save_id = ?").bind(a).run();

    const again = await call("save_triage", {
      items: [keep(a), { id: b, verdict: "spike", spike_reason: "stale", headline: "Old news" }],
    });
    expect(again.data.actions_opened).toBe(0);
    const actions = (await env.DB.prepare("SELECT save_id, state FROM actions").all()).results;
    expect(actions).toEqual([{ save_id: a, state: "done" }]);
    const verdict = await env.DB.prepare("SELECT verdict FROM triage WHERE save_id = ?").bind(b).first<{ verdict: string }>();
    expect(verdict?.verdict).toBe("spike");
  });

  it("gives a keep with no rank the middle rank", async () => {
    const id = (await env.DB.prepare("SELECT id FROM saves ORDER BY id").first<{ id: number }>())!.id;
    const res = await call("save_triage", { items: [{ id, verdict: "keep", headline: "H", tldr: "T" }] });
    expect(res.data.saved).toBe(1);
    const row = await env.DB.prepare("SELECT rank FROM triage WHERE save_id = ?").bind(id).first<{ rank: number }>();
    expect(row?.rank).toBe(50);
  });

  it("refuses empty and oversized batches", async () => {
    expect((await call("save_triage", { items: [] })).isError).toBe(true);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, verdict: "spike", spike_reason: "bait", headline: "x" }));
    expect((await call("save_triage", { items: many })).text).toBe("At most 50 items per call.");
  });
});

describe("publish_morning_run", () => {
  it("counts only what was triaged since the last run, and replaces the same day's run", async () => {
    await seedSaves(4);
    const ids = (await env.DB.prepare("SELECT id FROM saves ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    await env.DB.prepare(
      "INSERT INTO runs (date, lede, stats, published_at) VALUES ('2000-01-01', 'old', '{}', '2026-11-04T01:00:00.000Z')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO triage (save_id, verdict, spike_reason, headline, rank, triaged_at) VALUES (?, 'spike', 'bait', 'old', 0, '2026-11-04T00:00:00.000Z')",
    ).bind(ids[0]).run();
    await call("save_triage", { items: [{ id: ids[1], verdict: "keep", headline: "New", tldr: "New.", rank: 80 }] });

    const first = await call("publish_morning_run", { lede: "One." });
    expect(first.data.stats).toMatchObject({ since: "2026-11-04T01:00:00.000Z", triaged: 1, kept: 1, spiked: 0 });
    await call("publish_morning_run", { lede: "Two." });
    const rows = (await env.DB.prepare("SELECT lede FROM runs WHERE date > '2000-01-01'").all()).results;
    expect(rows).toEqual([{ lede: "Two." }]);
  });

  it("only highlights kept saves", async () => {
    await seedSaves(1);
    const id = (await env.DB.prepare("SELECT id FROM saves").first<{ id: number }>())!.id;
    await call("save_triage", { items: [{ id, verdict: "spike", spike_reason: "repost", headline: "Again" }] });
    const res = await call("publish_morning_run", { lede: "x", highlight_ids: [id] });
    expect(res.isError).toBe(true);
    expect((await call("publish_morning_run", {})).text).toBe("lede is required.");
  });
});

describe("get_feedback and search_saves", () => {
  it("returns recent done/snoozed/dropped actions with counts", async () => {
    await seedSaves(3);
    const ids = (await env.DB.prepare("SELECT id FROM saves ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    await call("save_triage", {
      items: ids.map((id, i) => ({
        id, verdict: "keep", headline: `H${i}`, tldr: "T", rank: 50, action: { type: i ? "try" : "read", text: "Do it." },
      })),
    });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE actions SET state = 'done', updated_at = ? WHERE save_id = ?").bind(now, ids[0]),
      env.DB.prepare("UPDATE actions SET state = 'dropped', updated_at = ? WHERE save_id = ?").bind(now, ids[1]),
      env.DB.prepare("UPDATE actions SET state = 'dropped', updated_at = '2020-01-01T00:00:00Z' WHERE save_id = ?").bind(ids[2]),
    ]);
    const fb = await call("get_feedback", { days: 7 });
    expect(fb.data.counts).toEqual({ done: 1, snoozed: 0, dropped: 1 });
    expect(fb.data.by_type).toEqual({ read: { done: 1, snoozed: 0, dropped: 0 }, try: { done: 0, snoozed: 0, dropped: 1 } });
    expect(fb.data.actions_open).toBe(0);
  });

  it("finds saves by every word, and treats % and _ literally", async () => {
    await seedSaves(6);
    const hits = await call("search_saves", { query: "woodgrove SQLITE" });
    expect(hits.data.items.length).toBeGreaterThan(0);
    for (const h of hits.data.items) expect(h.text).toMatch(/Woodgrove Bank.*SQLite/);
    expect((await call("search_saves", { query: "%" })).data.items).toEqual([]);
    expect((await call("search_saves", { query: "" })).isError).toBe(true);
  });
});
