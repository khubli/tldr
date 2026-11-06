# Security

## Reporting a problem

Please report vulnerabilities privately through GitHub: the repository's
**Security** tab → **Report a vulnerability**. Don't open a public issue.
You will get a reply as soon as possible.

## How tldr keeps data private

- Each copy runs in its owner's own Cloudflare account. There is no shared
  server and no telemetry.
- Every request must carry a Cloudflare Access login for the one allowed
  email, and the Worker verifies that login's signature itself. If anything
  is missing or wrong, it returns an empty 403. `workers.dev` and preview
  URLs are disabled.
- The MCP endpoint (`/mcp`) bypasses Access so Claude's servers can reach
  it, and checks a long random token instead (compared in constant time). It
  rejects browser requests from other origins.
- Secrets live in Cloudflare (or GitHub Actions for deploys), never in git.
- Text inside saves is treated as material to judge, never as instructions.
  In mode B the Worker only writes verdicts for the saves it asked about.

## What leaves your account

Reads from X, GitHub and YouTube; your profile and saves to the editor you
chose (your Claude account, or the AI provider whose key you set); and the
morning email, which can only go to an address you verified in Cloudflare.

## Supported versions

The latest release on `main` (the `v1` branch tracks it).
