// Space-resolution regression test (0.6.8 hotfix).
//
// Session keys extend OpenClaw's resolved route key
// (`agent:<agentId>:startup-suite:group:<peer>`) and `<peer>` is the Burrow
// agent slug. In 0.6.6/0.6.7 `resolveSpaceId` still derived the space by
// positional `split(":")` indexing, so it returned the slug ("higgins"). Burrow
// stores `usage_events.space_id` as `:binary_id`, so that raised
// Ecto.ChangeError server-side and killed the runtime channel process. When the
// peer happened to be a UUID it was worse: the row inserted cleanly against the
// wrong space with no error anywhere.
//
// These tests pin the replacement: the space is recorded explicitly at
// session-key mint time and read back from that map, there is no positional
// fallback, and a non-UUID can never leave the resolver or reach the wire.
//
// Loads the COMPILED files from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function distUrl(...segments) {
  const file = path.join(repoRoot, "dist", ...segments);
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` first.`);
    process.exit(1);
  }
  return pathToFileURL(file).href;
}

const { isSpaceUuid, resolveSpaceId } = await import(distUrl("src", "space-resolution.js"));
const {
  clearSessionContext,
  getTaskWorkers,
  rememberSessionSpace,
  setClient,
  spaceForSession,
} = await import(distUrl("src", "plugin-state.js"));
const { buildDispatchSessionKey, buildTaskSessionKey } = await import(
  distUrl("src", "session-key.js")
);

const SPACE = "3f1c0c2e-9a4b-4d51-8c77-0f2b6ad91e04";
const EXEC_SPACE = "88b2e2d0-4c11-4a9f-9d3e-1b7a5c6e2f10";
const TASK_ID = "019f640d-1111-7000-a000-000000000001";

// Production shape: peer is the Burrow agent slug, not the space id.
const AGENT_ROUTE_KEY = "agent:ryan-home-openclaw:startup-suite:group:higgins";

// ---------------------------------------------------------------- unit tests

// 1. UUID guard.
assert.equal(isSpaceUuid(SPACE), true, "a real space UUID must pass the guard");
assert.equal(isSpaceUuid("higgins"), false, "an agent slug must fail the guard");
assert.equal(isSpaceUuid(""), false, "empty string must fail the guard");
assert.equal(isSpaceUuid(undefined), false, "undefined must fail the guard");
assert.equal(isSpaceUuid(null), false, "null must fail the guard");
assert.equal(
  isSpaceUuid("3f1c0c2e9a4b4d518c770f2b6ad91e04"),
  false,
  "an unhyphenated hex blob must fail the guard",
);

// 2. REGRESSION: an unrecorded agent-slug route key resolves to nothing.
// Pre-fix this returned "higgins" via parts[4].
assert.equal(
  resolveSpaceId(AGENT_ROUTE_KEY),
  undefined,
  "an unrecorded agent-slug key must resolve to undefined, never to the slug",
);
assert.notEqual(
  resolveSpaceId(AGENT_ROUTE_KEY),
  "higgins",
  "the route peer (agent slug) must never be returned as a space id",
);

// 3. A recorded session resolves via the explicit mapping.
rememberSessionSpace(AGENT_ROUTE_KEY, SPACE);
assert.equal(spaceForSession(AGENT_ROUTE_KEY), SPACE, "mapping should read back");
assert.equal(
  resolveSpaceId(AGENT_ROUTE_KEY),
  SPACE,
  "a recorded group:<agent-slug> key must resolve to the recorded space",
);

// 4. REGRESSION: even a *recorded* non-UUID can never escape the resolver.
const POISONED_KEY = `${AGENT_ROUTE_KEY}:poisoned`;
rememberSessionSpace(POISONED_KEY, "higgins");
assert.equal(
  resolveSpaceId(POISONED_KEY),
  undefined,
  "a non-UUID recorded value must be rejected by the resolver",
);

// 5. A dispatch key derived from an unrecorded conversation key resolves to
// nothing rather than to the reason or discriminator segment.
const DISPATCH_KEY = buildDispatchSessionKey(
  "agent:ryan-home-openclaw:startup-suite:group:mycroft",
  "system_event",
  "1764900000000-ab12cd",
);
assert.equal(
  resolveSpaceId(DISPATCH_KEY),
  undefined,
  "an unrecorded dispatch key must resolve to undefined",
);
rememberSessionSpace(DISPATCH_KEY, SPACE);
assert.equal(resolveSpaceId(DISPATCH_KEY), SPACE, "a recorded dispatch key must resolve");

// 6. Lifecycle: clearing the session context drops the space binding too.
clearSessionContext(DISPATCH_KEY);
assert.equal(
  spaceForSession(DISPATCH_KEY),
  undefined,
  "clearSessionContext must drop the session->space entry (no unbounded map)",
);
assert.equal(resolveSpaceId(DISPATCH_KEY), undefined, "cleared session resolves to undefined");

// 7. Task sessions still resolve through the worker controller, not the map.
const TASK_KEY = buildTaskSessionKey(AGENT_ROUTE_KEY, TASK_ID, "execution");
assert.equal(
  resolveSpaceId(TASK_KEY),
  undefined,
  "a task key with no registered worker must resolve to undefined",
);

const usageEvents = [];
const fakeClient = {
  sendUsageEvent: (event) => usageEvents.push(event),
  sendExecutionEvent: () => {},
  sendReply: () => {},
  sendReplyChunk: () => {},
  sendTyping: () => {},
};
setClient("default", fakeClient);

getTaskWorkers().ensureWorker({
  taskId: TASK_ID,
  phase: "execution",
  executionSpaceId: EXEC_SPACE,
  sessionKey: TASK_KEY,
});

assert.equal(
  resolveSpaceId(TASK_KEY),
  EXEC_SPACE,
  "a task session must resolve through resolveExecutionSpaceId",
);

// ------------------------------------------------------- end-to-end emit path

// Drive the real `llm_output` handler so the assertion covers what actually
// goes on the wire, not just the resolver in isolation.
const entry = (await import(distUrl("index.js"))).default;

const handlers = new Map();
entry.register({
  runtime: { log: () => {}, error: () => {} },
  registrationMode: "full",
  registerChannel: () => {},
  on: (name, fn) => handlers.set(name, fn),
});

const onLlmOutput = handlers.get("llm_output");
assert.ok(typeof onLlmOutput === "function", "llm_output handler should be registered");

const usageEventFor = (sessionKey) => {
  usageEvents.length = 0;
  onLlmOutput(
    {
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input: 100, output: 20 },
      sessionId: "sess-1",
      runId: "run-1",
    },
    { sessionKey, channelId: "startup-suite", sessionId: "sess-1" },
  );
  assert.equal(usageEvents.length, 1, `expected one usage event for ${sessionKey}`);
  return usageEvents[0];
};

// 8. Recorded conversation session emits the real space id.
const recorded = usageEventFor(AGENT_ROUTE_KEY);
assert.equal(recorded.space_id, SPACE, "recorded session must emit its space id");

// 9. REGRESSION: unrecorded session emits NO space_id key at all. The property
// must be absent, not undefined/null/"" — Burrow casts space_id to :binary_id.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
let unrecorded;
try {
  unrecorded = usageEventFor("agent:ryan-home-openclaw:startup-suite:group:geordi");
} finally {
  console.warn = realWarn;
}
assert.equal(
  Object.prototype.hasOwnProperty.call(unrecorded, "space_id"),
  false,
  "unresolved space must omit the space_id key entirely",
);
// `session_key` legitimately carries the whole route key (slug included); no
// OTHER field may ever hold the slug.
for (const [field, value] of Object.entries(unrecorded)) {
  if (field === "session_key") continue;
  assert.equal(
    typeof value === "string" && value.includes("geordi"),
    false,
    `field ${field} must not carry the agent slug, got ${JSON.stringify(value)}`,
  );
}
assert.ok(
  warnings.some((w) => w.includes("unresolved space") && w.includes("geordi")),
  `an unresolved space must log a warning naming the sessionKey, got ${JSON.stringify(warnings)}`,
);

// 10. Task session emits the execution space.
const taskEvent = usageEventFor(TASK_KEY);
assert.equal(taskEvent.space_id, EXEC_SPACE, "task session must emit the execution space id");

console.log(
  `Space resolution OK: recorded=${recorded.space_id}, task=${taskEvent.space_id}, ` +
  `unrecorded omits space_id (${warnings.length} warning(s) logged)`,
);

process.exit(0);
