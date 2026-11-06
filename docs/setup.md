# Setup

One-time steps to put tldr on your own domain. Run commands from the repo root.
Nothing here gets committed: secrets live in Cloudflare, data lives in D1.

**Time:** about 45 minutes for the core (steps 1 to 7 or 7b), plus a few
minutes per optional source.

**You need:**
- A Cloudflare account with a domain on it (the Workers free plan is enough).
- Node.js 22 and a terminal.
- For X bookmarks: an X developer app with a few dollars of API credit.
  Reading your own bookmarks is billed per post (about $0.001 each at the
  time of writing), so a normal week costs cents.
- An editor: either a Claude plan with scheduled tasks and custom connectors
  (step 7, no extra bill), or an API key from Anthropic, OpenRouter or any
  OpenAI-compatible service (step 7b, pay per use).

Throughout, replace `tldr.example.com` with your own domain.

## 1. Lock the door first (Cloudflare Access)

Do this before the first deploy, so the site is never reachable without a login.

1. In the Cloudflare dashboard, open **Zero Trust**. If asked, pick a team name.
   Your team domain is `<team>.cloudflareaccess.com` (shown under
   **Settings → Custom pages** or **Settings → General**).
2. **Access → Applications → Add an application → Self-hosted.**
   - Domain: `tldr.example.com` (whole site, no path).
   - Policy: **Allow**, include **Emails**: your email address. Nothing else.
3. Save, then open the application and copy its **Application Audience (AUD) Tag**.

The Worker checks Access's signed login on every request too, so even if
Access is misconfigured the site shows nothing.

## 2. Create the database

```sh
npm install
npx wrangler login
npx wrangler d1 create tldr
```

When Wrangler offers to add the database id to `wrangler.toml`, say **no**.
The Worker finds the database by its name (`tldr`), so the id stays out of git.

```sh
npm run db:migrate:remote
```

## 3. Deploy

Your domain and time zone aren't in the repo; you pass them when you deploy.
`TLDR_DOMAIN` is where tldr lives. `EDITION_TZ` is your time zone, an IANA
name such as `Europe/London` or `America/New_York` (default `UTC`).

```sh
export TLDR_DOMAIN=tldr.example.com EDITION_TZ=Europe/London
npm run deploy
```

On Windows PowerShell:

```powershell
$env:TLDR_DOMAIN="tldr.example.com"; $env:EDITION_TZ="Europe/London"
npm run deploy
```

Later steps run `npm run deploy` again. Use the same terminal, or set the two
values again first; without `TLDR_DOMAIN` the deploy stops and says so.

`example.com` must already be a zone on your Cloudflare account. The deploy
creates the DNS record for `tldr.example.com` itself (it's a Workers custom
domain), so there's no DNS record to add by hand.

## 3b. Deploy on merge (optional)

After this, every merge to `main` deploys by itself once the tests pass
(`.github/workflows/ci.yml`, job `deploy`). It also applies any new D1
migrations first. Without the two secrets the job just skips.

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template
   **Edit Cloudflare Workers**. Add a permission row **Account · D1 · Edit**.
   Limit it to your account and to the `example.com` zone. Create, then copy the token.
2. Copy your **Account ID** (dashboard home → the account's menu → **Copy account ID**,
   or the right-hand column of any zone's Overview).
3. GitHub → the repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: the id from step 2

   Then the **Variables** tab → **New repository variable**:
   - `TLDR_DOMAIN`: your domain, e.g. `tldr.example.com` (required: the
     deploy stops with an error without it, and the live site keeps running)
   - `EDITION_TZ`: your time zone, e.g. `Europe/London` (optional, default `UTC`)
4. To deploy `main` without a new merge: **Actions → CI → Run workflow** (works
   from the GitHub app or mobile browser).

The secrets live only in GitHub; nothing is committed.

## 4. Add the secrets

```sh
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the AUD tag from step 1
npx wrangler secret put ALLOWED_EMAIL        # the same email as the Access policy
```

Until all three are set, every request gets an empty 403. That's intended.

## 5. Put tldr in the phone's share menu

1. On the Android phone, open `https://tldr.example.com` in **Chrome** and sign in through Access.
2. Chrome menu → **Add to Home screen → Install**.
3. Share any link from any app. **tl;dr** appears in the share sheet.
   Pick it; the page opens with a red **FILED** stamp and the link on the wire.

If tl;dr doesn't show in the share sheet, uninstall the app, reopen the site,
and install again (Android only registers share targets at install time).

## 6. Connect X (bookmark sync)

1. At [console.x.com](https://console.x.com), open your app (a new one, or one
   you already own; bookmark reads are only billed at the cheap owned-read
   price when the app belongs to the account whose bookmarks it reads).
2. **User authentication settings:** turn on OAuth 2.0, type **Web App**
   (a confidential client), and add the callback
   `https://tldr.example.com/auth/x/callback`. Use your own domain if it differs.
3. Copy the OAuth 2.0 **Client ID** and **Client Secret** (not the API key or
   bearer token) and add them:

   ```sh
   npx wrangler secret put X_CLIENT_ID
   npx wrangler secret put X_CLIENT_SECRET
   ```

4. Make sure the app has credits, and set a monthly **spending limit** (for
   example $5) in the console so a bug can never run up a bill.
5. Apply the new migration and deploy:

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

6. Open the site and tap **Connect X**. After X sends you back, tap
   **Sync now** for the first sync, which pulls your bookmark backlog
   (X returns roughly the newest 800). After that the cron syncs every 3 hours.

What it costs: X bills $0.001 per post returned and doesn't bill the same post
twice in one UTC day. The first sync costs about $1. After that each run reads
a page of 10 and stops when a page has nothing new, so expect a few cents a
month plus $0.001 per new bookmark. If the login ever expires, the X line on
the page says so with a **Reconnect** link.

## 7. Connect the editor (Claude, over MCP)

The daily triage runs as a Claude scheduled task on your own plan. Claude
reaches tldr through a remote MCP connector at `/mcp`.

**Why `/mcp` needs its own lock.** Claude's servers make the calls, and they
can't sign in to Cloudflare Access, so Access would block them. `/mcp` gets an
Access *bypass*, and the Worker checks a long random token instead. Without
the right token, `/mcp` answers an empty 404, and with no `MCP_TOKEN` secret
it stays shut. Every other path stays behind Access exactly as before.

1. **Make the token** (keep it like a password):

   ```sh
   openssl rand -hex 32
   npx wrangler secret put MCP_TOKEN    # paste the token
   ```

   On Windows without openssl, in PowerShell:
   `-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })`.

2. **Apply the migration and deploy:**

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

3. **Bypass Access for `/mcp` only.** Zero Trust → **Access → Applications →
   Add an application → Self-hosted**:
   - Name: `tldr MCP`.
   - Domain: `tldr.example.com`, path: `mcp`.
   - Policy: action **Bypass**, include **Everyone**.

   Access applies the most specific path, so only `/mcp` is affected. Check:
   `curl -i https://tldr.example.com/` still redirects to the Access login, and
   `curl -i -X POST https://tldr.example.com/mcp/wrong` answers `404` from the
   Worker (not an Access page).

4. **Load your profile** (me.md never goes into git; this reads it from your
   disk and stores it in D1 as a new version):

   ```sh
   npm run profile:load -- path/to/me.md
   ```

   Run it again whenever you edit me.md. The newest version wins.

5. **Add the connector in Claude.** Settings → **Connectors → Add custom
   connector**. Name: `tldr`. URL:
   `https://tldr.example.com/mcp/<your token>`. Leave the OAuth fields empty.
   Then set the tldr tools to **Always allow**, so the morning run never
   stops to ask.

6. **Create the scheduled task.** A daily task early each morning (say 6:40am your time), with
   the tldr connector on, using the prompt in `brain-prompt.md`.

7. **Try it once by hand:** paste the same prompt into a new chat. It should
   triage up to 100 saves in batches of 20 and publish a morning run.

Treat the connector URL as a secret: it holds the token. To rotate, put a new
`MCP_TOKEN` and edit the connector's URL. Claude Code and other clients that
can send headers can use `https://tldr.example.com/mcp` with
`Authorization: Bearer <token>` instead.

## 7b. Or: let the Worker be the editor (an AI key)

No Claude plan with scheduled tasks? The Worker can run the morning triage
itself with an API key. It follows the same brief as the scheduled task and
writes through the same checks; the profile still decides every verdict.

1. **Load your profile** as in section 7, step 4.
2. **Add one key**, whichever you have:

   | Provider | Secrets |
   |---|---|
   | Claude API | `ANTHROPIC_API_KEY` (model defaults to `claude-opus-5-5`; set `AI_MODEL` to change it) |
   | OpenRouter | `OPENROUTER_API_KEY` and `AI_MODEL`, e.g. the model's OpenRouter id |
   | Any OpenAI-compatible API | `LLM_API_KEY`, `LLM_BASE_URL` (https, ending before `/chat/completions`) and `AI_MODEL` |

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

   If more than one is set, the first row wins. Remove the key to turn the
   editor off.
3. **Pick the hour** (optional). The run starts on the first cron tick after
   6am in `EDITION_TZ`. Set the `EDITOR_HOUR` secret (0 to 23) to change it.
   The cron ticks every 3 hours, so the Desk is ready within 3 hours of it.

Each run triages up to 100 saves in batches of 20, then writes the lede and
picks the highlights: about six requests a day. If a run fails (a bad key, a
rate limit), it keeps what it saved, tries again on the next tick, and the
missed-run email tells you after 8am. `npx wrangler tail` shows the reason.

Don't use both modes at once: with a key set, the Worker publishes first and
the scheduled task's publish replaces it later that morning.

## 8. The morning email

tldr emails your Desk after each morning run, and warns you if the run
didn't happen by 8am. It sends through Cloudflare Email Service with the
unrestricted `send_email` binding, which only delivers to destination
addresses verified in your account, so it can only ever email you. Sending to
your own verified address is free on the Workers Free plan.

1. **Onboard the sender domain for sending.** Cloudflare dashboard →
   **Compute → Email Service → Email Sending → Onboard Domain**, pick your
   domain, and accept the records. They all sit on the `cf-bounce` subdomain
   (MX, SPF, DKIM) plus a `_dmarc` TXT, so mail already delivered to the root
   domain is untouched. If you already have a `_dmarc` record, keep yours.
   Wait for **Settings** to show the domain verified (usually minutes).
2. **Verify where it may send.** **Email Service → Email Routing →
   Destination addresses**: add your own email (the same one as
   `ALLOWED_EMAIL`) and click the link in the verification email. This needs
   Email Routing on the account; if the domain already receives mail
   somewhere else (Google Workspace, Zoho...), onboard Routing on a subdomain
   such as `mail.yourdomain` so the root's MX records stay as they are.
3. Set the sender, an address on the domain from step 1 (it needs no mailbox):

   ```sh
   npx wrangler secret put MAIL_FROM   # e.g. tldr@yourdomain
   ```

   `MAIL_TO` is optional and defaults to `ALLOWED_EMAIL`.
4. Set `SITE_URL` in `wrangler.toml` to your site, so the email links back.

Until `MAIL_FROM` is set, the email is off and nothing else changes. Each
morning run's reply includes `email: sent`, `off` or `failed: <why>`; a
failure also shows under the masthead on the Desk.

## 9. GitHub stars (optional)

Repos you star on GitHub become saves. The editor judges them by
description, language, topics and the start of the README.

```sh
npx wrangler secret put GITHUB_USER    # your GitHub username
npx wrangler secret put GITHUB_TOKEN   # optional
```

If your profile is public, so are your stars, and no token is needed
(GitHub allows 60 calls an hour, plenty for a sync every 3 hours). If your
profile is **private**, or you want a higher limit, make a
[fine-grained token](https://github.com/settings/personal-access-tokens/new)
with the account permission **Starring: read-only** and nothing else; GitHub
only shows a private profile's stars to that user. The first
sync takes stars from the last 30 days; after that, only new ones. Free.

## 10. YouTube

**The simple way (no setup):** in the YouTube app, tap **Share → tl;dr**
instead of Watch Later. tldr looks up the video's title and channel from
YouTube's free public embed endpoint (no key, no account), the same way it
fills in shared X posts.

**Optional: sync a playlist.** If you'd rather keep tapping **Save**,
YouTube's API can't read Watch Later, but it can read a playlist of your own.
It's free (a few of the 10,000 daily quota units, no billing account), and
takes ten minutes of Google Cloud setup:

1. Create a playlist, say "tldr", and set it to **Unlisted** (not Private:
   a Private playlist needs a Google sign-in, Unlisted needs only a key).
   Its id is the `list=` part of its link, starting `PL`.
2. In [Google Cloud console](https://console.cloud.google.com/), make a
   project, enable **YouTube Data API v3**, and create an **API key**.
   Restrict the key to that API.
3. Add both:

   ```sh
   npx wrangler secret put YOUTUBE_API_KEY
   npx wrangler secret put YOUTUBE_PLAYLIST_ID
   ```

Each sync reads the playlist and fetches title, channel, length and
description for new videos. That uses a few of the 10,000 free quota units a
day, so it costs nothing. Transcripts of other people's videos aren't in the
official API, so the editor works from the description. For your old Watch
Later list, move what you still want into the playlist once.

## Local development

```sh
cp .dev.vars.example .dev.vars   # lets localhost skip the Access check
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test
```

To try the MCP endpoint locally, add `MCP_TOKEN=<32+ characters>` to
`.dev.vars` and load a made-up profile with `npm run profile:load -- file.md --local`.

`ALLOW_LOCAL_DEV` only works for requests to `localhost`. Never set it as a
production secret.
