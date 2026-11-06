import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import { readmeText, syncStars } from "../src/github";
import worker from "../src/index";
import { formatDuration, syncPlaylist, youTubeVideoId } from "../src/youtube";
import { authed, form, stubCerts } from "./helpers";

// Fictional fixtures only: Contoso, Fabrikam, Woodgrove Bank.
const NOW = new Date("2026-11-06T06:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// ── a fake GitHub ───────────────────────────────────────────────────────────

let stars: { name: string; starredAt: string; description?: string }[] = [];
let ghCalls: string[] = [];
let ghStatus = 200;

function star(name: string, starredAt: string, description = `${name} does one thing well`) {
  stars.unshift({ name, starredAt, description }); // newest first, like the API
}

function github(url: URL, init?: RequestInit): Response | undefined {
  if (url.hostname !== "api.github.com") return undefined;
  ghCalls.push(url.pathname + url.search);
  if (ghStatus !== 200) return new Response("{}", { status: ghStatus });
  const accept = new Headers(init?.headers).get("Accept");
  const starred = url.pathname.match(/^\/users\/([^/]+)\/starred$/);
  if (starred) {
    expect(accept).toBe("application/vnd.github.star+json");
    const per = Number(url.searchParams.get("per_page"));
    const page = Number(url.searchParams.get("page"));
    const slice = stars.slice((page - 1) * per, page * per);
    return Response.json(
      slice.map((s) => ({
        starred_at: s.starredAt,
        repo: {
          full_name: s.name,
          html_url: `https://github.com/${s.name}`,
          description: s.description,
          language: "TypeScript",
          topics: ["workers", "sqlite"],
          stargazers_count: 1234,
          owner: { login: s.name.split("/")[0] },
        },
      })),
    );
  }
  const readme = url.pathname.match(/^\/repos\/(.+)\/readme$/);
  if (readme) {
    return new Response(`[![CI](https://x/badge.svg)](https://x)\n# ${readme[1]}\n\n<p align="center"><img src="logo.png"></p>\nA small queue for D1.`);
  }
  return new Response("{}", { status: 404 });
}

// ── a fake YouTube ──────────────────────────────────────────────────────────

let playlist: { id: string; title: string; addedAt: string }[] = [];
let ytCalls: string[] = [];
let ytError: { status: number; reason?: string } | null = null;

function youtube(url: URL): Response | undefined {
  if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
    ytCalls.push("oembed " + url.searchParams.get("url"));
    if (url.searchParams.get("url") !== "https://www.youtube.com/watch?v=Abc123_xyz-") return new Response("Not Found", { status: 404 });
    return Response.json({ title: "How Contoso runs SQLite at the edge", author_name: "Contoso Engineering" });
  }
  if (url.hostname !== "www.googleapis.com") return undefined;
  ytCalls.push(url.pathname + "?" + url.searchParams.get("pageToken") + "&" + url.searchParams.get("id"));
  expect(url.searchParams.get("key")).toBe("test-yt-key");
  if (ytError) return Response.json({ error: { errors: [{ reason: ytError.reason }] } }, { status: ytError.status });
  if (url.pathname === "/youtube/v3/playlistItems") {
    const start = Number(url.searchParams.get("pageToken") || 0);
    const items = playlist.slice(start, start + 50);
    return Response.json({
      items: items.map((v) => ({ snippet: { title: v.title, publishedAt: v.addedAt, resourceId: { videoId: v.id } }, contentDetails: { videoId: v.id } })),
      nextPageToken: start + 50 < playlist.length ? String(start + 50) : undefined,
    });
  }
  if (url.pathname === "/youtube/v3/videos") {
    const ids = (url.searchParams.get("id") ?? "").split(",");
    return Response.json({
      items: ids.map((id) => ({
        id,
        snippet: { title: `Fabrikam talk ${id}`, description: `How Fabrikam ships ${id}.`, channelTitle: "Fabrikam Engineering" },
        contentDetails: { duration: "PT14M5S" },
      })),
    });
  }
  return new Response("{}", { status: 404 });
}

const ghEnv = (extra: Record<string, string> = {}) => ({ ...env, GITHUB_USER: "contoso-dev", ...extra });
const ytEnv = { ...env, YOUTUBE_API_KEY: "test-yt-key", YOUTUBE_PLAYLIST_ID: "PLcontoso0123456789" };
const saves = async (source: string) =>
  (await env.DB.prepare("SELECT source_id, url, title, author, text, enriched_text, saved_at FROM saves WHERE source = ? ORDER BY id").bind(source).all<Record<string, string>>()).results;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM saves"), env.DB.prepare("DELETE FROM source_state")]);
  stars = [];
  ghCalls = [];
  ghStatus = 200;
  playlist = [];
  ytCalls = [];
  ytError = null;
  resetAccessKeyCache();
  await stubCerts((url, init) => github(url, init) ?? youtube(url));
});
afterEach(() => vi.restoreAllMocks());

describe("GitHub stars", () => {
  it("is off until GITHUB_USER is set", async () => {
    expect(await syncStars(env, NOW)).toEqual({ kind: "off" });
    expect(ghCalls).toHaveLength(0);
  });

  it("first sync takes the last 30 days of stars, with README text", async () => {
    star("woodgrove/old-thing", daysAgo(45));
    star("fabrikam/queue", daysAgo(10));
    star("contoso/ledger", daysAgo(1));
    expect(await syncStars(ghEnv(), NOW)).toEqual({ kind: "ok", added: 2 });

    const rows = await saves("github_star");
    expect(rows.map((r) => r.source_id)).toEqual(["fabrikam/queue", "contoso/ledger"]); // oldest first
    expect(rows[1]).toMatchObject({
      url: "https://github.com/contoso/ledger",
      title: "contoso/ledger",
      author: "@contoso",
      saved_at: daysAgo(1),
    });
    expect(rows[1].text).toBe("contoso/ledger does one thing well\nTypeScript · 1,234 stars · topics: workers, sqlite");
    expect(rows[1].enriched_text).toBe("# contoso/ledger\n\nA small queue for D1.");
  });

  it("later syncs add only new stars, and stop at the first page with nothing new", async () => {
    star("fabrikam/queue", daysAgo(10));
    await syncStars(ghEnv(), NOW);
    star("contoso/new-one", daysAgo(0));
    ghCalls = [];
    expect(await syncStars(ghEnv(), NOW)).toEqual({ kind: "ok", added: 1 });
    expect(ghCalls.filter((c) => c.includes("/starred"))).toHaveLength(1);
    expect(await syncStars(ghEnv(), NOW)).toEqual({ kind: "ok", added: 0 });
  });

  it("records a failure for the Desk, with a token never shown", async () => {
    ghStatus = 401;
    const res = await syncStars(ghEnv({ GITHUB_TOKEN: "ghp_secret" }), NOW);
    expect(res).toEqual({ kind: "error", message: "GitHub rejected GITHUB_TOKEN; make a new one" });
    const html = await (await worker.fetch(await authed("/"), env)).text();
    expect(html).toContain("GitHub: GitHub rejected GITHUB_TOKEN; make a new one");
    expect(html).not.toContain("ghp_secret");
  });

  it("says so when no stars are visible without a token (a private profile)", async () => {
    expect(await syncStars(ghEnv(), NOW)).toEqual({
      kind: "error",
      message: "No stars visible; if your GitHub profile is private, add GITHUB_TOKEN (Starring: read)",
    });
    expect(await syncStars(ghEnv({ GITHUB_TOKEN: "ghp_test" }), NOW)).toEqual({ kind: "ok", added: 0 });
  });

  it("cleans a README down to its prose", () => {
    expect(readmeText("<!-- x -->\n![logo](a.png)\n\n\n\n# Title\nBody")).toBe("# Title\nBody");
    expect(readmeText("   ")).toBeNull();
  });
});

describe("YouTube playlist", () => {
  it("is off until the key and playlist are set", async () => {
    expect(await syncPlaylist(env, NOW)).toEqual({ kind: "off" });
    expect(ytCalls).toHaveLength(0);
  });

  it("reads the whole playlist, skips private and deleted videos, and fetches details once", async () => {
    for (let i = 0; i < 60; i++) playlist.push({ id: `vid${String(i).padStart(5, "0")}`, title: "x", addedAt: daysAgo(60 - i) });
    playlist.push({ id: "gone0000001", title: "Deleted video", addedAt: daysAgo(0) });
    playlist.push({ id: "priv0000001", title: "Private video", addedAt: daysAgo(0) });
    expect(await syncPlaylist(ytEnv, NOW)).toEqual({ kind: "ok", added: 60 });

    const rows = await saves("youtube");
    expect(rows).toHaveLength(60);
    expect(rows[59]).toMatchObject({
      source_id: "vid00059",
      url: "https://www.youtube.com/watch?v=vid00059",
      title: "Fabrikam talk vid00059",
      author: "Fabrikam Engineering",
      text: "Video, 14 min\nHow Fabrikam ships vid00059.",
      saved_at: daysAgo(1),
    });

    ytCalls = [];
    playlist.push({ id: "vidNEW00001", title: "x", addedAt: daysAgo(0) });
    expect(await syncPlaylist(ytEnv, NOW)).toEqual({ kind: "ok", added: 1 });
    expect(ytCalls.filter((c) => c.startsWith("/youtube/v3/videos"))).toEqual(["/youtube/v3/videos?null&vidNEW00001"]);
  });

  it("explains a Private playlist, without leaking the key", async () => {
    ytError = { status: 403, reason: "playlistItemsNotAccessible" };
    expect(await syncPlaylist(ytEnv, NOW)).toEqual({ kind: "error", message: "YouTube playlist is Private; make it Unlisted" });
    const html = await (await worker.fetch(await authed("/"), env)).text();
    expect(html).toContain("YouTube: YouTube playlist is Private; make it Unlisted");
    expect(html).not.toContain("test-yt-key");
  });

  it("formats video lengths", () => {
    expect(formatDuration("PT14M5S")).toBe("14 min");
    expect(formatDuration("PT1H2M30S")).toBe("1 h 3 min");
    expect(formatDuration("PT20S")).toBe("1 min");
    expect(formatDuration("P0D")).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
  });
});

describe("YouTube videos shared from the phone", () => {
  const share = async (text: string, title = "") => {
    const f = form({ title, text });
    return worker.fetch(await authed("/share", { method: "POST", body: f.body, headers: f.headers }), env);
  };

  it("gets the title and channel from YouTube's public embed lookup, with no key", async () => {
    await share("https://youtu.be/Abc123_xyz-?si=tracking123");
    const row = await env.DB.prepare("SELECT url, title, author, text FROM saves").first<Record<string, string>>();
    expect(row).toEqual({
      url: "https://youtu.be/Abc123_xyz-",
      title: "How Contoso runs SQLite at the edge",
      author: "Contoso Engineering",
      text: "Video: How Contoso runs SQLite at the edge, from the YouTube channel Contoso Engineering.",
    });
    expect(ytCalls).toEqual(["oembed https://www.youtube.com/watch?v=Abc123_xyz-"]);
  });

  it("keeps the save when the lookup fails", async () => {
    await share("https://www.youtube.com/watch?v=Zzz999_xyz-", "Woodgrove talk");
    const row = await env.DB.prepare("SELECT title, author FROM saves").first<Record<string, string | null>>();
    expect(row).toEqual({ title: "Woodgrove talk", author: null });
  });

  it("recognises watch, youtu.be, Shorts and mobile links", () => {
    expect(youTubeVideoId("https://youtu.be/Abc123_xyz-")).toBe("Abc123_xyz-");
    expect(youTubeVideoId("https://m.youtube.com/watch?v=Abc123_xyz-&t=30")).toBe("Abc123_xyz-");
    expect(youTubeVideoId("https://www.youtube.com/shorts/Abc123_xyz-")).toBe("Abc123_xyz-");
    expect(youTubeVideoId("https://www.youtube.com/@contoso")).toBeNull();
    expect(youTubeVideoId("https://fabrikam.example/watch?v=Abc123_xyz-")).toBeNull();
  });
});

describe("on the Desk and the cron", () => {
  it("the cron syncs both sources, and the Desk says so", async () => {
    // The cron runs on the real clock, so this star is from today.
    star("contoso/ledger", new Date().toISOString());
    playlist.push({ id: "vid00000001", title: "x", addedAt: daysAgo(0) });
    const e = { ...ytEnv, GITHUB_USER: "contoso-dev" };
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "7 */3 * * *" }), e, ctx);
    await waitOnExecutionContext(ctx);
    expect(await saves("github_star")).toHaveLength(1);
    expect(await saves("youtube")).toHaveLength(1);

    const html = await (await worker.fetch(await authed("/"), e)).text();
    expect(html).toMatch(/GitHub stars synced [^<]*, 1 new · YouTube synced [^<]*, 1 new/);
  });
});
