// Builds the public demo: the real pages, rendered by the real Worker, over
// the made-up data in demo/seed.sql. Output: _site/ (static HTML for GitHub
// Pages). Nothing here touches a deployed instance or real data: it runs
// `wrangler dev` against a throwaway local database in .demo-state/.
//   npm run demo:build
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const STATE = ".demo-state";
const OUT = "_site";
const PORT = 8790;
const PAGES = { "/": "index.html", "/reading": "reading.html", "/morgue": "morgue.html", "/file": "file.html" };
const shell = process.platform === "win32";

function npx(args) {
  const run = spawnSync("npx", args, { stdio: "inherit", shell });
  if (run.status !== 0) throw new Error(`npx ${args.join(" ")} failed`);
}

rmSync(STATE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
npx(["wrangler", "d1", "migrations", "apply", "tldr", "--local", "--persist-to", STATE]);
npx(["wrangler", "d1", "execute", "tldr", "--local", "--persist-to", STATE, "--file", "demo/seed.sql"]);

// Run wrangler's own entry point, not npx, so stopping it stops the server.
const dev = spawn(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--persist-to", STATE, "--port", String(PORT), "--test-scheduled=false",
   "--var", "ALLOW_LOCAL_DEV:true", "--var", "X_CLIENT_ID:demo", "--var", "EDITION_TZ:UTC"],
  { stdio: ["ignore", "inherit", "inherit"] },
);

try {
  const base = `http://localhost:${PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + "/")).ok) break;
    } catch {}
    if (i > 60) throw new Error("wrangler dev didn't start");
    await new Promise((r) => setTimeout(r, 1000));
  }
  mkdirSync(OUT, { recursive: true });
  for (const [path, file] of Object.entries(PAGES)) {
    const res = await fetch(base + path);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    writeFileSync(`${OUT}/${file}`, staticPage(await res.text()));
  }
  for (const f of readdirSync("public")) if (f !== "sw.js" && f !== "manifest.webmanifest") cpSync(`public/${f}`, `${OUT}/${f}`);
  writeFileSync(`${OUT}/.nojekyll`, "");
  console.log(`Demo written to ${OUT}/`);
  setTimeout(() => process.exit(0), 500).unref();
} finally {
  dev.kill();
}

/** Makes a page work as a static file: relative links, no forms, a demo note. */
function staticPage(html) {
  let out = html;
  for (const [path, file] of Object.entries(PAGES)) {
    out = out.replaceAll(`href="${path}"`, `href="${file}"`).replaceAll(`href="${path}?`, `href="${file}?`);
  }
  out = out
    .replace(/(href|src)="\/(?!\/)([^"]*)"/g, '$1="$2"') // assets: /style.css -> style.css
    .replace(/<link rel="manifest"[^>]*>/g, "")
    .replace(/<script[^>]*src="[^"]*app\.js"[^>]*><\/script>/g, "")
    .replace(/action="[^"]*"/g, 'action="#" onsubmit="return false"')
    .replace(
      /<body([^>]*)>/,
      `<body$1>\n<p class="demo-note" style="margin:0;padding:8px 16px;font:14px/1.4 'IBM Plex Sans',sans-serif;background:#1a1a1a;color:#f3efe6;text-align:center">Demo with made-up data. Buttons don't save here. <a style="color:inherit" href="https://github.com/khubli/tldr">Run your own</a></p>`,
    );
  return out;
}
