// Deploys with this copy's own domain and time zone, which live outside the
// repo: TLDR_DOMAIN (required, e.g. tldr.example.com) and EDITION_TZ (an IANA
// zone like Europe/London, default UTC). Works the same on Windows, macOS,
// Linux and in CI.
//   export TLDR_DOMAIN=tldr.example.com EDITION_TZ=Europe/London; npm run deploy
//   PowerShell: $env:TLDR_DOMAIN="tldr.example.com"; npm run deploy
import { spawnSync } from "node:child_process";

const domain = (process.env.TLDR_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
const tz = (process.env.EDITION_TZ || "").trim() || "UTC";

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error("Set TLDR_DOMAIN to your tldr domain first, e.g. tldr.example.com (docs/setup.md, step 3).");
  process.exit(1);
}
try {
  new Intl.DateTimeFormat("en", { timeZone: tz });
} catch {
  console.error(`EDITION_TZ "${tz}" isn't a time zone name. Use one like Europe/London or Asia/Kolkata.`);
  process.exit(1);
}

const args = ["wrangler", "deploy", "--domain", domain, "--var", `SITE_URL:https://${domain}`, "--var", `EDITION_TZ:${tz}`];
console.log(`Deploying to ${domain} (time zone ${tz})`);
const run = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(run.status ?? 1);
