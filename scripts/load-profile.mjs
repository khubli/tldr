#!/usr/bin/env node
// Loads your profile (me.md) into the deployed database as a new version.
// The file never enters git; this only reads it from your disk.
//
//   npm run profile:load -- path/to/me.md            # deployed database
//   npm run profile:load -- path/to/me.md --local    # local dev database

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const where = args.includes("--local") ? "--local" : "--remote";
if (!file) {
  console.error("Usage: npm run profile:load -- path/to/me.md [--local]");
  process.exit(1);
}

const markdown = readFileSync(file, "utf8").replace(/\u0000/g, "").trim();
if (!markdown) {
  console.error(`${file} is empty.`);
  process.exit(1);
}

const quote = (s) => `'${s.replace(/'/g, "''")}'`;
const sql = `INSERT INTO profile (markdown, updated_at) VALUES (${quote(markdown)}, ${quote(new Date().toISOString())});\n`;

const dir = mkdtempSync(join(tmpdir(), "tldr-profile-"));
const sqlFile = join(dir, "profile.sql");
try {
  writeFileSync(sqlFile, sql, "utf8");
  const run = spawnSync("npx", ["wrangler", "d1", "execute", "tldr", where, "--file", sqlFile, "--yes"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  // Set the exit code instead of exiting here, so the temp file is always removed.
  if (run.status !== 0) process.exitCode = run.status ?? 1;
  else console.log(`Profile loaded (${markdown.length} characters).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
