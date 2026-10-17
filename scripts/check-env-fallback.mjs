// Env-name fallback check (task 01a14b9f stage 3, Burrow rename C).
//
// The installer scripts read BURROW_<X> first and the deprecated SUITE_<X>
// second, warning once on stderr when the old spelling is used. This runs the
// REAL install.sh / update.sh / test-connection.* into scratch dirs:
//   (a) only SUITE_ overrides: files land at the SUITE_ paths, one
//       deprecation line per name used;
//   (b) only BURROW_ overrides: files land at the BURROW_ paths, no warning;
//   (c) both set, differing: the BURROW_ paths receive the files, the SUITE_
//       paths stay empty, no warning;
//   (d) neither: the defaults under $HOME/.openclaw (HOME is scratch);
//   (e) BURROW_ACCOUNT_ID / SUITE_ACCOUNT_ID in test-connection.sh and .js;
// plus a guard pinning BURROW_ENV_FALLBACKS in scripts/env-fallbacks.sh to a
// RAW literal list (never derived from the file it checks).
//
// `npm install` is a no-op `npm` on PATH, so this runs offline. HOME is a
// scratch dir in every run, so even a missing override cannot reach a live
// ~/.openclaw. Scratch dirs go under $CHECK_SCRATCH_ROOT (default: OS temp).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const fallbacksFile = path.join(repoRoot, "scripts", "env-fallbacks.sh");

// ── Guard: the fallback list, as a raw literal ─────────────────────
// Edit this list by hand when a pair is added. Deriving it from
// env-fallbacks.sh would make the guard agree with whatever the file says.
const EXPECTED_FALLBACKS = [
  ["BURROW_CHANNEL_EXT_DIR", "SUITE_CHANNEL_EXT_DIR"],
  ["BURROW_CHANNEL_OC_CONFIG", "SUITE_CHANNEL_OC_CONFIG"],
  ["BURROW_ACCOUNT_ID", "SUITE_ACCOUNT_ID"],
];

const src = readFileSync(fallbacksFile, "utf8");
const m = src.match(/^BURROW_ENV_FALLBACKS="([^"]*)"$/m);
assert.ok(m, "scripts/env-fallbacks.sh must define BURROW_ENV_FALLBACKS=\"...\" on one line");
const actualFallbacks = m[1].trim().split(/\s+/).map((pair) => pair.split(":"));
assert.deepEqual(actualFallbacks, EXPECTED_FALLBACKS, "BURROW_ENV_FALLBACKS drifted from the pinned list");
for (const [neu, old] of actualFallbacks) {
  assert.equal(old, neu.replace(/^BURROW_/, "SUITE_"), `${neu}: the old name must be a pure prefix swap`);
}

// No script reads a SUITE_ name except through the list. Comments and the
// list file itself are exempt; test-connection.js cannot source the shell
// helper, so its one pair must be a listed one.
const stripComments = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
for (const rel of ["install.sh", "update.sh", "uninstall.sh", "scripts/test-connection.sh"]) {
  const body = stripComments(readFileSync(path.join(repoRoot, rel), "utf8"));
  assert.deepEqual(body.match(/\bSUITE_[A-Z_]+/g) ?? [], [], `${rel} reads a SUITE_ name directly; use burrow_env`);
}
const jsNames = [...new Set(readFileSync(path.join(repoRoot, "scripts", "test-connection.js"), "utf8").match(/\b(?:BURROW|SUITE)_[A-Z_]+/g))].sort();
assert.deepEqual(jsNames, ["BURROW_ACCOUNT_ID", "SUITE_ACCOUNT_ID"], "test-connection.js env names must be exactly the listed account pair");

// ── Rig ────────────────────────────────────────────────────────────
const scratchRoot = process.env.CHECK_SCRATCH_ROOT || tmpdir();
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "env-fallback-"));

const bin = path.join(scratch, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(bin, "npm"), 0o755);

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(BURROW_|SUITE_|__BURROW_WARNED_)/.test(k)),
);

let caseNo = 0;
function freshCase(label) {
  const dir = path.join(scratch, `${++caseNo}-${label}`);
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

function run(script, args, { home, env = {}, input = "n\n" }) {
  const r = spawnSync("bash", [path.join(repoRoot, script), ...args], {
    cwd: path.dirname(home),
    encoding: "utf8",
    input,
    env: { ...baseEnv, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  return r;
}

const deprecationLines = (stderr) => stderr.split("\n").filter((l) => l.includes("is deprecated; set BURROW_"));
const installArgs = ["--url", "wss://core.example.test/runtime/ws", "--runtime-id", "rt-env-check", "--token", "env-check-literal", "--account-id", "beacon"];

function assertInstalled(extDir, ocPath, label) {
  for (const f of ["package.json", "openclaw.plugin.json", "index.ts", "src/channel.ts", "build-info.json"]) {
    assert.ok(existsSync(path.join(extDir, f)), `${label}: ${f} missing from ${extDir}`);
  }
  if (ocPath) {
    const cfg = JSON.parse(readFileSync(ocPath, "utf8"));
    assert.equal(cfg.channels["startup-suite"].accounts.beacon.runtimeId, "rt-env-check", `${label}: account not written to ${ocPath}`);
  }
}
const isAbsentOrEmpty = (p) => !existsSync(p) || readdirSync(p).length === 0;
const results = [];

try {
  // (a) SUITE_ only
  {
    const { dir, home } = freshCase("suite-only");
    const ext = path.join(dir, "ext"), oc = path.join(dir, "openclaw.json");
    const env = { SUITE_CHANNEL_EXT_DIR: ext, SUITE_CHANNEL_OC_CONFIG: oc };
    const ins = run("install.sh", installArgs, { home, env });
    assert.equal(ins.status, 0, `(a) install.sh failed: ${ins.stderr}`);
    assertInstalled(ext, oc, "(a) install");
    assert.deepEqual(deprecationLines(ins.stderr), [
      "[burrow-channel-openclaw] SUITE_CHANNEL_EXT_DIR is deprecated; set BURROW_CHANNEL_EXT_DIR",
      "[burrow-channel-openclaw] SUITE_CHANNEL_OC_CONFIG is deprecated; set BURROW_CHANNEL_OC_CONFIG",
    ], `(a) install: one line per used name: ${ins.stderr}`);
    assert.equal(ins.stdout.includes("is deprecated"), false, "(a) the warning goes to stderr, not stdout");
    assert.ok(!existsSync(path.join(home, ".openclaw")), "(a) the default ~/.openclaw path must not be touched");
    const upd = run("update.sh", [], { home, env: { SUITE_CHANNEL_EXT_DIR: ext } });
    assert.equal(upd.status, 0, `(a) update.sh failed: ${upd.stderr}`);
    assert.deepEqual(deprecationLines(upd.stderr), [
      "[burrow-channel-openclaw] SUITE_CHANNEL_EXT_DIR is deprecated; set BURROW_CHANNEL_EXT_DIR",
    ], `(a) update: one line: ${upd.stderr}`);
    results.push("(a) SUITE_-only ok");
  }

  // (b) BURROW_ only
  {
    const { dir, home } = freshCase("burrow-only");
    const ext = path.join(dir, "ext"), oc = path.join(dir, "openclaw.json");
    const env = { BURROW_CHANNEL_EXT_DIR: ext, BURROW_CHANNEL_OC_CONFIG: oc };
    const ins = run("install.sh", installArgs, { home, env });
    assert.equal(ins.status, 0, `(b) install.sh failed: ${ins.stderr}`);
    assertInstalled(ext, oc, "(b) install");
    assert.deepEqual(deprecationLines(ins.stderr), [], `(b) no warning: ${ins.stderr}`);
    assert.ok(!existsSync(path.join(home, ".openclaw")), "(b) the default ~/.openclaw path must not be touched");
    const upd = run("update.sh", [], { home, env: { BURROW_CHANNEL_EXT_DIR: ext } });
    assert.equal(upd.status, 0, `(b) update.sh failed: ${upd.stderr}`);
    assert.deepEqual(deprecationLines(upd.stderr), [], `(b) update: no warning: ${upd.stderr}`);
    results.push("(b) BURROW_-only ok");
  }

  // (c) both set, differing: BURROW_ wins, SUITE_ paths stay empty
  {
    const { dir, home } = freshCase("both");
    const extB = path.join(dir, "ext-burrow"), ocB = path.join(dir, "oc-burrow.json");
    const extS = path.join(dir, "ext-suite"), ocS = path.join(dir, "oc-suite.json");
    const env = { BURROW_CHANNEL_EXT_DIR: extB, BURROW_CHANNEL_OC_CONFIG: ocB, SUITE_CHANNEL_EXT_DIR: extS, SUITE_CHANNEL_OC_CONFIG: ocS };
    const ins = run("install.sh", installArgs, { home, env });
    assert.equal(ins.status, 0, `(c) install.sh failed: ${ins.stderr}`);
    assertInstalled(extB, ocB, "(c) install");
    assert.ok(!existsSync(extS), "(c) the SUITE_ ext dir must not be created");
    assert.ok(!existsSync(ocS), "(c) the SUITE_ openclaw.json must not be written");
    assert.deepEqual(deprecationLines(ins.stderr), [], `(c) no warning when BURROW_ is set: ${ins.stderr}`);
    mkdirSync(extS); // update.sh refuses a missing dir; an existing empty one must stay empty
    const upd = run("update.sh", [], { home, env: { BURROW_CHANNEL_EXT_DIR: extB, SUITE_CHANNEL_EXT_DIR: extS } });
    assert.equal(upd.status, 0, `(c) update.sh failed: ${upd.stderr}`);
    assert.ok(isAbsentOrEmpty(extS), "(c) update.sh must not write into the SUITE_ ext dir");
    assert.deepEqual(deprecationLines(upd.stderr), [], `(c) update: no warning: ${upd.stderr}`);
    results.push("(c) both-set: BURROW_ wins, SUITE_ paths empty");
  }

  // (d) neither: defaults under the (scratch) HOME
  {
    const { home } = freshCase("defaults");
    const ins = run("install.sh", installArgs, { home });
    assert.equal(ins.status, 0, `(d) install.sh failed: ${ins.stderr}`);
    assertInstalled(path.join(home, ".openclaw", "extensions", "startup-suite-channel"), path.join(home, ".openclaw", "openclaw.json"), "(d) install");
    assert.deepEqual(deprecationLines(ins.stderr), [], `(d) no warning: ${ins.stderr}`);
    results.push("(d) defaults unchanged");
  }

  // (e) the account id pair, in the shell wrapper and the js it runs
  {
    const { home } = freshCase("account-id");
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    const account = (id) => ({ url: "ws://127.0.0.1:1/runtime/ws", runtimeId: `rt-${id}`, token: "unused" });
    writeFileSync(
      path.join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({ channels: { "startup-suite": { accounts: { old: account("old"), neu: account("neu"), arg: account("arg") } } } }),
    );
    const tc = (env, args = [], viaJs = false) => {
      const r = viaJs
        ? spawnSync(process.execPath, [path.join(repoRoot, "scripts", "test-connection.js"), ...args], { encoding: "utf8", env: { ...baseEnv, HOME: home, ...env }, timeout: 20000 })
        : run("scripts/test-connection.sh", args, { home, env, input: "" });
      const used = r.stdout.match(/\(account: ([a-z]+)\)/)?.[1] ?? null;
      return { used, warns: deprecationLines(r.stderr), r };
    };
    for (const viaJs of [false, true]) {
      const tag = viaJs ? "test-connection.js" : "test-connection.sh";
      let t = tc({ SUITE_ACCOUNT_ID: "old" }, [], viaJs);
      assert.equal(t.used, "old", `(e) ${tag} SUITE_ only: ${t.r.stdout}${t.r.stderr}`);
      assert.deepEqual(t.warns, ["[burrow-channel-openclaw] SUITE_ACCOUNT_ID is deprecated; set BURROW_ACCOUNT_ID"], `(e) ${tag}: exactly one warning`);
      t = tc({ BURROW_ACCOUNT_ID: "neu" }, [], viaJs);
      assert.equal(t.used, "neu", `(e) ${tag} BURROW_ only`);
      assert.deepEqual(t.warns, [], `(e) ${tag} BURROW_ only: no warning`);
      t = tc({ BURROW_ACCOUNT_ID: "neu", SUITE_ACCOUNT_ID: "old" }, [], viaJs);
      assert.equal(t.used, "neu", `(e) ${tag} both: BURROW_ wins`);
      assert.deepEqual(t.warns, [], `(e) ${tag} both: no warning`);
      t = tc({ BURROW_ACCOUNT_ID: "neu", SUITE_ACCOUNT_ID: "old" }, ["arg"], viaJs);
      assert.equal(t.used, "arg", `(e) ${tag}: an explicit argument still wins over both`);
    }
    results.push("(e) account id pair ok in .sh and .js");
  }

  // (f) a name missing from the list is a hard error, not a silent ""
  {
    const r = spawnSync("bash", ["-c", `set -euo pipefail; . "${fallbacksFile}"; burrow_env BURROW_NOT_LISTED; echo reached`], { encoding: "utf8", env: baseEnv });
    assert.equal(r.status, 70, `(f) unlisted name must exit 70, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.includes("reached"), false, "(f) the caller must not continue");
    results.push("(f) unlisted name exits 70");
  }

  console.log(`Env fallback OK: list pinned (${EXPECTED_FALLBACKS.length} pairs); ${results.join("; ")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
