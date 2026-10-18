// Product-name guard for the Burrow rename (task 01a14ccb, stage 1).
//
// TEMPORARY. This is a rename guard, not a permanent lint. Delete this file and
// its `test:product-name` entry in package.json once Burrow release task E
// (01a14ba0) has finished. About eight copies of it exist across the plugin,
// desktop and ops repos; none of them should outlive the rename.
//
// What it checks: no file in the working tree names the product by its old
// name. Per line, in this order:
//   1. strip every `Startup-<old>` org/owner literal and the
//      `ghcr.io/startup-<old>` registry path (the org is renamed later, by
//      release task E; '-' is a word boundary, so step 3 would match inside it);
//   2. remove that path's allowlisted substrings (ALLOWLIST below);
//   3. fail on the old bare word (case-sensitive, whole word), on the old
//      two-word name (any case), and on the two forbidden blends of old and new.
//
// The old name is spelled with \u0053 escapes throughout this file so that the
// guard does not match its own source. Lowercase identifiers (suite_* tool
// names, the `startup-suite` channel id, file names) never match step 3.
//
// Files are enumerated by walking the tree, not with `git ls-files`, so an
// untracked or generated file is checked too. Excluded: .git, node_modules,
// dist, package-lock.json, and any file that is not valid UTF-8.

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const OLD = "\u0053uite";
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist"]);
const EXCLUDED_FILES = new Set(["package-lock.json"]);

// Measured 2026-10-18 at ad30741: 59 files on a clean checkout (no
// node_modules, dist or generated files). An empty or truncated walk must fail,
// not pass, so the floor sits a small margin below that.
const MIN_FILES_SCANNED = 55;

const STRIP = [new RegExp(`Startup-${OLD}`, "g"), /ghcr\.io\/startup-suite/gi];

const FORBIDDEN = [
  { name: `bare "${OLD}"`, re: new RegExp(`\\b${OLD}\\b`) },
  { name: `"Startup ${OLD}"`, re: new RegExp(`startup ${OLD}`, "i") },
  { name: '"Startup\u0020Burrow"', re: /Startup\u0020Burrow/ },
  { name: `"Burrow ${OLD}"`, re: new RegExp(`Burrow ${OLD}`) },
];

// Explicit literal list. Every entry must match at least one line of its file,
// or the guard fails with "stale allowlist entry".
const ALLOWLIST = [
  {
    path: "LICENSE",
    substring: "Copyright (c) 2026 Startup \u0053uite",
    reason: "copyright holder line; legal text changes only with the release task",
  },
  {
    path: "CHANGELOG.md",
    substring: "Startup \u0053uite is now Burrow.",
    reason: "v0.8.0 history entry announcing the rename",
  },
  {
    path: "CHANGELOG.md",
    substring: "against older \u0053uite servers",
    reason: "v0.7.0 history entry, written before the rename",
  },
  {
    path: "README.md",
    substring: "Burrow is the new name of Startup \u0053uite.",
    reason: "rename notice for readers who know the old name",
  },
  {
    path: "CLAUDE.md",
    substring: "(formerly Startup \u0053uite)",
    reason: "rename notice for agents who know the old name",
  },
  {
    path: "scripts/fixtures/system-event-architecture-review-plan.json",
    substring: '"author": "Startup \u0053uite"',
    reason: "verbatim capture of a core push (scripts/fixtures/README.md); stays byte-identical",
  },
  {
    path: "scripts/fixtures/system-event-architecture-review-plan.json",
    substring: "the Architect on the \u0053uite plan-review path",
    reason: "verbatim capture of a core push (scripts/fixtures/README.md); stays byte-identical",
  },
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const files = walk(repoRoot, []).sort();
const violations = [];
const allowHits = new Map(ALLOWLIST.map((entry) => [entry, 0]));
let scanned = 0;

for (const file of files) {
  let text;
  try {
    text = decoder.decode(fs.readFileSync(file));
  } catch {
    continue; // not UTF-8
  }
  scanned++;
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const entries = ALLOWLIST.filter((entry) => entry.path === rel);
  text.split("\n").forEach((rawLine, index) => {
    let line = rawLine;
    for (const re of STRIP) line = line.replace(re, "");
    for (const entry of entries) {
      if (line.includes(entry.substring)) {
        allowHits.set(entry, allowHits.get(entry) + 1);
        line = line.split(entry.substring).join("");
      }
    }
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) {
        violations.push(`${rel}:${index + 1}: [${rule.name}] ${rawLine.trim()}`);
        break;
      }
    }
  });
}

const stale = ALLOWLIST.filter((entry) => allowHits.get(entry) === 0);
let failed = false;

if (scanned < MIN_FILES_SCANNED) {
  console.error(`Product-name guard scanned ${scanned} files, fewer than the floor of ${MIN_FILES_SCANNED}. The walk is broken.`);
  failed = true;
}
if (violations.length) {
  console.error(`Product-name guard: ${violations.length} line(s) still use the old product name:`);
  for (const v of violations) console.error(`  ${v}`);
  failed = true;
}
if (stale.length) {
  for (const entry of stale) {
    console.error(`  stale allowlist entry: ${entry.path}: ${JSON.stringify(entry.substring)} (${entry.reason})`);
  }
  failed = true;
}
if (failed) process.exit(1);

console.log(
  `Product-name guard OK: ${scanned} files scanned, 0 violations, ${ALLOWLIST.length} allowlist entries all live.`,
);
