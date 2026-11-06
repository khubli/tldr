// YouTube: videos saved to one playlist become saves.
//
// YouTube's API doesn't return Watch Later (it has come back empty since
// 2016), so the reader saves to their own playlist instead, say "tldr". Make
// it Unlisted: the official Data API v3 then reads it with a plain API key, no
// Google sign-in. Each sync reads the playlist (1 quota unit per 50 videos,
// of 10,000 free a day), then fetches title, channel, length and description
// for the videos it hasn't seen. Transcripts of other people's videos aren't
// available through the official API, so the editor judges from these.

import { errorMessage, insertSaves, knownIds, recordError, recordOk, type NewSave, type SourceSyncResult } from "./sources";

export interface YouTubeEnv {
  DB: D1Database;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_PLAYLIST_ID?: string;
}

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const MAX_PAGES = 20; // 1,000 videos
const TEXT_CHARS = 4000;

interface PlaylistItem {
  snippet?: { publishedAt?: string; title?: string; resourceId?: { videoId?: string } };
  contentDetails?: { videoId?: string };
}

interface Video {
  id?: string;
  snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string };
  contentDetails?: { duration?: string };
}

export function isYouTubeConfigured(env: YouTubeEnv): boolean {
  return Boolean(env.YOUTUBE_API_KEY?.trim()) && /^[A-Za-z0-9_-]{10,64}$/.test(env.YOUTUBE_PLAYLIST_ID?.trim() ?? "");
}

export async function syncPlaylist(env: YouTubeEnv, now = new Date()): Promise<SourceSyncResult> {
  if (!isYouTubeConfigured(env)) return { kind: "off" };
  try {
    // Videos can sit anywhere in a playlist, so read all of it; it's cheap.
    const added = new Map<string, string>(); // video id -> when it was added to the playlist
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${YOUTUBE_API}/playlistItems`);
      url.searchParams.set("part", "snippet,contentDetails");
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("playlistId", env.YOUTUBE_PLAYLIST_ID!.trim());
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = (await ytJson(env, url)) as { items?: PlaylistItem[]; nextPageToken?: string };
      for (const item of body.items ?? []) {
        const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        const title = item.snippet?.title ?? "";
        if (!id || title === "Private video" || title === "Deleted video") continue;
        added.set(id, item.snippet?.publishedAt ?? now.toISOString());
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }

    const known = await knownIds(env.DB, "youtube", [...added.keys()]);
    const fresh = [...added.keys()].filter((id) => !known.has(id));
    const saves: NewSave[] = [];
    for (let i = 0; i < fresh.length; i += 50) {
      const url = new URL(`${YOUTUBE_API}/videos`);
      url.searchParams.set("part", "snippet,contentDetails");
      url.searchParams.set("id", fresh.slice(i, i + 50).join(","));
      const body = (await ytJson(env, url)) as { items?: Video[] };
      for (const v of body.items ?? []) {
        const save = toSave(v, added.get(v.id ?? "") ?? now.toISOString());
        if (save) saves.push(save);
      }
    }
    const count = await insertSaves(env.DB, "youtube", saves);
    await recordOk(env.DB, "youtube", count, now);
    return { kind: "ok", added: count };
  } catch (err) {
    const message = errorMessage(err);
    await recordError(env.DB, "youtube", message);
    return { kind: "error", message };
  }
}

// ── videos shared from the phone ────────────────────────────────────────────

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a YouTube watch, youtu.be or Shorts link, or null. */
export function youTubeVideoId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (host === "youtube.com" && u.pathname === "/watch") id = u.searchParams.get("v");
    else if (host === "youtube.com") id = u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1] ?? null;
    return id && VIDEO_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Title and channel for a video shared from the phone, from YouTube's free
 * public embed (oEmbed) endpoint: no key, no account. Returns null on any
 * failure; the save is kept either way.
 */
export async function lookupVideo(url: string): Promise<{ author: string; title: string; text: string } | null> {
  const id = youTubeVideoId(url);
  if (!id) return null;
  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", `https://www.youtube.com/watch?v=${id}`);
    endpoint.searchParams.set("format", "json");
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: string; author_name?: string };
    if (!body.title || !body.author_name) return null;
    return { author: body.author_name, title: body.title, text: `Video: ${body.title}, from the YouTube channel ${body.author_name}.` };
  } catch {
    return null;
  }
}

export function toSave(v: Video, addedAt: string): NewSave | null {
  if (!v.id || !/^[A-Za-z0-9_-]{6,20}$/.test(v.id) || !v.snippet?.title) return null;
  const length = formatDuration(v.contentDetails?.duration);
  const facts = ["Video", length].filter(Boolean).join(", ");
  const description = v.snippet.description?.trim();
  return {
    source_id: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    author: v.snippet.channelTitle ?? null,
    text: [facts, description || null].filter(Boolean).join("\n").slice(0, TEXT_CHARS),
    saved_at: new Date(addedAt).toISOString(),
  };
}

/** "PT1H2M30S" -> "1 h 3 min"; "PT14M5S" -> "14 min". */
export function formatDuration(iso: string | undefined): string | null {
  const m = iso?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const total = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  if (!total) return null;
  const minutes = Math.max(1, Math.round(total / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

async function ytJson(env: YouTubeEnv, url: URL): Promise<unknown> {
  url.searchParams.set("key", env.YOUTUBE_API_KEY!.trim());
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (res.ok) return res.json();
  // Never echo the URL: it carries the key.
  if (res.status === 404) throw new Error("YouTube playlist not found; check YOUTUBE_PLAYLIST_ID and that it's Unlisted, not Private");
  if (res.status === 403) {
    const reason = await res.json().then((b: any) => b?.error?.errors?.[0]?.reason as string | undefined).catch(() => undefined);
    if (reason === "playlistItemsNotAccessible") throw new Error("YouTube playlist is Private; make it Unlisted");
    if (reason === "quotaExceeded") throw new Error("YouTube daily quota used up; it retries tomorrow");
    throw new Error("YouTube refused the API key; check YOUTUBE_API_KEY");
  }
  if (res.status === 400) throw new Error("YouTube refused the request; check YOUTUBE_API_KEY and YOUTUBE_PLAYLIST_ID");
  throw new Error(`YouTube answered ${res.status}`);
}
