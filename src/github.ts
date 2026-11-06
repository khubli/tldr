// GitHub stars: repos the reader starred become saves.
//
// Official REST API, "list repositories starred by a user", with the star
// media type so each item carries when it was starred. Public data: no token
// needed (60 requests an hour), but GITHUB_TOKEN raises the limit. The first
// sync only takes stars from the last 30 days; after that, new stars only.
// Text for the editor = the repo's description, language and topics, plus
// the start of its README.

import { errorMessage, getState, insertSaves, knownIds, recordError, recordOk, type NewSave, type SourceSyncResult } from "./sources";

export interface GitHubEnv {
  DB: D1Database;
  GITHUB_USER?: string; // whose stars to read
  GITHUB_TOKEN?: string; // optional fine-grained token with no extra permissions
}

export const GITHUB_API = "https://api.github.com";
export const BACKFILL_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_READMES = 15; // README fetches per sync, to stay inside the hourly limit
const README_CHARS = 4000;

interface StarItem {
  starred_at?: string;
  repo?: {
    full_name?: string;
    html_url?: string;
    description?: string | null;
    language?: string | null;
    topics?: string[];
    stargazers_count?: number;
    owner?: { login?: string };
    archived?: boolean;
  };
}

export function isGitHubConfigured(env: GitHubEnv): boolean {
  return /^[A-Za-z0-9-]{1,39}$/.test(env.GITHUB_USER?.trim() ?? "");
}

export async function syncStars(env: GitHubEnv, now = new Date()): Promise<SourceSyncResult> {
  if (!isGitHubConfigured(env)) return { kind: "off" };
  const user = env.GITHUB_USER!.trim();
  const state = await getState(env.DB, "github_star");
  const backfill = !state?.backfill_done;
  const cutoff = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();

  const fresh: NewSave[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${GITHUB_API}/users/${encodeURIComponent(user)}/starred?sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`;
      const items = (await ghJson(env, url, "application/vnd.github.star+json")) as StarItem[];
      if (!Array.isArray(items)) throw new Error("GitHub returned something unexpected");
      // A private profile's stars come back as an empty list unless the
      // request is signed in as that user. Say so rather than look healthy.
      if (page === 1 && items.length === 0 && !env.GITHUB_TOKEN?.trim()) {
        throw new Error("No stars visible; if your GitHub profile is private, add GITHUB_TOKEN (Starring: read)");
      }
      const stars = items.map(toSave).filter((s): s is NewSave => s !== null);
      const inWindow = backfill ? stars.filter((s) => s.saved_at >= cutoff) : stars;
      const known = await knownIds(env.DB, "github_star", inWindow.map((s) => s.source_id));
      const newOnes = inWindow.filter((s) => !known.has(s.source_id));
      fresh.push(...newOnes);
      // Newest first: stop at the end, at the backfill window, or at a page with nothing new.
      if (items.length < PAGE_SIZE || inWindow.length < stars.length || newOnes.length === 0) break;
    }
    for (const s of fresh.slice(0, MAX_READMES)) {
      s.enriched_text = await readme(env, s.source_id);
    }
  } catch (err) {
    const message = errorMessage(err);
    await recordError(env.DB, "github_star", message);
    await insertSaves(env.DB, "github_star", fresh);
    return { kind: "error", message };
  }
  const added = await insertSaves(env.DB, "github_star", fresh);
  await recordOk(env.DB, "github_star", added, now);
  return { kind: "ok", added };
}

export function toSave(item: StarItem): NewSave | null {
  const repo = item.repo;
  if (!repo?.full_name || !repo.html_url || !item.starred_at) return null;
  if (!/^https:\/\/github\.com\//.test(repo.html_url)) return null;
  const facts = [
    repo.language ? repo.language : null,
    typeof repo.stargazers_count === "number" ? `${repo.stargazers_count.toLocaleString("en-US")} stars` : null,
    repo.topics?.length ? `topics: ${repo.topics.slice(0, 8).join(", ")}` : null,
    repo.archived ? "archived" : null,
  ].filter(Boolean);
  const text = [repo.description?.trim() || null, facts.length ? facts.join(" · ") : null].filter(Boolean).join("\n");
  return {
    source_id: repo.full_name,
    url: repo.html_url,
    title: repo.full_name,
    author: repo.owner?.login ? `@${repo.owner.login}` : null,
    text: text || null,
    saved_at: new Date(item.starred_at).toISOString(),
  };
}

/** The start of the repo's README as plain-ish text, or null. Never throws. */
async function readme(env: GitHubEnv, fullName: string): Promise<string | null> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${fullName}/readme`, {
      headers: headers(env, "application/vnd.github.raw+json"),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return readmeText(await res.text());
  } catch {
    return null;
  }
}

/** Drops badges, images, HTML tags and blank runs; keeps the prose and headings. */
export function readmeText(raw: string): string | null {
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "") // linked badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, README_CHARS) : null;
}

async function ghJson(env: GitHubEnv, url: string, accept: string): Promise<unknown> {
  const res = await fetch(url, { headers: headers(env, accept), signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error("GitHub user not found; check GITHUB_USER");
  if (res.status === 401) throw new Error("GitHub rejected GITHUB_TOKEN; make a new one");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit hit; it retries on the next sync");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

function headers(env: GitHubEnv, accept: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "User-Agent": "tldr-reader",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = env.GITHUB_TOKEN?.trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
