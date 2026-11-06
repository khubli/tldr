# Contributing

Thanks for helping. tldr is a small, single-reader app, so the bar for new
features is "does it make the morning page better for one person?"

## Run it

```sh
npx npm@11 install        # npm 10 can hit an 'edgesOut' bug with this tree
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev               # http://localhost:8787, Access skipped locally
npm test                  # offline: no network, no real AI or X calls
npm run typecheck
```

## Where things live

| Path | What |
|---|---|
| `src/index.ts` | Routes, the Access gate, the cron |
| `src/access.ts` | Cloudflare Access login check (fails closed) |
| `src/capture.ts` | Share, paste, link cleaning, dedupe |
| `src/x.ts`, `src/github.ts`, `src/youtube.ts`, `src/sources.ts` | Sources |
| `src/brain.ts` | The editor's tools and every check on what it writes |
| `src/mcp.ts` | Mode A: the remote MCP endpoint |
| `src/editor.ts` | Mode B: the Worker as editor with an AI key |
| `src/desk.ts`, `src/page.ts` | The Desk and the back pages |
| `src/loop.ts`, `src/mail.ts` | Morgue, circulation, email |
| `migrations/` | D1 schema, applied in order |
| `public/` | PWA manifest, icons, CSS, the small client script |
| `demo/seed.sql`, `scripts/build-demo.mjs` | The public demo: real pages over made-up data |
| `test/` | Vitest in the Workers runtime, fictional fixtures only |

## Adding a source

Write a sync function like `syncStars` in `src/github.ts`: read only what the
platform's official API allows, insert into `saves` with a stable
`source_id`, keep state in `source_state`, and return a `SourceSyncResult` so
the Desk can show its status. Call it from the cron in `src/index.ts`, add
its settings to `docs/configuration.md`, and test it with recorded responses.
No scraping.

## Rules for every change

- **No personal data**, ever: fixtures and screenshots use fictional people
  and companies (Contoso, Fabrikam, Woodgrove Bank, Northwind).
- **Fail closed:** new pages and APIs go through the Access check.
- **The look** follows `docs/design-brief.md`. If a screen starts to look
  like a SaaS dashboard, it's wrong.
- Tests pass offline, and the typecheck is clean. Pull requests are reviewed
  before merge.
