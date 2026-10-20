// Tool wire-name negotiation: underscore first, dotted fallback on an
// unknown-tool reply (task 01a14a7d, Burrow migration).
//
// WHAT THIS PINS. Core resolves `tool_call` names by exact string membership.
// Old servers know only `skill.list`/`skill.get`/`skill.upsert` (dotted); new
// servers register underscore names and keep dotted only as hidden aliases.
// SuiteClient.callTool must:
//   - send the underscore form first;
//   - on core's unknown-tool reply ("unknown tool '<name>' (no such tool in
//     the catalogue ..."), retry EXACTLY ONCE with the dotted twin;
//   - never retry on a permission denial, even though core gives it the same
//     `code: "forbidden"` as an unknown name;
//   - never retry an underscore name that has no dotted twin.
//
// HOW. The real compiled SuiteClient runs against a fake `phoenix` module
// (redirected by _phoenix-stub-loader.mjs to scripts/_fake-phoenix.mjs, which
// this script writes). The fake channel answers each `tool_call` push by
// firing the client's own `tool_result` handler, using the exact payload
// shape core pushes (runtime_channel.ex execute_tool_call). The server's
// catalogue is a Set per mode, so "known" is decided by exact membership, the
// way core decides it.
//
// ANTI-VACUITY:
//   * Every case asserts the full ordered list of wire names the server saw,
//     not just the outcome, so a client that always sent dotted, always sent
//     both, or retried on every error fails on call counts.
//   * The permission-denied case uses a server that DOES know the dotted
//     twin: a client keyed on `code == "forbidden"` would retry and succeed,
//     so the assertion that it rejects with the permission message, after one
//     call, goes red.
//   * The dotted-only case goes red if the fallback branch is removed.
//
// Loads the COMPILED files from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { register } from "node:module";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const compiledClient = path.join(repoRoot, "dist", "src", "suite-client.js");
const compiledChannel = path.join(repoRoot, "dist", "src", "channel.js");
const compiledPluginState = path.join(repoRoot, "dist", "src", "plugin-state.js");
for (const f of [compiledClient, compiledChannel, compiledPluginState]) {
  if (!existsSync(f)) {
    console.error(`Missing ${f}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

// A fake phoenix whose channel routes `tool_call` pushes to a test-controlled
// server function and delivers the answer through the registered handler.
const shimPath = path.join(repoRoot, "scripts", "_fake-phoenix.mjs");
writeFileSync(
  shimPath,
  `// Auto-generated shim used by check-tool-name-fallback.mjs
class FakePush { receive() { return this; } }
class FakeChannel {
  constructor(topic, params) { this.handlers = {}; FakeChannel.captured.push({ topic, params }); }
  on(event, fn) { this.handlers[event] = fn; }
  push(event, payload) {
    if (event === "tool_call") {
      setImmediate(() => {
        const reply = globalThis.__fakeSuiteServer(payload);
        if (reply) this.handlers["tool_result"]?.(reply);
      });
    }
    return new FakePush();
  }
  join() { return new FakePush(); }
  leave() {}
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

register("./_phoenix-stub-loader.mjs", import.meta.url);

const { SuiteClient } = await import(pathToFileURL(compiledClient).href);
const { suitePlugin } = await import(pathToFileURL(compiledChannel).href);
const { setClient, clearClient } = await import(pathToFileURL(compiledPluginState).href);

// Core's literal messages (tool_authorization.ex unknown_tool / not granted).
const unknownMsg = (name, closest) =>
  `unknown tool '${name}' (no such tool in the catalogue — this is a name lookup miss, not a permissions problem).` +
  (closest ? ` Closest declared name: '${closest}'.` : "");
const permissionMsg = (name) =>
  `tool '${name}' requires permission 'skills:read', which this runtime is not granted.`;

/**
 * Install a server. `known` = exact names in the catalogue; `denied` = names
 * that exist but are not granted. Returns the ordered log of wire names.
 */
function serve({ known, denied = new Set() }) {
  const seen = [];
  globalThis.__fakeSuiteServer = ({ call_id, tool, args }) => {
    seen.push(tool);
    if (denied.has(tool)) {
      return { call_id, status: "error", error: { error: permissionMsg(tool), code: "forbidden" } };
    }
    if (!known.has(tool)) {
      const closest = [...known].find((k) => k.replace(/\./g, "_") === tool.replace(/\./g, "_"));
      return { call_id, status: "error", error: { error: unknownMsg(tool, closest), code: "forbidden" } };
    }
    return { call_id, status: "ok", result: { tool, args } };
  };
  return seen;
}

const client = new SuiteClient(
  { url: "ws://localhost/socket", runtimeId: "fallback-test", token: "t", autoJoinSpaces: [], reconnectIntervalMs: 100, maxReconnectIntervalMs: 1000 },
  { onAttention: () => {}, onToolResult: () => {}, onDisconnect: () => {} },
);
client.connect();

const UNDERSCORE = new Set(["skill_list", "skill_get", "skill_upsert", "epic_create", "task_list"]);
const DOTTED = new Set(["skill.list", "skill.get", "skill.upsert", "epic.create", "task_list"]);
const BOTH = new Set([...UNDERSCORE, ...DOTTED]);
const args = { query: "x" };

let cases = 0;
async function check(label, fn) {
  await fn();
  cases += 1;
  console.log(`  ok  ${label}`);
}

// 1. Underscore-only server (new core, no dotted alias): one call, underscore.
for (const name of ["skill.list", "skill_list"]) {
  await check(`underscore-only server, callTool(${name})`, async () => {
    const seen = serve({ known: UNDERSCORE });
    const res = await client.callTool(name, args);
    assert.deepEqual(seen, ["skill_list"], `wire names: ${JSON.stringify(seen)}`);
    assert.equal(res.tool, "skill_list");
    assert.deepEqual(res.args, args, "args forwarded unchanged");
  });
}

// 2. Dotted-only server (old core): underscore, then dotted, success, 2 calls.
for (const [name, under, dotted] of [
  ["skill.list", "skill_list", "skill.list"],
  ["skill_list", "skill_list", "skill.list"],
  ["skill_get", "skill_get", "skill.get"],
  ["skill_upsert", "skill_upsert", "skill.upsert"],
  ["epic_create", "epic_create", "epic.create"],
]) {
  await check(`dotted-only server, callTool(${name}) falls back to ${dotted}`, async () => {
    const seen = serve({ known: DOTTED });
    const res = await client.callTool(name, args);
    assert.deepEqual(seen, [under, dotted], `wire names: ${JSON.stringify(seen)}`);
    assert.equal(res.tool, dotted);
  });
}

// 3. Server accepting both (new core with hidden dotted alias): one call.
await check("both-forms server: one underscore call", async () => {
  const seen = serve({ known: BOTH });
  const res = await client.callTool("skill.get", args);
  assert.deepEqual(seen, ["skill_get"], `wire names: ${JSON.stringify(seen)}`);
  assert.equal(res.tool, "skill_get");
});

// 4. Permission denied on the underscore name: NO retry, even though the
//    server would accept the dotted twin. Same `forbidden` code as unknown.
await check("permission-denied reply is surfaced, never retried", async () => {
  const seen = serve({ known: BOTH, denied: new Set(["skill_list"]) });
  await assert.rejects(
    client.callTool("skill_list", args),
    (err) => err.message === permissionMsg("skill_list"),
  );
  assert.deepEqual(seen, ["skill_list"], `wire names: ${JSON.stringify(seen)}`);
});

// 5. Both forms unknown: exactly two calls, and the SECOND error is surfaced.
await check("both forms unknown: second error surfaced unchanged", async () => {
  const seen = serve({ known: new Set(["task_list"]) });
  await assert.rejects(client.callTool("skill.upsert", args), (err) => err.message === unknownMsg("skill.upsert"));
  assert.deepEqual(seen, ["skill_upsert", "skill.upsert"], `wire names: ${JSON.stringify(seen)}`);
});

// 6. Fallback answers with a permission denial: surfaced, no third call.
await check("dotted fallback denied: permission error surfaced, 2 calls", async () => {
  const seen = serve({ known: DOTTED, denied: new Set(["skill.get"]) });
  await assert.rejects(client.callTool("skill_get", args), (err) => err.message === permissionMsg("skill.get"));
  assert.deepEqual(seen, ["skill_get", "skill.get"], `wire names: ${JSON.stringify(seen)}`);
});

// 7. Underscore name with no dotted twin: sent as-is, no retry on unknown.
await check("underscore name without a twin is never retried", async () => {
  const seen = serve({ known: new Set() });
  await assert.rejects(client.callTool("task_list", args), (err) => err.message.startsWith("unknown tool 'task_list'"));
  assert.deepEqual(seen, ["task_list"], `wire names: ${JSON.stringify(seen)}`);
});

// 8. End to end through the plugin's legacy agentTools against an old server.
await check("agentTools skill_list -> old server reaches skill.list", async () => {
  const cfg = {
    channels: { "burrow": { accounts: { default: { url: "ws://x", runtimeId: "r", token: "t", useMcpTools: false } } } },
  };
  const tool = suitePlugin.agentTools({ cfg }).find((t) => t.name === "suite_skill_list");
  assert.ok(tool, "suite_skill_list must exist in legacy agentTools");
  setClient("default", client);
  try {
    const seen = serve({ known: DOTTED });
    const out = await tool.execute("call-1", args);
    assert.deepEqual(seen, ["skill_list", "skill.list"], `wire names: ${JSON.stringify(seen)}`);
    assert.equal(out.details.tool, "skill.list");
  } finally {
    clearClient("default");
  }
});

client.disconnect();
console.log(`tool-name fallback OK: ${cases} cases (underscore first, one dotted retry on unknown-tool only).`);
