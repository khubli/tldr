# Configuration

Every setting tldr reads. Nothing here is committed: secrets are set with
`npx wrangler secret put NAME` (or in the Cloudflare dashboard under
**Workers & Pages → tldr → Settings → Variables and Secrets**, type
**Secret**), and the two deploy settings are passed by `npm run deploy`.

## Deploy settings

Set in your shell for `npm run deploy`, or as GitHub repository
**variables** for deploy-on-merge (docs/setup.md, step 3b).

| Name | Required | Default | What it does |
|---|---|---|---|
| `TLDR_DOMAIN` | yes | none | Your domain, e.g. `tldr.example.com`. Becomes the Worker's custom domain and `SITE_URL`. |
| `EDITION_TZ` | no | `UTC` | Your time zone (IANA name, e.g. `Europe/London`). Datelines, the morning email, Snooze's 6am, the editor's hour and the 8am missed-run check all use it. |

## Access (required)

Until all three are set, every request gets an empty 403.

| Secret | What it is |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | The Access application's Audience (AUD) tag |
| `ALLOWED_EMAIL` | The one email allowed in; the same as the Access policy |

## The editor (pick one mode)

**Mode A, your Claude plan over MCP** (docs/setup.md, step 7):

| Secret | What it is |
|---|---|
| `MCP_TOKEN` | A random token of 32+ characters (`openssl rand -hex 32`). Without it, `/mcp` is off. |

**Mode B, the Worker with an AI key** (docs/setup.md, step 7b). First match wins:

| Secrets | Provider |
|---|---|
| `ANTHROPIC_API_KEY`, optional `AI_MODEL` (default `claude-opus-5-5`) | Claude API |
| `OPENROUTER_API_KEY`, `AI_MODEL` | OpenRouter |
| `LLM_API_KEY`, `LLM_BASE_URL` (https), `AI_MODEL` | Any OpenAI-compatible API |
| `EDITOR_HOUR` (optional, 0 to 23, default 6) | Local hour from which the daily run may start |

## Sources (all optional except what you use)

| Secret | What it does |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | Your X app's OAuth 2.0 credentials, for bookmark sync |
| `GITHUB_USER` | Whose GitHub stars to read |
| `GITHUB_TOKEN` | Optional; raises GitHub's rate limit (a fine-grained token with Starring: read) |
| `YOUTUBE_API_KEY`, `YOUTUBE_PLAYLIST_ID` | Sync an Unlisted playlist. Sharing videos from the YouTube app needs neither. |

## The morning email (optional)

| Name | What it does |
|---|---|
| `MAILER` | The `send_email` binding in `wrangler.toml`; nothing to set |
| `MAIL_FROM` | Sender on a domain onboarded to Cloudflare Email Sending, e.g. `tldr@example.com` |
| `MAIL_TO` | Optional; defaults to `ALLOWED_EMAIL`. Must be a verified destination address. |

## Local development only

| Name | What it does |
|---|---|
| `ALLOW_LOCAL_DEV` | In `.dev.vars` only: lets requests to localhost skip the Access check. Never set it in production. |

## What tldr stores

All in your D1 database `tldr`: saves, the editor's verdicts, actions and
your taps on them, morning runs, your profile (every version), the X tokens,
sync state per source, and a log of emails sent. Nothing is written anywhere
else.
