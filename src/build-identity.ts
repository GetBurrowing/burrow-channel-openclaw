// What code is this process running, and since when?
//
// Both values are resolved ONCE, when this module is first loaded, and never
// again - so a reconnect re-sends the identity of the code that is resident,
// never whatever has since been copied over it, and never anything derived
// from the connection.
//
// ── BUILD ───────────────────────────────────────────────────────────────────
//
// OpenClaw installs this plugin by COPYING files (install.sh / update.sh copy
// src/*.ts into ~/.openclaw/extensions/burrow-channel-plugin) and npm ships a
// tarball; neither carries a .git, so `git rev-parse` cannot work at runtime.
// Instead scripts/write-build-info.mjs stamps `build-info.json`
// (`{ sha, generated_at }`) next to the code at copy/build time, and this
// module reads it at load. The file sits in the plugin root: `..` from src/
// (the copy-install and dev layouts) or `../..` from dist/src/ (compiled).
// A candidate directory only counts if it also holds THIS plugin's
// package.json, so a stray build-info.json in some parent directory is never
// mistaken for ours.
//
// No stamp, or a stamp without a valid sha, means BUILD is null and
// BUILD_ERROR says why. Never a guess, and never package.json's version:
// commit 7288017 shipped a fix without a version bump, so the version
// discriminates nothing.
//
// ── PROCESS_STARTED_AT ──────────────────────────────────────────────────────
//
// When the process that loaded this code (the OpenClaw gateway) started,
// from `performance.timeOrigin` - never a connection time. A reader can then
// tell a reconnect (connected_at moves, started_at does not) from a restart
// (both move).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "burrow-channel-plugin";
const SHA_PATTERN = /^[0-9a-f]{40}(-dirty)?$/;
const MAX_BUILD_BYTES = 64;

type Resolution = { build: string; error: null } | { build: null; error: string };

function isPluginRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Resolve the build from the build-info.json in the plugin root above `moduleDir`. */
export function resolveBuild(moduleDir: string): Resolution {
  const candidates = [join(moduleDir, ".."), join(moduleDir, "..", "..")];
  const root = candidates.find(isPluginRoot);
  if (!root) return { build: null, error: `plugin root (${PACKAGE_NAME} package.json) not found above ${moduleDir}` };

  const file = join(root, "build-info.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { build: null, error: `build-info.json missing at ${root}`.slice(0, 200) };
  }

  let sha: unknown;
  try {
    sha = (JSON.parse(raw) as { sha?: unknown })?.sha;
  } catch {
    return { build: null, error: "build-info.json unparseable" };
  }

  if (typeof sha !== "string" || Buffer.byteLength(sha) > MAX_BUILD_BYTES || !SHA_PATTERN.test(sha)) {
    return { build: null, error: "build-info.json has no valid sha" };
  }
  return { build: sha, error: null };
}

function resolveProcessStartedAt(): string {
  const origin = performance.timeOrigin;
  if (Number.isFinite(origin) && origin > 0) return new Date(origin).toISOString();
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

const resolved = resolveBuild(dirname(fileURLToPath(import.meta.url)));

/** Commit the loaded code was copied/built from (`<40-hex>[-dirty]`); null if unknown. */
export const BUILD: string | null = resolved.build;

/** Why `BUILD` is null; null whenever `BUILD` is set. */
export const BUILD_ERROR: string | null = resolved.error;

/** ISO-8601 start time of the process that loaded this code. Never a connection time. */
export const PROCESS_STARTED_AT: string = resolveProcessStartedAt();
