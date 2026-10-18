// system_event envelope: body chain + phantom-addressee suppression.
//
// Covers the two runtime behaviours stage 2 changes, by driving the REAL
// compiled `handleSuiteInbound` against a stubbed OpenClaw core — the same
// technique as check-inbound-space-binding.mjs, which is this repo's reference
// harness. `handleSuiteInbound` IS the websocket entry point: src/channel.ts
// calls it from SuiteClient's `onAttention`, bound to the phoenix "attention"
// event in src/suite-client.ts.
//
// A native `system_event` (Platform.Responsibilities.Router.native_reason_for/1
// maps :event_topic / :cron / :webhook -> :system_event) sends `signal` ALONE:
// no `message`, no `history`, no `context`. Two things must hold on that shape:
//
//   1. BODY CHAIN. `message?.content` -> `signal.prompt` -> the
//      `System dispatch: <reason>` placeholder. Rung 1 is forward-compat (the
//      core change that adds `message` to a system_event is on an unmerged
//      branch); rung 2 is what fires against TODAY's production payload. Both
//      are pinned here so neither can rot: rung 1 must not regress when core
//      merges, rung 2 must not be deleted as "dead" afterwards.
//
//   2. NO PHANTOM ADDRESSEE. Fixing the `payload.message.author` TypeError makes
//      inbound.ts's `finally` reachable for the first time. On a bare envelope
//      that ran `client.sendTyping("unknown", false)`, which server-side is
//      `Repo.get_by(Participant, space_id: "unknown", ...)` against a :binary_id
//      column -> Ecto.Query.CastError -> the runtime channel process dies. With a
//      task id in that slot it is quieter but still wrong: runtime_channel.ex
//      handle_in("reply") sets NodeContext BEFORE the participant check, then
//      drops the message. So the wire sends must be gated on a real space UUID.
//
// The stub core deliberately INVOKES the deliver/onPartialReply callbacks. A
// stub that never delivers makes every "no send addressed with X" assertion
// vacuously true.
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

const SPACE = "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55";
const TASK_ID = "019fa618-ca92-78bb-b73a-c3cc04ba3973";
const ROUTE_KEY = "agent:ryan-home-openclaw:startup-suite:group:higgins";

let captured = null;
let deliverCb = null;
let cleanupCb = null;

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
      // One-word change from the reference harness: capture what the agent gets.
      finalizeInboundContext: (ctx) => {
        captured = ctx;
        return ctx;
      },
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
      // Actually exercise the outbound path so the addressee assertions below
      // are not vacuous.
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "streamed answer" });
        await deliverCb?.({ text: "final answer" }, { kind: "text" });
        cleanupCb?.();
      },
    },
  },
};

setSuiteRuntime(fakeCore);

let sends = [];
const fakeClient = {
  sendReply: (space, text) => sends.push({ fn: "sendReply", space, text }),
  sendReplyChunk: (space, id, text, done) =>
    sends.push({ fn: "sendReplyChunk", space, text, done }),
  sendTyping: (space, on) => sends.push({ fn: "sendTyping", space, on }),
  sendUsageEvent: () => {},
  sendExecutionEvent: () => {},
};

let logs = [];
const runtime = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };

async function run(payload) {
  captured = null;
  sends = [];
  logs = [];
  await handleSuiteInbound({
    payload,
    config: {},
    runtime,
    client: fakeClient,
    accountId: "default",
  });
  return { ctx: captured, sends: sends.slice(), logs: logs.slice() };
}

function assertNoPhantomAddressee(sends, label, forbidden) {
  for (const s of sends) {
    for (const bad of forbidden) {
      assert.notEqual(
        s.space,
        bad,
        `${label}: ${s.fn} must never be addressed with ${JSON.stringify(bad)} ` +
        `(saw ${JSON.stringify(s)})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. BARE ENVELOPE. The ticket's second shape: a `memory.dreaming` responsibility
//    firing with signal ALONE. This is the regression case for the TypeError at
//    inbound.ts:71 — pre-fix, `handleSuiteInbound` REJECTS here.
// ---------------------------------------------------------------------------
const bare = {
  signal: {
    reason: "system_event",
    responsibility_key: "memory.dreaming",
    feature: "memory",
    trigger_kind: "cron",
    agent_slug: "higgins",
    agent_id: "019dc658-b64c-7deb-bad7-c34d86924e32",
  },
};

await assert.doesNotReject(
  () => run(bare),
  "bare system_event envelope must not throw (inbound.ts:71 dereferenced payload.message.author unguarded)",
);

{
  const { ctx, sends } = await run(bare);
  assert.ok(ctx, "bare envelope: the agent context must have been finalized");
  assert.equal(typeof ctx.RawBody, "string", "bare envelope: RawBody must be a string");
  assert.notEqual(ctx.RawBody, "", "bare envelope: RawBody must not be empty");
  assert.equal(
    ctx.RawBody,
    "System dispatch: system_event",
    "bare envelope has no message and no signal.prompt, so the placeholder IS the correct body",
  );
  assert.equal(ctx.BodyForAgent, ctx.RawBody, "bare envelope: BodyForAgent must match RawBody");
  // Pinned because enrichedBody is `**${senderName}**: ${rawBody}` — with
  // "unknown" here the agent's prompt reads differently before and after core's
  // `message` key lands, and the two body sources stop being interchangeable.
  assert.equal(
    ctx.SenderName,
    "Burrow",
    "a dispatch with no message.author must be attributed to Burrow, not \"unknown\"",
  );

  // 2. NO PHANTOM ADDRESSEE on the bare shape. isOrchestrated === false here
  //    (no task_id), so the `finally` runs sendTyping — the exact call that
  //    would have crashed the runtime channel with space_id "unknown".
  assertNoPhantomAddressee(sends, "bare envelope", ["unknown", undefined, null, ""]);
  assert.equal(
    sends.length,
    0,
    `bare envelope has no space, so every wire send must be suppressed (saw ${JSON.stringify(sends)})`,
  );
}

// ---------------------------------------------------------------------------
// 3. RUNG 2 — signal.prompt. What TODAY's production payload carries: the server
//    lifts `prompt` to the signal root so a federated runtime need not dig into
//    metadata. No `message` key at all.
// ---------------------------------------------------------------------------
const PROMPT = "Review the architecture plan for task 019fa618 and return a verdict via plan_architecture_verdict.";
{
  const { ctx, sends } = await run({
    signal: {
      reason: "system_event",
      responsibility_key: "architecture.review_plan",
      prompt: PROMPT,
      task_id: TASK_ID,
      plan_id: "019fa622-6c43-73d0-b526-c679153939fa",
      agent_slug: "moore",
    },
  });
  assert.equal(
    ctx.RawBody,
    PROMPT,
    "signal.prompt must be rung 2 of the body chain — this is the rung that fires on deploy day",
  );
  assert.notEqual(
    ctx.RawBody,
    "System dispatch: system_event",
    "signal.prompt must win over the placeholder",
  );

  // The signal carries a task_id and no space_id. `spaceId` inside the handler
  // falls back to the task id, which IS a UUID and would insert cleanly against
  // a space that does not exist — runtime_channel.ex sets NodeContext before the
  // participant check, then drops the agent's whole answer.
  assertNoPhantomAddressee(sends, "prompt-only envelope", [TASK_ID, "unknown"]);
  assert.equal(
    sends.length,
    0,
    `a task id is not a space id: every wire send must be suppressed (saw ${JSON.stringify(sends)})`,
  );
}

// ---------------------------------------------------------------------------
// 4. RUNG 1 — message.content still wins. Forward-compat guard: when the core
//    change that adds a `message` key to system_event merges, rung 1 must take
//    precedence again, and it must not have been quietly dropped in favour of
//    the new rung 2.
// ---------------------------------------------------------------------------
{
  const { ctx } = await run({
    signal: {
      reason: "system_event",
      responsibility_key: "architecture.review_plan",
      prompt: "PROMPT-RUNG-TWO",
      agent_slug: "moore",
    },
    message: { content: "MESSAGE-RUNG-ONE", author: "Burrow" },
  });
  assert.equal(
    ctx.RawBody,
    "MESSAGE-RUNG-ONE",
    "message.content must remain rung 1 of the body chain, ahead of signal.prompt",
  );
  assert.equal(ctx.SenderName, "Burrow", "message.author must still be honoured when present");
}

// ---------------------------------------------------------------------------
// 5. THE GATE DOES NOT BREAK CHAT. A payload with a genuine space_id UUID must
//    still be replied into. Suppression is for phantom addressees only.
// ---------------------------------------------------------------------------
{
  const { ctx, sends } = await run({
    signal: {
      reason: "mention",
      space_id: SPACE,
      agent_slug: "higgins",
    },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  });
  assert.equal(ctx.RawBody, "hey higgins", "chat body unchanged");
  assert.ok(sends.length > 0, "a real space must still receive wire sends");
  for (const s of sends) {
    assert.equal(
      s.space,
      SPACE,
      `chat sends must be addressed at the real space (saw ${JSON.stringify(s)})`,
    );
  }
  assert.ok(
    sends.some((s) => s.fn === "sendReply"),
    "the agent's final reply must still be delivered on the chat path",
  );
  assert.ok(
    sends.some((s) => s.fn === "sendTyping"),
    "typing must still be cleared on the chat path",
  );
}

// ---------------------------------------------------------------------------
// 6. SUPPRESSION IS OBSERVABLE. A dropped send that logs nothing is the same
//    class of failure this whole task is about.
// ---------------------------------------------------------------------------
{
  const { logs } = await run(bare);
  assert.ok(
    logs.some((l) => l.includes("no reply space")),
    `suppressing wire sends must be logged (got ${JSON.stringify(logs)})`,
  );
}

console.log(
  "system_event body chain OK: bare -> placeholder, signal.prompt -> rung 2, " +
  "message.content -> rung 1, phantom addressees suppressed, real space unaffected",
);

process.exit(0);
