// suite-cli's spec/token-ref-vectors.json (vendored here, pinned by
// spec/token-ref-vectors.pin, diffed by scripts/check-token-ref-vectors.sh),
// run against src/token-ref.ts (task 01a0d6b9 stage 1).
//
// This plugin is a LEGACY consumer (spec "Literals"): a literal `token` is
// accepted with a deprecation warning; every ref is resolved or refused as the
// vectors say. This resolver reports no error CODE, so a refusal is checked by
// outcome, kind, the names its reason must carry, and the absence of the
// value. Values are fresh random canaries and are never printed.
//
// Loads the COMPILED files from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dist = path.join(repoRoot, "dist", "src", "token-ref.js");
if (!existsSync(dist)) {
  console.error(`Missing ${dist}. Run \`npm run build\` first.`);
  process.exit(1);
}
const { resolveTokenRef, resetTokenRefState, securityArgs, SECURITY_BIN } = await import(pathToFileURL(dist).href);
const spec = JSON.parse(readFileSync(path.join(repoRoot, "spec", "token-ref-vectors.json"), "utf8"));
const tmp = mkdtempSync(path.join(os.tmpdir(), `openclaw-vectors-01a0d6b9-${process.pid}-`));

let failed = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    failed++;
    // The assertion message never carries a value: every compared value below
    // is reduced to a boolean or a kind before it reaches assert.
    results.push(`FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

check("anti-vacuity: vectors exist and cover every outcome", () => {
  assert.ok(spec.vectors.length >= 20, `only ${spec.vectors.length} vectors`);
  assert.deepEqual([...new Set(spec.vectors.map((v) => v.expect.outcome))].sort(), ["literal", "refused", "resolved"]);
});
check("the pinned resolver argv is the one this plugin builds", () => {
  assert.equal(spec.security.bin, SECURITY_BIN);
  assert.deepEqual(securityArgs("{service}", "{item}"), spec.security.args);
});

for (const v of spec.vectors) {
  check(`${v.id}: ${v.expect.outcome}${v.expect.code ? ` ${v.expect.code}` : ""}`, () => {
    resetTokenRefState();
    const value = `vec_01a0d6b9_${randomBytes(20).toString("hex")}`;
    const dir = mkdtempSync(path.join(tmp, "v-"));
    const fill = (s) => s.replaceAll("{dir}", dir).replaceAll("{value}", value);
    const tokenPath = path.join(dir, "runtime.token");
    if (v.file && v.file.kind !== "absent") {
      const target = v.file.kind === "symlink" ? path.join(dir, "real.token") : tokenPath;
      writeFileSync(target, fill(v.file.content ?? ""));
      chmodSync(target, Number.parseInt(v.file.mode ?? "0600", 8));
      if (v.file.kind === "symlink") symlinkSync(target, tokenPath);
    }
    const me = process.getuid?.() ?? 0;
    const calls = [];
    const logs = [];
    const r = resolveTokenRef(
      fill(v.ref),
      { accountId: "vectors", keychainService: v.keychain_service ?? undefined },
      {
        platform: v.platform,
        uid: v.file?.owner === "other" ? me + 1 : me,
        log: (line) => logs.push(String(line)),
        exec: (bin, args) => {
          calls.push([bin, ...args]);
          if (!v.security) throw new Error(`vector ${v.id} did not expect security`);
          return { status: v.security.exit, stdout: fill(v.security.stdout) };
        },
      },
    );
    const leaked = [r.reason ?? "", ...logs].some((t) => t.includes(value));
    switch (v.expect.outcome) {
      case "resolved":
        assert.equal(r.ok, true, `expected resolved, got refused`);
        assert.equal(r.kind, v.expect.kind);
        assert.equal(r.value === fill(v.expect.value), true, "resolved value differs");
        break;
      case "literal":
        assert.equal(r.ok, true, "a literal must pass through (legacy consumer)");
        assert.equal(r.kind, "literal");
        assert.equal(r.value === fill(v.ref), true, "literal changed in transit");
        break;
      case "refused":
        assert.equal(r.ok, false, `expected refused (${v.expect.code}), got ok kind=${r.kind}`);
        for (const n of v.expect.names ?? []) assert.ok(r.reason.includes(n), `reason does not name ${n}`);
        break;
      default:
        throw new Error(`unknown outcome in vector ${v.id}`);
    }
    if (v.expect.outcome !== "literal") assert.equal(leaked, false, "a reason or log line carries the value");
    if (v.expect.security_args) {
      assert.deepEqual(calls, [[spec.security.bin, ...v.expect.security_args]]);
      assert.equal(calls.flat().join(" ").includes(value), false, "argv carries the value");
    }
  });
}

rmSync(tmp, { recursive: true, force: true });
for (const line of results) console.log(line);
console.log(`${results.length - failed} passed, ${failed} failed (spec v${spec.spec_version})`);
process.exit(failed === 0 ? 0 : 1);
