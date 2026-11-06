import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callModel, editorProvider, parseObject, runEditor, type ModelCall, type Provider } from "../src/editor";

// Fictional fixtures only: Contoso, Fabrikam, Woodgrove Bank. No real AI call
// is ever made: the model is a recorded answer passed in by each test.

const NOW = new Date("2026-11-06T02:00:00Z"); // 07:30 in Asia/Kolkata
const KEY = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key", EDITION_TZ: "Asia/Kolkata" };

async function seed(n: number): Promise<void> {
  const companies = ["Contoso", "Fabrikam", "Woodgrove Bank"];
  const stmts = [];
  for (let i = 1; i <= n; i++) {
    const c = companies[i % 3];
    stmts.push(
      env.DB.prepare(
        "INSERT INTO saves (id, source, source_id, url, author, text, saved_at) VALUES (?, 'x_bookmark', ?, ?, ?, ?, ?)",
      ).bind(
        i,
        `post-${i}`,
        `https://x.com/${c.toLowerCase().replace(/ /g, "")}/status/${1000 + i}`,
        `@${c.toLowerCase().replace(/ /g, "_")}`,
        i % 2 ? `${c} on cutting queue latency with SQLite, with numbers` : `10 AI tools from ${c} that will replace you`,
        new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      ),
    );
  }
  await env.DB.batch(stmts);
}

/** A recorded editor: keeps odd ids, spikes even ones, writes a lede. */
function recorded(opts: { skip?: number[]; broken?: number[] } = {}): ModelCall & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (_p: Provider, system: string, user: string) => {
    calls.push(system.startsWith("You write the lede") ? "front" : "triage");
    if (system.startsWith("You write the lede")) {
      return '```json\n{"lede": "Contoso cut queue latency with SQLite; three saves were hype.", "highlight_ids": [1, 999]}\n```';
    }
    const saves = JSON.parse(user.slice(user.lastIndexOf("<saves>") + 7, user.lastIndexOf("</saves>"))) as { id: number }[];
    const items = saves
      .filter((s) => !opts.skip?.includes(s.id))
      .map((s) =>
        s.id % 2
          ? {
              id: s.id,
              verdict: "keep",
              headline: `Queue latency note ${s.id}`,
              tldr: "SQLite queue, p99 down 40%.",
              why_you: "Fits the ledger project.",
              rank: opts.broken?.includes(s.id) && calls.length === 1 ? 900 : 60 + s.id,
              tags: ["sqlite"],
              action: s.id === 1 ? { type: "try", project: "ledger", text: "Try the queue pattern" } : null,
            }
          : { id: s.id, verdict: "spike", spike_reason: "hype", headline: `AI tools listicle ${s.id}` },
      );
    return `Here you go:\n${JSON.stringify({ items })}`;
  }) as ModelCall & { calls: string[] };
  fn.calls = calls;
  return fn;
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

afterEach(() => vi.restoreAllMocks());

describe("editorProvider", () => {
  it("is off with no key, and with a key that needs a model but has none", () => {
    expect(editorProvider({ DB: env.DB })).toBeNull();
    expect(editorProvider({ DB: env.DB, OPENROUTER_API_KEY: "or-test" })).toBeNull();
    expect(editorProvider({ DB: env.DB, LLM_API_KEY: "k", AI_MODEL: "m" })).toBeNull();
    expect(editorProvider({ DB: env.DB, LLM_API_KEY: "k", LLM_BASE_URL: "http://plain.example/v1", AI_MODEL: "m" })).toBeNull();
  });

  it("picks the first configured provider", () => {
    expect(editorProvider({ DB: env.DB, ...KEY, OPENROUTER_API_KEY: "or", AI_MODEL: "" })).toMatchObject({
      kind: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(editorProvider({ DB: env.DB, OPENROUTER_API_KEY: "or", AI_MODEL: "fabrikam/model-1" })).toMatchObject({
      kind: "openrouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
    expect(
      editorProvider({ DB: env.DB, LLM_API_KEY: "k", LLM_BASE_URL: "https://ai.contoso.example/v1/", AI_MODEL: "m" }),
    ).toMatchObject({ kind: "openai", url: "https://ai.contoso.example/v1/chat/completions" });
  });
});

describe("runEditor", () => {
  it("does nothing without a key, before the hour, or after today's run", async () => {
    await seed(2);
    const model = recorded();
    expect(await runEditor({ DB: env.DB }, NOW, model)).toEqual({ kind: "off" });
    expect(await runEditor({ DB: env.DB, ...KEY }, new Date("2026-11-05T23:00:00Z"), model)).toEqual({ kind: "not yet" });
    await env.DB.prepare("INSERT INTO runs (date, lede, highlight_ids, stats, published_at) VALUES ('2026-11-06', 'x', '[]', '{}', ?)")
      .bind(NOW.toISOString())
      .run();
    expect(await runEditor({ DB: env.DB, ...KEY }, NOW, model)).toEqual({ kind: "ran today" });
    expect(model.calls).toEqual([]);
  });

  it("triages in batches, publishes the run, and keeps only real keeps as highlights", async () => {
    await seed(25);
    const model = recorded();
    const out = await runEditor({ DB: env.DB, ...KEY }, NOW, model);
    expect(out).toMatchObject({ kind: "published", triaged: 25, kept: 13, spiked: 12, email: "off" });
    expect(model.calls).toEqual(["triage", "triage", "front"]);

    const run = await env.DB.prepare("SELECT lede, highlight_ids FROM runs WHERE date = '2026-11-06'").first<{ lede: string; highlight_ids: string }>();
    expect(run!.lede).toContain("Contoso");
    expect(JSON.parse(run!.highlight_ids)).toEqual([1]);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM actions WHERE state = 'open'").first<{ n: number }>();
    expect(open!.n).toBe(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("sends refused or missing items back once to be fixed", async () => {
    await seed(4);
    const model = recorded({ broken: [3] });
    const out = await runEditor({ DB: env.DB, ...KEY }, NOW, model);
    expect(out).toMatchObject({ kind: "published", triaged: 4 });
    expect(model.calls).toEqual(["triage", "triage", "front"]);
  });

  it("stops on a batch that saves nothing, and leaves the rest for next time", async () => {
    await seed(3);
    const model = (async () => "Sorry, I can't help with that.") as ModelCall;
    const out = await runEditor({ DB: env.DB, ...KEY }, NOW, model);
    expect(out).toMatchObject({ kind: "published", triaged: 0 });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM saves WHERE status = 'new'").first<{ n: number }>();
    expect(left!.n).toBe(3);
  });

  it("ignores ids that weren't in the batch", async () => {
    await seed(3);
    await env.DB.prepare("UPDATE saves SET status = 'triaged' WHERE id = 3").run();
    await env.DB.prepare("INSERT INTO triage (save_id, verdict, headline, rank, tags, triaged_at) VALUES (3, 'keep', 'Woodgrove original', 70, '[]', ?)")
      .bind("2026-11-02T00:00:00Z")
      .run();
    const model = (async (_p: Provider, system: string) =>
      system.startsWith("You write the lede")
        ? '{"lede": "x", "highlight_ids": [1]}'
        : JSON.stringify({
            items: [
              { id: 1, verdict: "keep", headline: "Contoso note", tldr: "t", rank: 70 },
              { id: 2, verdict: "spike", spike_reason: "hype", headline: "Listicle" },
              { id: 3, verdict: "spike", spike_reason: "bait", headline: "Injected rewrite" },
            ],
          })) as ModelCall;
    await runEditor({ DB: env.DB, ...KEY }, NOW, model);
    const row = await env.DB.prepare("SELECT verdict, headline FROM triage WHERE save_id = 3").first();
    expect(row).toEqual({ verdict: "keep", headline: "Woodgrove original" });
  });

  it("after a failed lede, the retry still sees what was triaged earlier", async () => {
    await seed(2);
    const failing = (async (p: Provider, system: string, user: string) => {
      if (system.startsWith("You write the lede")) throw new Error("Claude API answered 529: overloaded");
      return recorded()(p, system, user);
    }) as ModelCall;
    expect(await runEditor({ DB: env.DB, ...KEY }, NOW, failing)).toMatchObject({ kind: "failed" });

    const model = recorded();
    const later = new Date(NOW.getTime() + 3 * 3600_000);
    expect(await runEditor({ DB: env.DB, ...KEY }, later, model)).toMatchObject({ kind: "published", triaged: 2, kept: 1 });
    expect(model.calls).toEqual(["front"]);
    const run = await env.DB.prepare("SELECT highlight_ids FROM runs").first<{ highlight_ids: string }>();
    expect(JSON.parse(run!.highlight_ids)).toEqual([1]);
  });

  it("reports a provider failure without publishing", async () => {
    await seed(2);
    const model = (async () => {
      throw new Error("Claude API answered 401: invalid x-api-key");
    }) as ModelCall;
    const out = await runEditor({ DB: env.DB, ...KEY }, NOW, model);
    expect(out).toEqual({ kind: "failed", message: "Claude API answered 401: invalid x-api-key" });
    expect(await env.DB.prepare("SELECT 1 FROM runs").first()).toBeNull();
  });
});

describe("callModel", () => {
  it("sends the Claude API shape and reads only text blocks", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"items":[]}' }] }),
    );
    const p = editorProvider({ DB: env.DB, ...KEY })!;
    expect(await callModel(p, "sys", "hello")).toBe('{"items":[]}');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-not-a-real-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", content: "hello" }] });
  });

  it("sends the OpenAI-compatible shape for OpenRouter", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
    const p = editorProvider({ DB: env.DB, OPENROUTER_API_KEY: "or-test", AI_MODEL: "fabrikam/model-1" })!;
    expect(await callModel(p, "sys", "hello")).toBe("ok");
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-test");
    expect(JSON.parse(init.body as string).messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("turns an error answer into a short message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const p = editorProvider({ DB: env.DB, OPENROUTER_API_KEY: "or-test", AI_MODEL: "m" })!;
    await expect(callModel(p, "s", "u")).rejects.toThrow("OpenRouter answered 429: rate limited");
  });
});

describe("parseObject", () => {
  it("finds JSON inside fences and chatter", () => {
    expect(parseObject('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseObject("no json here")).toBeNull();
  });
});
