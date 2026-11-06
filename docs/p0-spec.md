# tldr P0 spec

**Goal:** every morning, one edition at tldr.example.com (plus an email) covering everything saved since yesterday: top stories, an action list, briefs, and what was spiked.

## Architecture (one Cloudflare Worker)

```
 Capture                 Store            Brain (Claude Pro)          Read
 ───────                 ─────            ──────────────────          ────
 X sync (cron) ─┐                         Daily scheduled task
 Share menu    ─┼─► Worker ─► D1 ◄──MCP──► reads profile + new saves  ─► Edition page
 Paste box     ─┘   (+ enrich links)       triages, writes edition     ─► Email (Gmail)
                         ▲                                              
                         └──── Done / Snooze / Drop (feedback) ◄────────┘
```

- **Hosting:** one Worker on `tldr.example.com`, with D1 for data and the X tokens. Cron for X sync.
- **Privacy:** Cloudflare Access covers the whole site. The Worker also checks the Access login header on every request and returns nothing if it's missing (fails closed).
- **Brain, mode A (the author's):** a Claude scheduled task runs daily early in the morning on a Claude Pro plan. It reaches the Worker through a remote MCP connector added to Claude. No API key, no extra cost.
- **Brain, mode B (for open source; built 6 Nov 2026, `src/editor.ts`):** the Worker calls an AI provider directly (Anthropic API, OpenRouter, or any OpenAI-compatible endpoint). Both modes write the same triage format.

## Capture
| Source | How | P0? |
|---|---|---|
| X bookmarks | Official API, OAuth 2.0 with refresh token (`bookmark.read tweet.read users.read offline.access`). Owned reads, $0.001 per post, deduped per UTC day. First sync pulls the whole backlog (X returns about the newest 800); then every 3 hours, small pages, stop at the first page with nothing new. The API has no date filter and no bookmark time, so `saved_at` is when tldr first saw it. | Yes |
| X likes | Same API (`like.read`). Not needed for now. | Later |
| X posts shared from the phone | Author and text from X's free oEmbed endpoint (`publish.twitter.com/oembed`). | Yes |
| Anything on the phone | PWA **Web Share Target** (Android Chrome): share a URL or text to tldr. | Yes |
| Manual | Paste box on the "File copy" page, linked from the Desk. | Yes |
| Reddit backlog | One-time import of `saved_posts.csv` from Reddit's account data export. | P1 |
| GitHub stars | Official REST API, star dates; optional token. Built 6 Nov 2026. | Yes |
| YouTube | Share from the YouTube app; title and channel from YouTube's public oEmbed (no key). Optional: an Unlisted playlist read with an API key (Watch Later isn't readable through the API). Built 6 Nov 2026. | Yes |
| Newsletters | Cloudflare Email Routing to the Worker, fed by a Gmail forwarding filter. Parked 6 Nov 2026. | Later |

**Enrichment:** for each saved item, fetch the linked page (title, readable text, first 4,000 characters). Reddit pages may block this; keep whatever text was shared.

## Triage output (per item)
```json
{ "verdict": "keep|spike",
  "spike_reason": "hype|bait|repost|stale|basic|offtopic",
  "headline": "≤ 10 words",
  "tldr": "≤ 3 lines",
  "why_you": "1 line tied to me.md",
  "action": { "type": "try|read|apply|post|file", "project": "ledger|…|null", "text": "≤ 1 line" },
  "rank": 0-100, "tags": ["…"] }
```
The edition gets a one-paragraph lede written by the editor (the triage agent).

## MCP tools (Worker → Claude)
`get_profile` · `list_untriaged(limit)` · `save_triage(items[])` · `publish_morning_run(lede, highlight_ids)` · `get_feedback(days)` · `search_saves(query)`

Since D11 there are no dated editions: `publish_morning_run` (was `publish_edition`) records the run's lede and numbers for the Desk and the email, and is optional. Auth: a secret token in the connector URL, with an Access bypass on `/mcp` only (see `setup.md`, section 7).

## Data (D1)
`saves` (source, source_id, url, author, text, enriched_text, saved_at, status) · `x_account` (one row: tokens, sync state) · `triage` (one row per save, fields above) · `actions` (save_id, state open/done/snoozed/dropped, due) · `runs` (date, lede, highlight_ids, stats; was `editions` before D11) · `profile` (markdown, version)

## Build slices (one Claude Code session each)
1. **Skeleton and capture.** Worker, D1 schema, Access check (fails closed), PWA manifest with share target, paste box, plain list of saves. *Done when:* sharing a link from the phone shows up in the list.
2. **X sync.** OAuth connect page, token refresh, cron sync, dedupe. *Done when:* bookmarks from the last 7 days appear with author and text.
3. **Brain.** Remote MCP endpoint with auth; tools above; fixture tests. The owner adds the connector in Claude and creates the scheduled task (prompt in `docs/`). *Done when:* a manual run triages 20 items and publishes an edition.
4. **The Desk** (redefined by D11, 5 Nov 2026). One page per `design-brief.md`: masthead with one sync line; open actions with Done / Snooze / Drop that persist (Snooze hides for 3 days); ranked "Worth reading" of kept saves with TLDR and source link; one spiked-count line to the Morgue (with Rescue). Paste box moves to a "+ File copy" page; night edition via dark mode. *Done when:* on a phone you see your real actions and reading list, and taps stick.
5. **The loop.** Done / Snooze / Drop, 30-day Morgue, email of the edition via the scheduled task, Sunday stats. *Done when:* one full week runs without hand-holding.
   *Built 6 Nov 2026:* Done / Snooze / Drop shipped in slice 4. The email is sent by the Worker when the run publishes (Cloudflare Email Routing send binding, to the reader's verified address only), not by the scheduled task, so it doesn't depend on the model; a missed-run warning goes out by 8am local if no run published. Kept copy and open actions untouched for 30 days age into the Morgue, with "Bring back". Sunday circulation box on the Desk and in the email.

## One-time setup (the owner)
- console.x.com: create an app (or reuse one you own: owned-read pricing needs the app owner to be the reader), OAuth 2.0 on, callback `https://tldr.example.com/auth/x/callback`, credits and a spending limit.
- Cloudflare: DNS for `tldr.example.com`; Access application with policy = your email.
- GitHub: a private development repo; the public release is a fresh repo with one clean commit.
- Claude: add the tldr connector; create the daily scheduled task (slice 3).

## Out of scope for P0
Reddit import, learning from feedback, topic clusters, audio digest, auto-created GitHub issues, public demo site.
