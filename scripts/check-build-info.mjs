// Build-stamp contract test (task 01a09e63 stage 2).
//
// The installed plugin has no .git (install.sh / update.sh COPY src/*.ts into
// ~/.openclaw/extensions/startup-suite-channel), so the commit it reports as
// client_info.build comes from build-info.json, stamped at copy/build time by
// scripts/write-build-info.mjs. This checks:
//   (1) write-build-info.mjs stamps `git rev-parse HEAD` of this checkout
//       (+ `-dirty` iff tracked files differ), never the version;
//   (2) the real update.sh copy+stamp path, run into a scratch EXT_DIR via
//       SUITE_CHANNEL_EXT_DIR, leaves a build-info.json whose sha is this
//       checkout's HEAD, next to copied sources and no .git;
//   (3) a failed stamp REMOVES a stale build-info.json instead of leaving an
//       old sha in place, and exits non-zero.
// `npm install` inside update.sh is replaced by a no-op `npm` on PATH, so
// this runs offline and never touches the live ~/.openclaw.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const head = git(repoRoot, "rev-parse", "HEAD");
const dirty = git(repoRoot, "status", "--porcelain", "--untracked-files=no").length > 0;
const expected = dirty ? `${head}-dirty` : head;
const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

const scratch = mkdtempSync(path.join(tmpdir(), "suite-channel-build-info-"));
try {
  // (1) direct stamp
  const out1 = path.join(scratch, "direct");
  execFileSync(process.execPath, [path.join(repoRoot, "scripts", "write-build-info.mjs"), out1], { stdio: "pipe" });
  const info1 = JSON.parse(readFileSync(path.join(out1, "build-info.json"), "utf8"));
  assert.equal(info1.sha, expected, `stamped sha ${info1.sha} != git HEAD ${expected}`);
  assert.notEqual(info1.sha, version, "the stamp must never be the package.json version");
  assert.ok(!Number.isNaN(Date.parse(info1.generated_at)), "generated_at should be ISO-8601");

  // (2) install path: real update.sh into a scratch EXT_DIR, npm stubbed out
  const extDir = path.join(scratch, "ext");
  mkdirSync(extDir, { recursive: true }); // update.sh requires an existing install
  writeFileSync(path.join(extDir, "build-info.json"), JSON.stringify({ sha: "0".repeat(40) })); // stale
  const bin = path.join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "npm"), 0o755);
  const upd = spawnSync("bash", [path.join(repoRoot, "update.sh")], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, SUITE_CHANNEL_EXT_DIR: extDir, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(upd.status, 0, `update.sh failed: ${upd.stderr}`);
  assert.ok(existsSync(path.join(extDir, "src", "suite-client.ts")), "update.sh should have copied src/");
  assert.ok(existsSync(path.join(extDir, "src", "build-identity.ts")), "update.sh should have copied build-identity.ts");
  assert.ok(!existsSync(path.join(extDir, ".git")), "the installed copy has no .git");
  const info2 = JSON.parse(readFileSync(path.join(extDir, "build-info.json"), "utf8"));
  assert.equal(info2.sha, expected, `installed stamp ${info2.sha} != source checkout HEAD ${expected}`);

  // (3) a stamp that cannot resolve a sha removes the stale file, exits non-zero
  const orphan = path.join(scratch, "orphan");
  mkdirSync(path.join(orphan, "scripts"), { recursive: true });
  cpSync(path.join(repoRoot, "scripts", "write-build-info.mjs"), path.join(orphan, "scripts", "write-build-info.mjs"));
  const target3 = path.join(scratch, "stale");
  mkdirSync(target3);
  writeFileSync(path.join(target3, "build-info.json"), JSON.stringify({ sha: "1".repeat(40) }));
  const r3 = spawnSync(process.execPath, [path.join(orphan, "scripts", "write-build-info.mjs"), target3], {
    encoding: "utf8",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
  });
  assert.notEqual(r3.status, 0, "stamping from a non-git copy must exit non-zero");
  assert.match(r3.stderr, /not a git checkout|not the root of its git checkout/, `unclear failure message: ${r3.stderr}`);
  assert.ok(!existsSync(path.join(target3, "build-info.json")), "a failed stamp must remove the stale build-info.json");

  console.log(`Build info OK: stamp == git HEAD (${expected}), update.sh into scratch EXT_DIR stamped the same sha over a stale one, failed stamp removed the stale file`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
