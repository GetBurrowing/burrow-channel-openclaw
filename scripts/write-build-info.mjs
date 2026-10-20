#!/usr/bin/env node
// Stamp the commit of THIS checkout next to a copy of its code.
//
// Usage: node scripts/write-build-info.mjs <target-dir>
//
// Writes <target-dir>/build-info.json:
//   { "sha": "<git rev-parse HEAD>[-dirty]", "generated_at": "<ISO-8601>" }
//
// The sha is that of the checkout this script lives in (the source being
// copied or built), NOT of process.cwd() and not of <target-dir>. `-dirty` is
// appended when tracked files differ from HEAD, because then the sha does not
// name the code that was copied.
//
// Why a stamp at all: OpenClaw installs by COPYING src/*.ts into
// ~/.openclaw/extensions/burrow-channel-plugin (install.sh / update.sh), and
// npm ships a tarball; neither has a .git, so the plugin cannot ask git at
// runtime. src/build-identity.ts reads this file once at module load and
// sends the sha as client_info.build.
//
// On failure it REMOVES any existing <target-dir>/build-info.json and exits
// non-zero: a stale stamp from an earlier install would name code that is no
// longer there, and the plugin reports build_error for a missing stamp. It
// never writes a guessed value (and never the package.json version).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

if (!target) {
  console.error("usage: node scripts/write-build-info.mjs <target-dir>");
  process.exit(2);
}

const outFile = path.join(path.resolve(target), "build-info.json");

function fail(reason) {
  try {
    rmSync(outFile, { force: true });
  } catch {}
  console.error(`write-build-info: ${reason}; no build-info.json written to ${path.dirname(outFile)}`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let toplevel;
try {
  toplevel = git(["rev-parse", "--show-toplevel"]);
} catch (err) {
  fail(`${sourceRoot} is not a git checkout (${String(err.stderr || err.message).trim().split("\n")[0]})`);
}

// A copy of this repo vendored inside ANOTHER repo would otherwise stamp the
// enclosing repo's sha, which names none of this plugin's code.
if (realpathSync(toplevel) !== realpathSync(sourceRoot)) {
  fail(`${sourceRoot} is not the root of its git checkout (toplevel is ${toplevel})`);
}

let sha;
let dirty;
try {
  sha = git(["rev-parse", "HEAD"]);
  dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
} catch (err) {
  fail(`git failed in ${sourceRoot} (${String(err.stderr || err.message).trim().split("\n")[0]})`);
}

if (!/^[0-9a-f]{40}$/.test(sha)) fail(`git rev-parse HEAD returned ${JSON.stringify(sha)}, not a sha`);

const info = { sha: dirty ? `${sha}-dirty` : sha, generated_at: new Date().toISOString() };

if (!existsSync(path.dirname(outFile))) mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(info, null, 2) + "\n");
console.log(`write-build-info: ${info.sha} -> ${outFile}`);
