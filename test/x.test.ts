import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import worker from "../src/index";
import { embedText, syncBookmarks } from "../src/x";
import { authed, form, ORIGIN, stubCerts } from "./helpers";

// A fake X: fictional accounts (Contoso, Fabrikam, Woodgrove Bank), bookmarks
// newest first, and a meter of how many posts it has returned (what X bills).
interface FakePost {
  id: string;
  text: string;
  author: string;
  long?: string;
}

class FakeX {
  bookmarks: FakePost[] = [];
  postsReturned = 0;
  pagesServed = 0;
  accessToken = "access-1";
  refreshToken = "refresh-1";
  refreshCalls = 0;
  refreshWorks = true;
  lastPageSize = 0;

  /** Adds new bookmarks on top, like bookmarking them now. */
  bookmark(n: number, start: number): void {
    const authors = ["contoso_eng", "fabrikam", "woodgrovebank"];
    const fresh = Array.from({ length: n }, (_, i) => {
      const id = String(1900000000000000000n + BigInt(start + i));
      return { id, text: `Post ${start + i} on shipping faster`, author: authors[(start + i) % 3] };
    }).reverse();
    this.bookmarks = [...fresh, ...this.bookmarks];
  }

  route = async (url: URL, init?: RequestInit): Promise<Response | undefined> => {
    if (url.href.startsWith("https://api.x.com/2/oauth2/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth !== `Basic ${btoa("test-client-id:test-client-secret")}`) return new Response(null, { status: 401 });
      if (body.get("grant_type") === "authorization_code") {
        if (body.get("code") !== "good-code" || !body.get("code_verifier")) return new Response(null, { status: 400 });
        return Response.json({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 7200 });
      }
      if (body.get("grant_type") === "refresh_token") {
        this.refreshCalls++;
        if (!this.refreshWorks || body.get("refresh_token") !== this.refreshToken) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        this.accessToken = `access-${this.refreshCalls + 1}`;
        this.refreshToken = `refresh-${this.refreshCalls + 1}`;
        return Response.json({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 7200 });
      }
      return new Response(null, { status: 400 });
    }

    const bearer = new Headers(init?.headers).get("Authorization");
    if (url.href === "https://api.x.com/2/users/me") {
      if (bearer !== `Bearer ${this.accessToken}`) return new Response(null, { status: 401 });
      return Response.json({ data: { id: "4242", username: "contoso_reader", name: "Contoso Reader" } });
    }

    if (url.pathname === "/2/users/4242/bookmarks" && url.hostname === "api.x.com") {
      if (bearer !== `Bearer ${this.accessToken}`) return new Response(null, { status: 401 });
      const size = Number(url.searchParams.get("max_results"));
      const start = Number(url.searchParams.get("pagination_token") ?? "0");
      const slice = this.bookmarks.slice(start, start + size);
      this.lastPageSize = size;
      this.pagesServed++;
      this.postsReturned += slice.length;
      const next = start + size < this.bookmarks.length ? String(start + size) : undefined;
      return Response.json({
        data: slice.map((p) => ({ id: p.id, text: p.text, author_id: `u-${p.author}`, ...(p.long ? { note_tweet: { text: p.long } } : {}) })),
        includes: { users: [...new Set(slice.map((p) => p.author))].map((a) => ({ id: `u-${a}`, username: a })) },
        meta: { result_count: slice.length, ...(next ? { next_token: next } : {}) },
      });
    }

    if (url.hostname === "publish.twitter.com" && url.pathname === "/oembed") {
      const target = url.searchParams.get("url") ?? "";
      if (!target.includes("/contoso_eng/status/1850000000000000001")) return new Response(null, { status: 404 });
      return Response.json({
        author_name: "Contoso Engineering",
        author_url: "https://twitter.com/contoso_eng",
        html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">We cut cold starts by 40% &amp; here&#39;s how<br>A thread</p>&mdash; Contoso Engineering (@contoso_eng) <a href="https://twitter.com/contoso_eng/status/1850000000000000001">November 1, 2026</a></blockquote>',
      });
    }
    return undefined;
  };
}

let x: FakeX;

async function connect(): Promise<void> {
  const start = await worker.fetch(await authed("/auth/x/connect"), env);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("Location")!);
  const state = authorize.searchParams.get("state")!;
  const back = await worker.fetch(await authed(`/auth/x/callback?state=${state}&code=good-code`), env);
  expect(back.headers.get("Location")).toBe(`${ORIGIN}/?flash=x_connected`);
}

const count = async (sql = "SELECT COUNT(*) AS n FROM saves") => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const home = async () => (await worker.fetch(await authed("/"), env)).text();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM saves"),
    env.DB.prepare("DELETE FROM x_account"),
    env.DB.prepare("DELETE FROM x_oauth_state"),
  ]);
  resetAccessKeyCache();
  x = new FakeX();
  await stubCerts(x.route);
});
afterEach(() => vi.restoreAllMocks());

describe("X login", () => {
  it("sends the reader to X with PKCE, the right scopes and the callback", async () => {
    const res = await worker.fetch(await authed("/auth/x/connect"), env);
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/x/callback`);
    expect(to.searchParams.get("scope")).toBe("bookmark.read tweet.read users.read offline.access");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("scope")).not.toContain("like.read");
  });

  it("connects and shows the account on the page", async () => {
    await connect();
    const html = await home();
    expect(html).toContain("@contoso_reader");
    expect(html).toContain("Not synced yet");
    expect(html).toContain('action="/x/sync"');
  });

  it("rejects a callback with an unknown state, and a state used twice", async () => {
    const bad = await worker.fetch(await authed("/auth/x/callback?state=forged&code=good-code"), env);
    expect(bad.headers.get("Location")).toBe(`${ORIGIN}/?flash=x_failed`);

    const start = await worker.fetch(await authed("/auth/x/connect"), env);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    await worker.fetch(await authed(`/auth/x/callback?state=${state}&code=good-code`), env);
    const replay = await worker.fetch(await authed(`/auth/x/callback?state=${state}&code=good-code`), env);
    expect(replay.headers.get("Location")).toBe(`${ORIGIN}/?flash=x_failed`);
  });

  it("is behind the Access check like every other page", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/x/callback?state=a&code=b`), env);
    expect(res.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM x_account")).toBe(0);
  });

  it("shows a Connect X link when not connected", async () => {
    expect(await home()).toContain('href="/auth/x/connect"');
  });
});

describe("bookmark sync", () => {
  it("the first sync pulls the whole backlog, newest on top, with author and text", async () => {
    x.bookmark(250, 0);
    x.bookmarks[0].long = "The full text of a long post from Woodgrove Bank";
    await connect();

    const result = await syncBookmarks(env);
    expect(result).toEqual({ kind: "ok", added: 250, pages: 3, backfill: true });
    expect(await count()).toBe(250);

    const top = await env.DB.prepare("SELECT * FROM saves ORDER BY saved_at DESC, id DESC LIMIT 1").first<Record<string, string>>();
    expect(top).toMatchObject({
      source: "x_bookmark",
      source_id: x.bookmarks[0].id,
      url: `https://x.com/${x.bookmarks[0].author}/status/${x.bookmarks[0].id}`,
      author: `@${x.bookmarks[0].author}`,
      text: "The full text of a long post from Woodgrove Bank",
    });

    expect(await home()).toContain("Synced just now, 250 new");
    // Untriaged copy waits on the wire, off the Desk.
    const wire = await (await worker.fetch(await authed("/file"), env)).text();
    expect(wire).toContain("X bookmark");
    expect(wire).toContain(`By @${x.bookmarks[0].author}`);
  });

  it("later syncs read one small page when nothing is new", async () => {
    x.bookmark(250, 0);
    await connect();
    await syncBookmarks(env);

    x.postsReturned = 0;
    const result = await syncBookmarks(env);
    expect(result).toMatchObject({ kind: "ok", added: 0, pages: 1, backfill: false });
    expect(x.lastPageSize).toBe(10);
    expect(x.postsReturned).toBe(10);
  });

  it("later syncs pick up new bookmarks and stop at the first page with nothing new", async () => {
    x.bookmark(250, 0);
    await connect();
    await syncBookmarks(env);

    x.bookmark(15, 1000);
    x.postsReturned = 0;
    const result = await syncBookmarks(env);
    expect(result).toMatchObject({ kind: "ok", added: 15, pages: 3 });
    expect(x.postsReturned).toBe(30);
    expect(await count()).toBe(265);
  });

  it("after falling far behind, the next sync does a full pass instead of losing bookmarks", async () => {
    x.bookmark(20, 0);
    await connect();
    await syncBookmarks(env);

    x.bookmark(130, 1000);
    const capped = await syncBookmarks(env);
    expect(capped).toMatchObject({ kind: "ok", added: 100, pages: 10, backfill: false });

    const catchUp = await syncBookmarks(env);
    expect(catchUp).toMatchObject({ kind: "ok", added: 30, backfill: true });
    expect(await count()).toBe(150);

    expect(await syncBookmarks(env)).toMatchObject({ kind: "ok", added: 0, pages: 1, backfill: false });
  });

  it("refreshes an expired token and keeps the new refresh token", async () => {
    x.bookmark(5, 0);
    await connect();
    await env.DB.prepare("UPDATE x_account SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();

    const result = await syncBookmarks(env);
    expect(result.kind).toBe("ok");
    expect(x.refreshCalls).toBe(1);
    const row = await env.DB.prepare("SELECT access_token, refresh_token FROM x_account").first<Record<string, string>>();
    expect(row).toEqual({ access_token: "access-2", refresh_token: "refresh-2" });
  });

  it("asks to reconnect when the refresh token stops working", async () => {
    x.bookmark(5, 0);
    await connect();
    x.refreshWorks = false;
    await env.DB.prepare("UPDATE x_account SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();

    const result = await syncBookmarks(env);
    expect(result).toEqual({ kind: "error", message: "X login has expired. Reconnect X." });
    const html = await home();
    expect(html).toContain("X login has expired. Reconnect X.");
    expect(html).toContain(">Reconnect</a>");
  });

  it("does nothing until X is connected", async () => {
    expect(await syncBookmarks(env)).toEqual({ kind: "not_connected" });
    expect(x.pagesServed).toBe(0);
  });

  it("runs on the cron", async () => {
    x.bookmark(3, 0);
    await connect();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "7 */3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count()).toBe(3);
  });

  it("the Sync now button syncs, and refuses other sites", async () => {
    x.bookmark(3, 0);
    await connect();
    const blocked = await worker.fetch(await authed("/x/sync", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } }), env);
    expect(blocked.status).toBe(403);
    expect(await count()).toBe(0);

    const res = await worker.fetch(await authed("/x/sync", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } }), env);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/?flash=x_synced`);
    expect(await count()).toBe(3);
  });
});

describe("X posts shared from the phone", () => {
  const share = async (text: string) => {
    const f = form({ title: "", text });
    return worker.fetch(await authed("/share", { method: "POST", body: f.body, headers: f.headers }), env);
  };

  it("gets the author and full text from X's embed endpoint", async () => {
    await share("https://x.com/contoso_eng/status/1850000000000000001?s=46");
    const row = await env.DB.prepare("SELECT author, text FROM saves").first<Record<string, string>>();
    expect(row).toEqual({ author: "@contoso_eng", text: "We cut cold starts by 40% & here's how\nA thread" });
  });

  it("keeps the save when the embed lookup fails", async () => {
    await share("Post by @fabrikam https://x.com/fabrikam/status/1850000000000000002");
    const row = await env.DB.prepare("SELECT author, text FROM saves").first<Record<string, string | null>>();
    expect(row).toEqual({ author: null, text: "Post by @fabrikam" });
  });

  it("a shared post that is also bookmarked is kept once", async () => {
    await share("https://x.com/contoso_eng/status/1850000000000000001");
    x.bookmarks = [{ id: "1850000000000000001", text: "We cut cold starts by 40%", author: "contoso_eng" }];
    x.bookmark(2, 0);
    await connect();
    const result = await syncBookmarks(env);
    expect(result).toMatchObject({ kind: "ok", added: 2 });
    expect(await count()).toBe(3);
  });
});

describe("embedText", () => {
  it("reads the post text out of the embed HTML", () => {
    expect(embedText('<blockquote><p lang="en">Hello <a href="https://t.co/x">@woodgrovebank</a> &quot;hi&quot;</p>&mdash; x</blockquote>')).toBe(
      'Hello @woodgrovebank "hi"',
    );
    expect(embedText("<div>no paragraph</div>")).toBeNull();
  });
});
