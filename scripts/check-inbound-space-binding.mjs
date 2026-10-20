// Inbound session->space binding test (0.6.8 hotfix).
//
// The resolver half of the fix is covered by check-space-resolution.mjs. This
// covers the other half: `handleSuiteInbound` must RECORD the space against the
// final session key, for every branch (conversation, task, one-shot dispatch).
// If it doesn't, `resolveSpaceId` silently returns undefined forever and usage
// attribution disappears instead of being wrong — quieter, but still a bug.
//
// Drives the real handler against a stubbed OpenClaw core runtime.
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

const { handleSuiteInbound } = await import(distUrl("src", "inbound.js"));
const { setSuiteRuntime } = await import(distUrl("src", "runtime.js"));
const { spaceForSession } = await import(distUrl("src", "plugin-state.js"));
const { resolveSpaceId } = await import(distUrl("src", "space-resolution.js"));

const SPACE = "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55";
const TASK_ID = "019f640d-2222-7000-a000-000000000002";
const ROUTE_KEY = "agent:ryan-home-openclaw:burrow:group:higgins";

// Route key mirrors what OpenClaw's resolver returns today: the peer is the
// Burrow agent slug, so the space id is NOT present anywhere in the key.
const fakeCore = {
  channel: {
    routing: {
      resolveAgentRoute: () => ({
        sessionKey: ROUTE_KEY,
        agentId: "ryan-home-openclaw",
        accountId: "default",
      }),
    },
    session: {
      resolveStorePath: () => "/dev/null",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async () => {},
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (ctx) => ctx,
      createReplyDispatcherWithTyping: () => ({
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      }),
      dispatchReplyFromConfig: async () => {},
    },
  },
};

setSuiteRuntime(fakeCore);

const fakeClient = {
  sendReply: () => {},
  sendReplyChunk: () => {},
  sendTyping: () => {},
  sendUsageEvent: () => {},
  sendExecutionEvent: () => {},
};

const logs = [];
const runtime = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };

async function runInbound(signal, content = "hello") {
  logs.length = 0;
  await handleSuiteInbound({
    payload: {
      signal,
      message: { content, author: "ryan" },
      context: {},
    },
    config: {},
    runtime,
    client: fakeClient,
    accountId: "default",
  });

  const line = logs.find((l) => l.includes("[suite-inbound] resolved route:"));
  assert.ok(line, `expected a resolved-route log, got ${JSON.stringify(logs)}`);
  const sessionKey = line.split("session=")[1];
  assert.ok(sessionKey, "resolved-route log should carry the final session key");
  return sessionKey;
}

// 1. Conversational mention: the session key ends in the agent slug, and the
//    space must still be recoverable.
const chatKey = await runInbound({
  space_id: SPACE,
  reason: "mention",
  agent_slug: "higgins",
});
// (Plain chat still gets `:<spaceId>` appended for per-space isolation, but the
// binding must not depend on that — tests 2 and 3 cover the keys where the
// space id genuinely is absent.)
assert.equal(spaceForSession(chatKey), SPACE, "conversation session must be bound to its space");
assert.equal(resolveSpaceId(chatKey), SPACE, "conversation session must resolve to its space");

// 2. One-shot dispatch: fresh key per firing, still bound.
const dispatchKey = await runInbound({
  space_id: SPACE,
  reason: "system_event",
  agent_slug: "higgins",
  message_id: "msg-1",
});
assert.ok(dispatchKey.includes(":dispatch:"), `expected a dispatch key, got ${dispatchKey}`);
assert.equal(resolveSpaceId(dispatchKey), SPACE, "dispatch session must resolve to its space");

// 3. Task dispatch: task keys resolve through the worker controller, but the
//    map must be populated too so the binding survives worker teardown.
const taskKey = await runInbound({
  space_id: SPACE,
  task_id: TASK_ID,
  task_status: "in_progress",
  reason: "task_assigned",
  agent_slug: "higgins",
});
assert.ok(taskKey.includes(":task:"), `expected a task key, got ${taskKey}`);
// This is the production shape that broke: orchestrated signals skip the
// per-space suffix, so the space id is genuinely absent from the key and the
// old positional read returned the agent slug.
assert.ok(
  !taskKey.includes(SPACE),
  `orchestrated keys must not carry the space id (got ${taskKey})`,
);
assert.equal(spaceForSession(taskKey), SPACE, "task session must be bound to its space");
assert.equal(resolveSpaceId(taskKey), SPACE, "task session must resolve to its space");

// 4. REGRESSION: a signal with no usable space_id must bind nothing. `spaceId`
//    inside the handler falls back to the task id, which IS a UUID and would
//    have inserted cleanly against a nonexistent space.
const orphanTask = "019f640d-3333-7000-a000-000000000003";
const orphanKey = await runInbound({
  task_id: orphanTask,
  task_status: "in_progress",
  reason: "task_assigned",
  agent_slug: "higgins",
});
assert.notEqual(
  spaceForSession(orphanKey),
  orphanTask,
  "the task id must never be bound as a space id",
);
assert.ok(
  logs.some((l) => l.includes("no usable space_id on signal")),
  "a signal with no space_id should log that usage events will omit it",
);

console.log(
  `Inbound space binding OK: chat=${chatKey.slice(-24)}, dispatch bound, task bound, ` +
  `task-id fallback rejected`,
);

process.exit(0);
