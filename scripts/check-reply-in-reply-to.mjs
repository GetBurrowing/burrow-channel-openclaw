// Reply -> in_reply_to_message_id forwarding (task 01a0d8de stage 4).
//
// WHAT THIS PINS. An inbound chat signal carries `signal.message_id` (core
// `AgentResponder.build_external_signal/3`). The reply the agent delivers for
// that run must push `in_reply_to_message_id` set to that id, so Burrow can
// link the reply to the message it answers. Two layers:
//
//   A. handleSuiteInbound -> client.sendReply receives the id as extras.
//   B. SuiteClient.sendReply writes it into the `reply` push payload.
//
// ANTI-VACUITY:
//   * The expected id is READ OUT OF the payload handed to the handler and
//     asserted non-empty first.
//   * The stub core DELIVERS (deliver + onPartialReply + onCleanup fire), and
//     the harness asserts a sendReply actually happened before inspecting it.
//   * The no-message_id case is the positive control for omission: a handler
//     that always sent `in_reply_to_message_id: undefined` would pass case A1
//     and fail A2; a client that always wrote the key would fail B2.
//   * reply_chunk pushes are checked to carry no annotation (they are
//     ephemeral and have no row to annotate).
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
const { SuiteClient } = await import(distUrl("src", "suite-client.js"));

const SPACE = "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55";
const MESSAGE_ID = "01a0d8de-aaaa-7001-9246-3f8fe86630f6";
const ROUTE_KEY = "agent:ryan-home-openclaw:burrow:group:moore";

let deliverCb = null;
let cleanupCb = null;
let delivered = 0;

setSuiteRuntime({
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
      createReplyDispatcherWithTyping: (opts) => {
        deliverCb = opts?.deliver ?? null;
        cleanupCb = opts?.onCleanup ?? null;
        return {
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "streamed answer" });
        await deliverCb?.({ text: "final answer" }, { kind: "text" });
        delivered += 1;
        cleanupCb?.();
      },
    },
  },
});

let sends = [];
const fakeClient = {
  sendReply: (...args) => sends.push({ fn: "sendReply", args }),
  sendReplyChunk: (...args) => sends.push({ fn: "sendReplyChunk", args }),
  sendTyping: (...args) => sends.push({ fn: "sendTyping", args }),
  sendUsageEvent: () => {},
  sendExecutionEvent: () => {},
};
const runtime = { log: () => {}, error: () => {} };

async function run(payload) {
  sends = [];
  delivered = 0;
  await handleSuiteInbound({ payload, config: {}, runtime, client: fakeClient, accountId: "default" });
  assert.equal(delivered, 1, "harness: the stub core must have delivered exactly once");
  const replies = sends.filter((s) => s.fn === "sendReply");
  assert.equal(replies.length, 1, `harness: expected one sendReply, saw ${JSON.stringify(sends)}`);
  return { reply: replies[0], sends: sends.slice() };
}

// A1. Chat signal WITH message_id -> sendReply carries it.
{
  const payload = {
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins", message_id: MESSAGE_ID },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  };
  const expected = payload.signal.message_id;
  assert.ok(typeof expected === "string" && expected.length > 0, "harness: expected id is empty");

  const { reply } = await run(payload);
  const [space, text, extras] = reply.args;
  assert.equal(space, SPACE, "reply goes to the signal's space");
  assert.equal(text, "final answer", "reply body unchanged");
  assert.deepEqual(
    extras,
    { in_reply_to_message_id: expected },
    `sendReply must receive in_reply_to_message_id from signal.message_id (got ${JSON.stringify(extras)})`,
  );
}

// A2. Chat signal WITHOUT message_id -> no extras at all.
{
  const { reply } = await run({
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins" },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  });
  assert.equal(
    reply.args[2],
    undefined,
    `no message_id -> sendReply gets no extras (got ${JSON.stringify(reply.args[2])})`,
  );
}

// A3. Empty-string message_id is treated as absent.
{
  const { reply } = await run({
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins", message_id: "" },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  });
  assert.equal(reply.args[2], undefined, "empty message_id must not be forwarded");
}

// A4. reply_chunk calls are unchanged: four positional args, no annotation.
{
  const { sends } = await run({
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins", message_id: MESSAGE_ID },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  });
  const chunks = sends.filter((s) => s.fn === "sendReplyChunk");
  assert.ok(chunks.length > 0, "harness: expected at least one reply chunk");
  for (const c of chunks) {
    assert.equal(c.args.length, 4, `reply_chunk takes no extras (got ${JSON.stringify(c.args)})`);
    assert.ok(!c.args.includes(MESSAGE_ID), "reply_chunk must not carry the message id");
  }
}

// B. Wire payload. The channel is replaced with a recorder; no socket opens.
function recordingClient() {
  const pushes = [];
  const client = new SuiteClient(
    { url: "ws://localhost/socket", runtimeId: "test-runtime", token: "test-token" },
    { onAttention: () => {}, onToolResult: () => {}, onDisconnect: () => {} },
  );
  client.channel = {
    push: (event, payload) => {
      pushes.push({ event, payload });
      return { receive() { return this; } };
    },
  };
  return { client, pushes };
}

// B1. With extras -> the reply push carries the key.
{
  const { client, pushes } = recordingClient();
  client.sendReply(SPACE, "hi", { in_reply_to_message_id: MESSAGE_ID });
  assert.deepEqual(pushes, [
    { event: "reply", payload: { space_id: SPACE, content: "hi", in_reply_to_message_id: MESSAGE_ID } },
  ]);
}

// B2. Without extras (or with undefined values) -> only space_id + content.
{
  const { client, pushes } = recordingClient();
  client.sendReply(SPACE, "hi");
  client.sendReply(SPACE, "hi", { in_reply_to_message_id: undefined });
  for (const p of pushes) {
    assert.deepEqual(
      Object.keys(p.payload).sort(),
      ["content", "space_id"],
      `no extras -> no annotation keys on the wire (got ${JSON.stringify(p.payload)})`,
    );
  }
  assert.equal(pushes.length, 2);
}

console.log(
  "reply in_reply_to OK: signal.message_id -> sendReply extras -> reply push; absent/empty id omitted; reply_chunk unannotated",
);
