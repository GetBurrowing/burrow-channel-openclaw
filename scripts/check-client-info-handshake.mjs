// Federation handshake contract test (stage 3 of task 019df0ee).
//
// Verifies that the SuiteClient's runtime channel join passes
// `client_info: { product: "openclaw", version: <truthy> }` so the Burrow
// dispatch renderer can distinguish OpenClaw runtimes from Claude-channel
// runtimes. We don't open a real WebSocket — `import "phoenix"` is
// redirected via a tiny ESM loader (_phoenix-stub-loader.mjs) to a shim
// that captures the (topic, params) pair on every channel() call.
//
// Loads the COMPILED file from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const compiled = path.join(repoRoot, "dist", "src", "suite-client.js");

if (!existsSync(compiled)) {
  console.error(`Missing ${compiled}. Run \`npm run build\` first.`);
  process.exit(1);
}

// Write the shim that mimics the bits of `phoenix` that suite-client uses.
const shimPath = path.join(repoRoot, "scripts", "_fake-phoenix.mjs");
writeFileSync(
  shimPath,
  `// Auto-generated shim used by check-client-info-handshake.mjs
class FakePush { receive() { return this; } }
class FakeChannel {
  constructor(topic, params) { FakeChannel.captured.push({ topic, params }); }
  on() {} push() { return new FakePush(); } join() { return new FakePush(); } leave() {}
}
FakeChannel.captured = [];
class FakeSocket {
  constructor() {}
  channel(topic, params) { return new FakeChannel(topic, params); }
  onOpen() {} onClose() {} onError() {} connect() {} disconnect() {}
}
export { FakeSocket as Socket, FakeChannel };
`,
);

// Register the loader BEFORE importing the compiled suite-client.
register("./_phoenix-stub-loader.mjs", import.meta.url);

const { SuiteClient } = await import(pathToFileURL(compiled).href);
const shim = await import(pathToFileURL(shimPath).href);

const client = new SuiteClient(
  {
    url: "ws://localhost/socket",
    runtimeId: "test-runtime",
    token: "test-token",
    autoJoinSpaces: [],
    reconnectIntervalMs: 100,
    maxReconnectIntervalMs: 1000,
  },
  {
    onAttention: () => {},
    onToolResult: () => {},
    onDisconnect: () => {},
  },
);

const beforeFirstConnect = Date.now();
client.connect();

assert.equal(shim.FakeChannel.captured.length, 1, "expected exactly one channel join");
const { topic, params } = shim.FakeChannel.captured[0];
assert.equal(topic, "runtime:test-runtime", `topic should be runtime:<id>, got ${topic}`);
assert.ok(params, "join params object should exist");
assert.ok(params.client_info, "join params should include client_info");
assert.equal(
  params.client_info.product,
  "openclaw",
  `client_info.product should be "openclaw", got ${JSON.stringify(params.client_info.product)}`,
);
assert.ok(
  typeof params.client_info.version === "string" && params.client_info.version.length > 0,
  `client_info.version should be a non-empty string, got ${JSON.stringify(params.client_info.version)}`,
);

// ── build / started_at (task 01a09e63 stage 2) ──────────────────────────────
//
// `build` must answer "is this runtime on the build whose source I am
// reading?": the sha stamped into build-info.json at copy/build time, read
// ONCE at module load. Never package.json's version (7288017 shipped a fix
// with no version bump), never anything derived from the connection.

// (a) build-info.json present (written by `prebuild`): build === its sha.
const buildInfoPath = path.join(repoRoot, "build-info.json");
assert.ok(existsSync(buildInfoPath), `${buildInfoPath} missing - \`npm run build\` runs prebuild, which stamps it`);
const stamped = JSON.parse(readFileSync(buildInfoPath, "utf8")).sha;
const ci0 = params.client_info;
assert.equal(ci0.build, stamped, `client_info.build should be the stamped sha ${stamped}, got ${JSON.stringify(ci0.build)}`);
assert.match(ci0.build, /^[0-9a-f]{40}(-dirty)?$/, "build should be a 40-hex sha");
assert.notEqual(ci0.build, ci0.version, "build must never be the package.json version");
assert.notEqual(ci0.build, JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version);
assert.equal("build_error" in ci0, false, "build_error must be absent when build resolved");

// (c) started_at: the process start. Parses, predates this connect, and a
// rejoin on the same client re-sends it byte-for-byte (a connect-time value
// would move by >= the 25 ms gap).
assert.equal(typeof ci0.started_at, "string", "client_info.started_at should be a string");
const startedMs = Date.parse(ci0.started_at);
assert.ok(!Number.isNaN(startedMs), `started_at should parse, got ${ci0.started_at}`);
assert.ok(startedMs <= Date.now(), "started_at must not be in the future");
assert.ok(startedMs < beforeFirstConnect, "started_at must predate the first connect (process start, not connect time)");
await new Promise((r) => setTimeout(r, 25));
client.connect();
assert.equal(shim.FakeChannel.captured.length, 2, "expected a second join on reconnect");
const ci1 = shim.FakeChannel.captured[1].params.client_info;
assert.equal(ci1.started_at, ci0.started_at, "started_at must be identical across a rejoin");
assert.equal(ci1.build, ci0.build, "build must be identical across a rejoin");

client.disconnect();

// (b) no build-info.json: load a COPY of the compiled plugin from a temp dir
// in a subprocess. The temp dir sits under node_modules/.cache so the copy's
// `ws` import still resolves; it holds only package.json + dist/.
const cacheDir = path.join(repoRoot, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const tmp = mkdtempSync(path.join(cacheDir, "client-info-probe-"));
try {
  cpSync(path.join(repoRoot, "dist"), path.join(tmp, "dist"), { recursive: true });
  cpSync(path.join(repoRoot, "package.json"), path.join(tmp, "package.json"));
  const probe = (label) => {
    const out = execFileSync(process.execPath, [path.join(repoRoot, "scripts", "_client-info-probe.mjs"), path.join(tmp, "dist", "src", "suite-client.js")], { encoding: "utf8" });
    const joins = JSON.parse(out.trim().split("\n").pop());
    assert.equal(joins.length, 2, `${label}: expected two joins`);
    return joins;
  };

  const [missing] = probe("missing stamp");
  assert.equal("build" in missing, false, `no build-info.json: build must be absent, got ${JSON.stringify(missing.build)}`);
  assert.equal(typeof missing.build_error, "string", "no build-info.json: build_error must be a string");
  assert.match(missing.build_error, /build-info\.json missing/, `build_error should name the missing stamp, got ${missing.build_error}`);
  assert.equal(missing.product, "openclaw");
  assert.equal(typeof missing.started_at, "string");

  writeFileSync(path.join(tmp, "build-info.json"), '{"sha": "0.6.9"}');
  const [malformed] = probe("malformed stamp");
  assert.equal("build" in malformed, false, "a stamp without a valid sha must not become the build");
  assert.match(malformed.build_error, /no valid sha/);

  writeFileSync(path.join(tmp, "build-info.json"), "not json");
  const [garbled] = probe("unparseable stamp");
  assert.equal("build" in garbled, false);
  assert.match(garbled.build_error, /unparseable/);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `Client info handshake OK: topic=${topic}, product=${params.client_info.product}, version=${params.client_info.version}, build=${ci0.build}, started_at stable across rejoin, missing/malformed/unparseable stamp -> build_error`,
);
