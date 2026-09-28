// Subprocess driver for check-client-info-handshake.mjs (task 01a09e63).
//
// Usage: node scripts/_client-info-probe.mjs <path/to/dist/src/suite-client.js>
//
// Loads a SuiteClient from an ARBITRARY copy of the compiled plugin (e.g. a
// temp dir with no build-info.json), joins twice through the fake phoenix
// (scripts/_fake-phoenix.mjs, written by check-client-info-handshake.mjs), and
// prints the captured client_info of each join as one JSON line.

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const compiled = process.argv[2];
if (!compiled) throw new Error("usage: _client-info-probe.mjs <suite-client.js>");

register("./_phoenix-stub-loader.mjs", import.meta.url);

const shimPath = path.join(path.dirname(new URL(import.meta.url).pathname), "_fake-phoenix.mjs");
const { SuiteClient } = await import(pathToFileURL(path.resolve(compiled)).href);
const shim = await import(pathToFileURL(shimPath).href);

const client = new SuiteClient(
  { url: "ws://localhost/socket", runtimeId: "probe", token: "t", autoJoinSpaces: [], reconnectIntervalMs: 100, maxReconnectIntervalMs: 1000 },
  { onAttention: () => {}, onToolResult: () => {}, onDisconnect: () => {} },
);
client.connect();
await new Promise((r) => setTimeout(r, 25));
client.connect();
client.disconnect();

process.stdout.write(JSON.stringify(shim.FakeChannel.captured.map((c) => c.params.client_info)) + "\n");
