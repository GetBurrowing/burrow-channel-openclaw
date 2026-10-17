// Subprocess driver for scripts/check-old-config.mjs (task 01a14b9f stage 3).
//
// Usage: node scripts/_old-config-probe.mjs <installed ext dir> <openclaw.json> <phoenix shim>
//
// Loads the INSTALLED copy's own .ts sources (via tsx, through
// _installed-copy-loader.mjs), feeds it the untouched openclaw.json, and for
// every configured account resolves the account and connects a SuiteClient
// through the capturing phoenix shim. Prints one JSON line with what the copy
// resolved and what each socket dialled and joined.

import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [extDir, ocConfigPath, shimPath] = process.argv.slice(2);
if (!extDir || !ocConfigPath || !shimPath) {
  throw new Error("usage: _old-config-probe.mjs <ext dir> <openclaw.json> <phoenix shim>");
}

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const { register: registerTsx } = await import(
  pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href
);
registerTsx();
// Registered after tsx, so it runs first and hands the rest to tsx.
register("./_installed-copy-loader.mjs", import.meta.url, {
  data: {
    phoenixShimUrl: pathToFileURL(path.resolve(shimPath)).href,
    repoParentUrl: pathToFileURL(path.join(repoRoot, "index.ts")).href,
  },
});

const fromExt = (...p) => pathToFileURL(path.join(extDir, ...p)).href;
const state = await import(fromExt("src", "plugin-state.ts"));
const { SuiteClient } = await import(fromExt("src", "suite-client.ts"));
const shim = await import(pathToFileURL(path.resolve(shimPath)).href);

const cfg = JSON.parse(readFileSync(ocConfigPath, "utf8"));

const out = { accountIds: state.listConfiguredAccountIds(cfg), accounts: {}, legacy: null, entry: null };
for (const id of out.accountIds) {
  const resolved = state.resolveAccountConfig(cfg, id);
  const before = shim.captured.length;
  const client = new SuiteClient(resolved, { onAttention: () => {}, onToolResult: () => {}, onDisconnect: () => {} });
  client.connect();
  const joins = shim.captured.slice(before);
  client.disconnect();
  out.accounts[id] = { resolved, joins };
}

// The single-agent shape: no accounts map, credentials in <ext>/config.json.
out.legacy = {
  accountIds: state.listConfiguredAccountIds({}),
  resolved: state.resolveAccountConfig({}, "default"),
};

// The plugin entry the gateway loads: its ids must still be the ones the
// untouched openclaw.json names.
try {
  const entry = (await import(fromExt("index.ts"))).default;
  // Register it the way the gateway does, in setup mode (no hooks wired), to
  // read the channel it hands OpenClaw.
  let channel = null;
  entry.register({ runtime: {}, registrationMode: "setup", registerChannel: ({ plugin }) => { channel = plugin; } });
  out.entry = {
    id: entry?.id,
    name: entry?.name,
    channelId: channel?.id ?? null,
    channelLabel: channel?.meta?.label ?? null,
  };
} catch (err) {
  out.entry = { error: String(err?.stack ?? err) };
}

process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
