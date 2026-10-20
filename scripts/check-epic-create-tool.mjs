// agentTools contract test for `epic_create` (task 019d60ca stage 4).
//
// Verifies that the legacy WS-channel agentTools list:
//   - Includes `suite_epic_create` and the unprefixed `epic_create` alias when
//     at least one account has `useMcpTools: false` (legacy mode).
//   - Returns `[]` when EVERY configured account has `useMcpTools: true`
//     (all-accounts MCP cutover suppression — preserved from PR #19).
//   - The `execute` callback for `suite_epic_create` invokes
//     `client.callTool("epic_create", args)` — the underscore wire name core
//     registers today. SuiteClient.callTool falls back to `epic.create` for
//     old servers (task 01a14a7d; see check-tool-name-fallback.mjs).
//
// Loads the COMPILED files from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const compiledChannel = path.join(repoRoot, "dist", "src", "channel.js");
const compiledPluginState = path.join(repoRoot, "dist", "src", "plugin-state.js");

for (const compiled of [compiledChannel, compiledPluginState]) {
  if (!existsSync(compiled)) {
    console.error(`Missing ${compiled}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

const { suitePlugin } = await import(pathToFileURL(compiledChannel).href);
const { setClient, clearClient } = await import(pathToFileURL(compiledPluginState).href);

// ── 1. Legacy-mode (useMcpTools: false) exposes both names ───────────────
const legacyCfg = {
  channels: {
    "burrow": {
      accounts: {
        default: { url: "ws://x", runtimeId: "r", token: "t", useMcpTools: false },
      },
    },
  },
};

const legacyTools = suitePlugin.agentTools({ cfg: legacyCfg });
assert.ok(Array.isArray(legacyTools), "agentTools should return an array in legacy mode");

const legacyNames = legacyTools.map((t) => t.name);
assert.ok(
  legacyNames.includes("suite_epic_create"),
  `legacy agentTools should include "suite_epic_create"; got: ${JSON.stringify(legacyNames)}`,
);
assert.ok(
  legacyNames.includes("epic_create"),
  `legacy agentTools should include "epic_create" alias; got: ${JSON.stringify(legacyNames)}`,
);

// ── 2. All-accounts useMcpTools: true suppresses the entire list ─────────
const mcpCfg = {
  channels: {
    "burrow": {
      accounts: {
        default: { url: "ws://x", runtimeId: "r", token: "t", useMcpTools: true },
        secondary: { url: "ws://y", runtimeId: "r2", token: "t2", useMcpTools: true },
      },
    },
  },
};
const mcpTools = suitePlugin.agentTools({ cfg: mcpCfg });
assert.deepEqual(
  mcpTools,
  [],
  `agentTools should be [] when every account has useMcpTools: true; got ${mcpTools.length} tools`,
);

// ── 3. suite_epic_create.execute hits client.callTool("epic_create", ...) ─
const calls = [];
const fakeClient = {
  callTool(tool, args) {
    calls.push({ tool, args });
    return Promise.resolve({ ok: true, epic: { id: "epic-uuid" } });
  },
};
setClient("default", fakeClient);

try {
  const epicTool = legacyTools.find((t) => t.name === "suite_epic_create");
  assert.ok(epicTool, "suite_epic_create entry should exist in agentTools");
  assert.equal(typeof epicTool.execute, "function", "suite_epic_create.execute should be a function");

  const args = {
    project_id: "00000000-0000-0000-0000-000000000001",
    name: "Test Epic",
    description: "Test description",
  };
  const result = await epicTool.execute("call-id-123", args);

  assert.equal(calls.length, 1, `expected exactly 1 callTool invocation, got ${calls.length}`);
  assert.equal(
    calls[0].tool,
    "epic_create",
    `first wire tool name should be "epic_create" (underscore; SuiteClient.callTool falls back to dotted), got ${JSON.stringify(calls[0].tool)}`,
  );
  assert.deepEqual(
    calls[0].args,
    args,
    `args forwarded to callTool should equal the input args; got ${JSON.stringify(calls[0].args)}`,
  );
  assert.ok(result?.content, "execute should return an object with `content`");

  // The unprefixed alias must dispatch to the same underscore wire name.
  const aliasTool = legacyTools.find((t) => t.name === "epic_create");
  assert.ok(aliasTool, "epic_create alias entry should exist");
  await aliasTool.execute("call-id-124", args);
  assert.equal(calls.length, 2, "alias should also invoke callTool");
  assert.equal(
    calls[1].tool,
    "epic_create",
    `alias should also dispatch to "epic_create"; got ${JSON.stringify(calls[1].tool)}`,
  );
} finally {
  clearClient("default");
}

console.log(
  `epic_create agentTools contract OK: legacy lists both names, MCP cutover suppresses, dispatch hits "epic_create".`,
);
