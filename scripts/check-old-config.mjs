// Old-config upgrade check (task 01a14b9f stage 3, Burrow rename C).
//
// Claim under test: a host installed with v0.7.0 (b220c8b1), whose
// openclaw.json and config.json are left UNTOUCHED, upgraded by running this
// checkout's update.sh with no new env var, still loads and connects.
//
// scripts/fixtures/openclaw-v0.7.0.json and config-v0.7.0.json are not
// hand-written: they are the files v0.7.0's own install.sh wrote into a
// scratch dir (three named accounts beacon/builder/pixel, then the
// single-agent default), with placeholder runtime ids and literal tokens.
//
// What it checks, on a scratch HOME with update.sh's `npm install` stubbed:
//   1. update.sh exits 0 into the default extension dir, prints no
//      deprecation line (no SUITE_ name was used), and leaves openclaw.json
//      and config.json byte-equal;
//   2. the untouched channel section validates against the NEW manifest's
//      configSchema and channelConfigs schema, with the ajv options OpenClaw
//      itself uses; a positive control shows the same validator rejects an
//      account missing runtimeId;
//   3. every id the old config names (plugins.allow / entries, bindings'
//      match.channel, the channels key) is still the id the new manifest,
//      package.json and plugin entry declare;
//   4. the INSTALLED copy's own sources resolve every account to the same
//      url / runtime id / token, and a SuiteClient built from each dials that
//      url and joins `runtime:<runtimeId>` with client_info.product openclaw.
//
// Scratch dirs go under $CHECK_SCRATCH_ROOT (default: the OS temp dir). The
// live ~/.openclaw is never read or written: HOME is the scratch dir.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const fixtures = path.join(repoRoot, "scripts", "fixtures");
const ocFixture = path.join(fixtures, "openclaw-v0.7.0.json");
const legacyFixture = path.join(fixtures, "config-v0.7.0.json");

const scratchRoot = process.env.CHECK_SCRATCH_ROOT || tmpdir();
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "old-config-"));

// An env with no BURROW_/SUITE_ name at all: the untouched host.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(BURROW_|SUITE_|__BURROW_WARNED_)/.test(k)),
);

try {
  const home = path.join(scratch, "home");
  const ocDir = path.join(home, ".openclaw");
  const extDir = path.join(ocDir, "extensions", "startup-suite-channel");
  const ocPath = path.join(ocDir, "openclaw.json");
  mkdirSync(extDir, { recursive: true });
  cpSync(ocFixture, ocPath);
  cpSync(legacyFixture, path.join(extDir, "config.json"));
  const ocBefore = readFileSync(ocPath);
  const legacyBefore = readFileSync(path.join(extDir, "config.json"));

  const bin = path.join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "npm"), 0o755);

  // ── 1. update.sh on the untouched host ────────────────────────────
  const upd = spawnSync("bash", [path.join(repoRoot, "update.sh")], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...cleanEnv, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(upd.status, 0, `update.sh failed on a v0.7.0 host: ${upd.stderr}`);
  assert.doesNotMatch(upd.stderr, /deprecated/, `no SUITE_ name was set, so nothing may be flagged: ${upd.stderr}`);
  assert.ok(existsSync(path.join(extDir, "src", "suite-client.ts")), "update.sh should have copied src/ into the default ext dir");
  assert.ok(existsSync(path.join(extDir, "build-info.json")), "update.sh should have stamped build-info.json");
  assert.deepEqual(readFileSync(ocPath), ocBefore, "update.sh must leave openclaw.json byte-equal");
  assert.deepEqual(readFileSync(path.join(extDir, "config.json")), legacyBefore, "update.sh must leave config.json byte-equal");

  // ── 2. the old channel section validates against the new manifest ──
  const manifest = JSON.parse(readFileSync(path.join(extDir, "openclaw.plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(extDir, "package.json"), "utf8"));
  const cfg = JSON.parse(ocBefore.toString("utf8"));
  const section = cfg.channels["startup-suite"];
  assert.ok(section, "fixture names channels.startup-suite");

  const require = createRequire(import.meta.url);
  const ajvModule = require("ajv");
  const Ajv = typeof ajvModule.default === "function" ? ajvModule.default : ajvModule;
  // Same options as OpenClaw's own getAjv() (openclaw dist io-*.js).
  const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: false });
  const validators = {
    configSchema: ajv.compile(manifest.configSchema),
    channelSchema: ajv.compile(manifest.channelConfigs["startup-suite"].schema),
  };
  const check = (label, v, value) => {
    const ok = v(value);
    return { label, ok, errors: ok ? [] : v.errors.map((e) => `${e.instancePath} ${e.message}`) };
  };
  for (const r of [
    check("configSchema", validators.configSchema, { "startup-suite": section }),
    check("channelConfigs.startup-suite.schema", validators.channelSchema, section),
  ]) {
    assert.ok(r.ok, `v0.7.0 channel config must validate against the new ${r.label}: ${r.errors.join("; ")}`);
  }
  // Positive control: the same validators can say no.
  const broken = structuredClone(section);
  delete broken.accounts.beacon.runtimeId;
  assert.equal(validators.configSchema({ "startup-suite": broken }), false, "control: configSchema must reject an account without runtimeId");
  assert.equal(validators.channelSchema(broken), false, "control: channel schema must reject an account without runtimeId");

  // ── 3. every id the old config names is still declared ─────────────
  assert.equal(manifest.id, "startup-suite-channel-plugin");
  assert.ok(cfg.plugins.allow.includes(manifest.id), "plugins.allow names the manifest id");
  assert.ok(manifest.id in cfg.plugins.entries, "plugins.entries names the manifest id");
  assert.deepEqual(manifest.channels, ["startup-suite"]);
  assert.ok("startup-suite" in manifest.configSchema.properties, "configSchema key is still startup-suite");
  assert.ok("startup-suite" in manifest.channelConfigs, "channelConfigs key is still startup-suite");
  assert.equal(pkg.name, "startup-suite-channel-plugin", "npm package name unchanged");
  assert.equal(pkg.openclaw.channel.id, "startup-suite", "package.json openclaw.channel.id unchanged");
  for (const b of cfg.bindings) assert.equal(b.match.channel, "startup-suite", "fixture bindings match channel startup-suite");

  // ── 4. the installed copy resolves and joins every account ─────────
  const shim = path.join(scratch, "fake-phoenix.mjs");
  writeFileSync(
    shim,
    `// Written by check-old-config.mjs. Records what a socket dials and joins.
export const captured = [];
class FakePush { receive() { return this; } }
class FakeChannel {
  constructor(topic, params) { captured.push({ kind: "join", topic, params }); }
  on() {} push() { return new FakePush(); } join() { return new FakePush(); } leave() {}
}
class FakeSocket {
  constructor(url, opts) { captured.push({ kind: "socket", url, params: opts?.params }); }
  channel(topic, params) { return new FakeChannel(topic, params); }
  onOpen() {} onClose() {} onError() {} connect() {} disconnect() {}
}
export { FakeSocket as Socket, FakeChannel };
`,
  );
  const probe = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "_old-config-probe.mjs"), extDir, ocPath, shim], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...cleanEnv, HOME: home },
  });
  assert.equal(probe.status, 0, `probe failed: ${probe.stderr}`);
  const out = JSON.parse(probe.stdout.trim().split("\n").pop());

  const fixtureAccounts = section.accounts;
  assert.deepEqual(out.accountIds, Object.keys(fixtureAccounts), "the copy lists the same accounts");
  for (const [id, acct] of Object.entries(fixtureAccounts)) {
    const got = out.accounts[id];
    assert.ok(got?.resolved, `${id}: account must resolve`);
    assert.equal(got.resolved.url, acct.url, `${id}: url`);
    assert.equal(got.resolved.runtimeId, acct.runtimeId, `${id}: runtimeId`);
    assert.equal(got.resolved.token, acct.token, `${id}: token`);
    const sock = got.joins.find((c) => c.kind === "socket");
    const join = got.joins.find((c) => c.kind === "join");
    assert.equal(sock?.url, acct.url, `${id}: socket must dial the configured url`);
    assert.equal(sock?.params?.runtime_id, acct.runtimeId, `${id}: socket runtime_id param`);
    assert.equal(sock?.params?.token, acct.token, `${id}: socket token param`);
    assert.equal(join?.topic, `runtime:${acct.runtimeId}`, `${id}: join topic`);
    assert.equal(join?.params?.client_info?.product, "openclaw", `${id}: client_info.product unchanged`);
  }

  const legacy = JSON.parse(legacyBefore.toString("utf8"));
  assert.deepEqual(out.legacy.accountIds, ["default"], "single-agent host: config.json still yields the default account");
  assert.equal(out.legacy.resolved?.runtimeId, legacy.runtimeId, "single-agent host: runtimeId from config.json");
  assert.equal(out.legacy.resolved?.url, legacy.url, "single-agent host: url from config.json");

  assert.ok(!out.entry?.error, `the installed plugin entry must import: ${out.entry?.error}`);
  assert.equal(out.entry.id, "startup-suite-channel-plugin", "entry id unchanged");
  assert.equal(out.entry.channelId, "startup-suite", "entry channel id unchanged");

  console.log(
    `Old config OK: v0.7.0 openclaw.json + config.json byte-equal after update.sh, ` +
      `validate against the new configSchema and channel schema (control rejects a broken account), ` +
      `${out.accountIds.length} named accounts + legacy default resolve in the installed copy and join runtime:<id>, ` +
      `entry id ${out.entry.id}, channel ${out.entry.channelId}, label ${out.entry.channelLabel}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
