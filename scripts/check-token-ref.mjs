// Token-ref resolver contract test (task 01a0d8f8 stage 2).
//
// An account's `token` is a REFERENCE -- `file:<absolute path>` or
// `keychain:<item>` + `tokenKeychainService` -- or a deprecated literal. One
// resolver (src/token-ref.ts) handles all three, and plugin-state /
// channel.ts consume only its RESOLVED output. These tests pin:
//
//   - file: resolves only for a regular, caller-owned, 0600/0400 file;
//   - keychain: runs /usr/bin/security with NAMES only in argv, is macOS-only,
//     and cannot be answered by a `security` earlier on PATH;
//   - a literal still works and warns once per account;
//   - channel.ts resolveAccount / isConfigured / describeAccount report
//     `configured` from the resolved config and never carry the value;
//   - LEAK CHECK: no captured log line, reason or account object contains the
//     canary value, with a positive control that the scanner can see it.
//
// Every fixture lives under a fresh temp dir. The canary is random per run
// and is never printed.
//
// Loads the COMPILED files from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function distUrl(...segments) {
  const file = path.join(repoRoot, "dist", ...segments);
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` first.`);
    process.exit(1);
  }
  return pathToFileURL(file).href;
}

const tokenRef = await import(distUrl("src", "token-ref.js"));
const { resolveTokenRef, resetTokenRefState, setTokenRefDeps, securityArgs, SECURITY_BIN } = tokenRef;
const { resolveAccountConfig } = await import(distUrl("src", "plugin-state.js"));
const { suitePlugin } = await import(distUrl("src", "channel.js"));

const tmp = mkdtempSync(path.join(os.tmpdir(), `check-token-ref-01a0d8f8-${process.pid}-`));
const CANARY = `canary-01a0d8f8-${randomBytes(20).toString("hex")}`;
const LITERAL_CANARY = `literal-01a0d8f8-${randomBytes(20).toString("hex")}`;

// ------------------------------------------------------------ log capture
// Everything any code path could print goes into `captured`: the injected
// logger, plus console.* in case something bypasses it.
const captured = [];
const log = (line) => captured.push(String(line));
for (const method of ["log", "warn", "error", "info", "debug"]) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    // Only our own PASS lines reach the terminal.
    if (method === "log" && String(args[0]).startsWith("PASS")) orig(...args);
  };
}
const pass = (name) => console.log(`PASS ${name}`);

function scanFor(needle, haystacks) {
  return haystacks.filter((h) => String(h).includes(needle)).length;
}

function fresh(deps = {}) {
  resetTokenRefState();
  setTokenRefDeps({ log, ...deps });
}

function tokenFile(name, mode, content = `${CANARY}\n`) {
  const p = path.join(tmp, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

const reasons = [];
const outputs = [];
function resolve(token, opts, deps) {
  const r = resolveTokenRef(token, opts, deps);
  if (!r.ok) reasons.push(r.reason);
  return r;
}

try {
  // -------------------------------------------------------------- file:
  fresh();
  const good600 = tokenFile("good-600", 0o600);
  let r = resolve(`file:${good600}`, { accountId: "a1" });
  assert.equal(r.ok, true, "a 0600 caller-owned file must resolve");
  assert.equal(r.value, CANARY, "one trailing newline is stripped, nothing else");
  assert.equal(r.kind, "file");
  pass("file: 0600 resolves");

  const good400 = tokenFile("good-400", 0o400);
  assert.equal(resolve(`file:${good400}`, { accountId: "a1" }).ok, true, "0400 must resolve");
  pass("file: 0400 resolves");

  for (const [name, mode] of [["loose-644", 0o644], ["group-640", 0o640], ["exec-700", 0o700]]) {
    const p = tokenFile(name, mode);
    const before = captured.length;
    r = resolve(`file:${p}`, { accountId: "a2" });
    assert.equal(r.ok, false, `mode ${mode.toString(8)} must NOT resolve`);
    assert.match(r.reason, new RegExp(`${p}.*mode 0${mode.toString(8)}`), "reason names path and mode");
    const lines = captured.slice(before);
    assert.equal(lines.length, 1, "one failure = one log line");
    assert.match(lines[0], /burrow\(a2\)/, "log line names the account");
    assert.ok(lines[0].includes(p), "log line names the path");
  }
  pass("file: 0644 / 0640 / 0700 refused with one line naming account, path and mode");

  r = resolve(`file:${path.join(tmp, "absent")}`, { accountId: "a3" });
  assert.equal(r.ok, false, "missing file must NOT resolve");
  r = resolve(`file:${tokenFile("empty", 0o600, "")}`, { accountId: "a3" });
  assert.equal(r.ok, false, "empty file must NOT resolve");
  r = resolve(`file:${tokenFile("only-newline", 0o600, "\n")}`, { accountId: "a3" });
  assert.equal(r.ok, false, "a file holding only a newline is empty");
  r = resolve("file:relative/token", { accountId: "a3" });
  assert.equal(r.ok, false, "relative path must NOT resolve");
  const link = path.join(tmp, "link-to-good");
  symlinkSync(good600, link);
  r = resolve(`file:${link}`, { accountId: "a3" });
  assert.equal(r.ok, false, "a symlink must NOT resolve, even to a good file");
  r = resolve(`file:${good600}`, { accountId: "a3" }, { log, uid: (process.getuid?.() ?? 0) + 1 });
  assert.equal(r.ok, false, "a file owned by another uid must NOT resolve");
  assert.match(r.reason, /owned by uid/);
  pass("file: missing / empty / relative / symlink / foreign-owner refused");

  // ---------------------------------------------------------- keychain:
  // A fake `security` that records its argv and answers from a file, so the
  // value never passes through argv even on the fake's side.
  const argvLog = path.join(tmp, "security-argv.log");
  const valueFile = tokenFile("keychain-value", 0o600, `${CANARY}\n`);
  const fakeSecurity = path.join(tmp, "fake-security");
  writeFileSync(
    fakeSecurity,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\nfor a in "$@"; do [ "$a" = missing-item ] && exit 44; done\ncat '${valueFile}'\n`,
  );
  chmodSync(fakeSecurity, 0o700);

  fresh({ platform: "darwin", securityBin: fakeSecurity });
  r = resolve("keychain:RUNTIME_TOKEN.test", { accountId: "k1", keychainService: "svc-01a0d8f8" });
  assert.equal(r.ok, true, "keychain ref must resolve via the fake");
  assert.equal(r.value, CANARY, "the value came from the child's stdout");
  assert.equal(r.kind, "keychain");
  const argv = readFileSync(argvLog, "utf8").trimEnd().split("\n");
  assert.deepEqual(
    argv,
    ["find-generic-password", "-s", "svc-01a0d8f8", "-a", "RUNTIME_TOKEN.test", "-w"],
    "argv is exactly the names-only security call",
  );
  assert.deepEqual(argv, securityArgs("svc-01a0d8f8", "RUNTIME_TOKEN.test"));
  assert.equal(scanFor(CANARY, argv), 0, "the value is not in argv");
  pass("keychain: names-only argv, value arrives on stdout");

  // Cached: a second resolve does not spawn again.
  resolve("keychain:RUNTIME_TOKEN.test", { accountId: "k1", keychainService: "svc-01a0d8f8" });
  assert.equal(readFileSync(argvLog, "utf8").trimEnd().split("\n").length, 6, "second resolve hits the cache");
  pass("keychain: success is cached per service+item");

  // The resolved value reaches the client config.
  const kcCfg = {
    channels: {
      "burrow": {
        accounts: {
          k1: { url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-k1", token: "keychain:RUNTIME_TOKEN.test", tokenKeychainService: "svc-01a0d8f8" },
        },
      },
    },
  };
  const kcConfig = resolveAccountConfig(kcCfg, "k1");
  assert.ok(kcConfig, "keychain account resolves to a config");
  assert.equal(kcConfig.token, CANARY, "the SuiteConfig handed to SuiteClient carries the resolved value");
  assert.equal("tokenKeychainService" in kcConfig, false);
  pass("keychain: resolved value reaches the client config");

  fresh({ platform: "darwin", securityBin: fakeSecurity });
  r = resolve("keychain:missing-item", { accountId: "k2", keychainService: "svc-01a0d8f8" });
  assert.equal(r.ok, false, "a missing item / locked keychain is not ok");
  assert.match(r.reason, /missing-item/, "reason names the item");
  assert.match(r.reason, /exit 44/);
  pass("keychain: missing item refused");

  r = resolve("keychain:RUNTIME_TOKEN.test", { accountId: "k2" });
  assert.equal(r.ok, false, "keychain ref without a service is not ok");
  assert.match(r.reason, /tokenKeychainService/);
  pass("keychain: missing tokenKeychainService refused");

  let execCalls = 0;
  fresh({ platform: "linux", exec: () => { execCalls++; return { status: 0, stdout: CANARY }; } });
  r = resolve("keychain:RUNTIME_TOKEN.test", { accountId: "k3", keychainService: "svc" });
  assert.equal(r.ok, false, "off darwin a keychain ref is refused");
  assert.match(r.reason, /macOS-only/);
  assert.equal(execCalls, 0, "off darwin nothing is spawned");
  pass("keychain: refused off darwin through the platform seam, nothing spawned");

  // PATH must not answer for the keychain. A `security` placed FIRST on PATH
  // is ignored: the default binary is the absolute /usr/bin/security.
  const pathDir = path.join(tmp, "path-first");
  const pathMarker = path.join(tmp, "path-security-ran");
  rmSync(pathDir, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(pathDir);
  writeFileSync(path.join(pathDir, "security"), `#!/bin/sh\ntouch '${pathMarker}'\necho path-fake\n`);
  chmodSync(path.join(pathDir, "security"), 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${pathDir}${path.delimiter}${oldPath}`;
  try {
    const seen = [];
    fresh({ platform: "darwin", exec: (bin, args) => { seen.push(bin); return { status: 0, stdout: "x\n" }; } });
    resolve("keychain:item", { accountId: "k4", keychainService: "svc" });
    assert.deepEqual(seen, [SECURITY_BIN], "the binary invoked is the absolute /usr/bin/security");
    assert.equal(SECURITY_BIN, "/usr/bin/security");

    if (!existsSync("/usr/bin/security")) {
      // Real child, default exec: /usr/bin/security is absent here, so the
      // resolve fails -- and the PATH fake must NOT have run in its place.
      fresh({ platform: "darwin" });
      r = resolve("keychain:item", { accountId: "k4", keychainService: "svc" });
      assert.equal(r.ok, false, "absent /usr/bin/security is a failure, not a PATH lookup");
      assert.equal(existsSync(pathMarker), false, "the security first on PATH never ran");
      pass("keychain: PATH-first fake ignored (real spawn, /usr/bin/security absent)");
    }
  } finally {
    process.env.PATH = oldPath;
  }
  pass("keychain: default binary is absolute, PATH cannot answer");

  // ------------------------------------------------------------ literal
  fresh();
  const before = captured.length;
  r = resolve(LITERAL_CANARY, { accountId: "l1" });
  assert.equal(r.ok, true, "a literal still resolves");
  assert.equal(r.value, LITERAL_CANARY);
  assert.equal(r.kind, "literal");
  resolve(LITERAL_CANARY, { accountId: "l1" });
  resolve(LITERAL_CANARY, { accountId: "l1" });
  let lit = captured.slice(before).filter((l) => l.includes("deprecated"));
  assert.equal(lit.length, 1, "the deprecation warning fires ONCE per account");
  assert.match(lit[0], /burrow\(l1\)/);
  resolve(LITERAL_CANARY, { accountId: "l2" });
  lit = captured.slice(before).filter((l) => l.includes("deprecated"));
  assert.equal(lit.length, 2, "a second account gets its own one warning");
  pass("literal: accepted, warned once per account");

  // ---------------------------------------------- plugin-state + channel.ts
  fresh();
  const badFile = tokenFile("bad-644", 0o644);
  const cfg = {
    channels: {
      "burrow": {
        accounts: {
          good: { url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-good", token: `file:${good600}` },
          bad: { url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-bad", token: `file:${badFile}` },
          lit: { url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-lit", token: LITERAL_CANARY },
        },
      },
    },
  };
  const goodCfg = resolveAccountConfig(cfg, "good");
  assert.equal(goodCfg.token, CANARY, "file ref resolves into SuiteConfig");
  assert.equal(resolveAccountConfig(cfg, "bad"), null, "an unresolved ref means NOT configured");
  assert.equal(resolveAccountConfig(cfg, "lit").token, LITERAL_CANARY, "literal still configures");

  const c = suitePlugin.config;
  for (const [id, want] of [["good", true], ["bad", false], ["lit", true]]) {
    const account = c.resolveAccount(cfg, id);
    outputs.push(JSON.stringify(account));
    assert.equal(account.configured, want, `${id}: resolveAccount.configured`);
    assert.equal(c.isConfigured(account, cfg), want, `${id}: isConfigured`);
    const snap = c.describeAccount(account, cfg);
    outputs.push(JSON.stringify(snap));
    assert.equal(snap.configured, want, `${id}: describeAccount.configured`);
    assert.equal("token" in account, false, `${id}: the resolved account carries no token value`);
  }
  // Raw presence is not enough: a `token` string that does not resolve is
  // not configured even though isConfigured is handed a truthy raw token.
  assert.equal(c.isConfigured({ url: "u", runtimeId: "r", token: "file:/nonexistent" }, cfg), false,
    "isConfigured ignores raw token presence");
  pass("channel.ts: configured comes from the RESOLVED config; no token on the account");

  // Legacy config.json path (accountId "default").
  const legacyPath = path.join(repoRoot, "dist", "config.json");
  if (!existsSync(legacyPath)) {
    try {
      writeFileSync(legacyPath, JSON.stringify({ url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-legacy", token: `file:${good600}` }));
      fresh();
      const legacy = resolveAccountConfig({}, "default");
      assert.equal(legacy.token, CANARY, "legacy config.json file ref resolves");
      writeFileSync(legacyPath, JSON.stringify({ url: "ws://127.0.0.1:1/runtime/ws", runtimeId: "rt-legacy", token: `file:${badFile}` }));
      assert.equal(resolveAccountConfig({}, "default"), null, "legacy unresolved ref is not configured");
      pass("legacy config.json path resolves refs too");
    } finally {
      rmSync(legacyPath, { force: true });
    }
  } else {
    console.log("PASS legacy config.json path SKIPPED: dist/config.json exists and is not ours to overwrite");
  }

  // ----------------------------------------------------------- leak check
  // Positive control first: the scanner can see the canary where it is.
  assert.equal(scanFor(CANARY, [readFileSync(good600, "utf8")]), 1, "control: canary is findable in the token file");
  assert.equal(scanFor(CANARY, [`planted ${CANARY} line`]), 1, "control: canary is findable in a planted log line");
  assert.equal(scanFor(LITERAL_CANARY, [`planted ${LITERAL_CANARY}`]), 1, "control: literal canary findable");
  assert.ok(captured.length > 5, "control: the capture actually recorded log lines");

  const surfaces = [...captured, ...reasons, ...outputs];
  assert.equal(scanFor(CANARY, surfaces), 0, "LEAK: the resolved token value appeared in a log line, reason or account object");
  assert.equal(scanFor(LITERAL_CANARY, surfaces), 0, "LEAK: a literal token appeared in a log line, reason or account object");
  pass(`leak check: 0 canary hits across ${surfaces.length} captured lines/reasons/objects (positive controls hit)`);
} finally {
  setTokenRefDeps({});
  resetTokenRefState();
  rmSync(tmp, { recursive: true, force: true });
}
