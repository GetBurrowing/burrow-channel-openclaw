// Correlation ids from the signal ROOT -> the agent context (019fa618-ca92 stage 3).
//
// WHAT THIS PINS. Before this stage, NOT ONE of responsibility_key, feature,
// trigger_kind, project_id, plan_id, stage_id or task_id reached the agent. The
// finalized context was exactly 19 keys — Body / BodyForAgent / RawBody /
// CommandBody / From / To / SessionKey / AccountId / ChatType /
// ConversationLabel / SenderName / SenderId / Provider / Surface / MessageSid /
// Timestamp / OriginatingChannel / OriginatingTo / CommandAuthorized — and none
// of them is a correlation id. So this is NEW PLUMBING, not the repair of a path
// that degraded, and the assertions below have to be able to tell the difference
// between "the id arrived" and "the id is undefined on both sides".
//
// ANTI-VACUITY, three ways:
//
//   1. Every expected value is READ OUT OF the payload object that was handed to
//      the handler, never a copy-pasted literal — and each is `assert.ok`-ed
//      non-empty first, so `assert.equal(undefined, undefined)` cannot pass for
//      a value that never travelled.
//   2. The full ctx KEY SET is asserted, not just individual ids. A test that
//      checks one id says nothing about whether the other six arrived, or about
//      whether the 19 pre-existing keys survived. 19 -> 26.
//   3. The stub core DELIVERS. `dispatchReplyFromConfig` here invokes
//      `onPartialReply` and `deliver` and `onCleanup`; the obvious stub
//      (`async () => {}`) never calls any of them, which makes every assertion
//      about what the agent received pass without the agent receiving anything.
//      Case 6 asserts the callbacks actually fired, so the harness cannot
//      silently rot back into an inert stub.
//
// ROOT vs METADATA — PINNED IN BOTH DIRECTIONS (case 3). The four ids appear at
// BOTH `signal.<id>` and `signal.metadata.<id>` in the captured envelope. Poison
// metadata / keep root proves root WINS; delete root / keep metadata proves
// metadata is NEVER read. Only the second half actually pins the source: the
// first would pass against a metadata-reading handler whenever the two agree.
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
const ROUTE_KEY = "agent:ryan-home-openclaw:burrow:group:moore";

// The exact context the handler produced BEFORE this stage, measured against the
// real compiled handler rather than assumed. Frozen here so that dropping any
// pre-existing key is as loud as failing to add a new one.
const BASE_KEYS = [
  "Body",
  "BodyForAgent",
  "RawBody",
  "CommandBody",
  "From",
  "To",
  "SessionKey",
  "AccountId",
  "ChatType",
  "ConversationLabel",
  "SenderName",
  "SenderId",
  "Provider",
  "Surface",
  "MessageSid",
  "Timestamp",
  "OriginatingChannel",
  "OriginatingTo",
  "CommandAuthorized",
];

const CORRELATION_KEYS = [
  "TaskId",
  "PlanId",
  "StageId",
  "ProjectId",
  "ResponsibilityKey",
  "Feature",
  "TriggerKind",
];

assert.equal(BASE_KEYS.length, 19, "the measured pre-stage baseline is 19 keys");
assert.equal(CORRELATION_KEYS.length, 7, "this stage adds 7 correlation keys");

let captured = null;
let deliverCb = null;
let cleanupCb = null;
let delivered = 0;
let streamed = 0;
let cleaned = 0;

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
      // DELIVERS FOR REAL. The reference harness's stub is `async () => {}`,
      // which never invokes deliver or onPartialReply — copy it verbatim and the
      // whole outbound half of this file is vacuously green.
      dispatchReplyFromConfig: async ({ replyOptions }) => {
        streamed += 1;
        await replyOptions?.onPartialReply?.({ text: "streamed answer" });
        delivered += 1;
        await deliverCb?.({ text: "final answer" }, { kind: "text" });
        cleaned += 1;
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
  delivered = 0;
  streamed = 0;
  cleaned = 0;
  await handleSuiteInbound({
    payload,
    config: {},
    runtime,
    client: fakeClient,
    accountId: "default",
  });
  return { ctx: captured, sends: sends.slice(), logs: logs.slice() };
}

// Assert an id both ARRIVED and is CORRECT, where "correct" is the value read
// back out of the very object the handler was given.
function assertIdEquals(ctx, ctxKey, expected, label) {
  assert.ok(
    typeof expected === "string" && expected.length > 0,
    `${label}: the harness's own expected value for ${ctxKey} is empty — ` +
    `assert.equal(undefined, undefined) would pass and prove nothing`,
  );
  assert.ok(
    ctxKey in ctx,
    `${label}: ctx.${ctxKey} is absent entirely (ctx keys: ${Object.keys(ctx).join(",")})`,
  );
  assert.notEqual(ctx[ctxKey], undefined, `${label}: ctx.${ctxKey} must not be undefined`);
  assert.equal(
    ctx[ctxKey],
    expected,
    `${label}: ctx.${ctxKey} must be byte-equal to the value on the signal root`,
  );
}

function orchestratedPayload() {
  return {
    signal: {
      reason: "system_event",
      responsibility_key: "architecture.review_plan",
      feature: "architecture",
      trigger_kind: "event_topic",
      prompt: "Review the submitted plan and return a verdict.",
      project_id: "019fa5f0-1111-7000-a000-000000000001",
      task_id: "019fa618-ca92-78bb-b73a-c3cc04ba3973",
      plan_id: "019fa622-6c43-73d0-b526-c679153939fa",
      stage_id: "019fa622-6c44-772c-8c77-f59761e74f8d",
      agent_slug: "moore",
      // The server mirrors the ids here AND repeats the multi-kilobyte prompt.
      // Nothing in this repo may read from it.
      metadata: {
        responsibility_key: "architecture.review_plan",
        feature: "architecture",
        trigger_kind: "event_topic",
        project_id: "019fa5f0-1111-7000-a000-000000000001",
        task_id: "019fa618-ca92-78bb-b73a-c3cc04ba3973",
        plan_id: "019fa622-6c43-73d0-b526-c679153939fa",
        stage_id: "019fa622-6c44-772c-8c77-f59761e74f8d",
        prompt: "Review the submitted plan and return a verdict.",
      },
    },
    message: { content: "Review the submitted plan and return a verdict.", author: "Burrow" },
  };
}

// ---------------------------------------------------------------------------
// 1. THE IDS REACH THE AGENT, AND THEY ARE THE RIGHT ONES.
// ---------------------------------------------------------------------------
{
  const payload = orchestratedPayload();
  const { ctx } = await run(payload);
  assert.ok(ctx, "orchestrated dispatch: the agent context must have been finalized");

  const s = payload.signal;
  assertIdEquals(ctx, "TaskId", s.task_id, "orchestrated");
  assertIdEquals(ctx, "PlanId", s.plan_id, "orchestrated");
  assertIdEquals(ctx, "StageId", s.stage_id, "orchestrated");
  assertIdEquals(ctx, "ProjectId", s.project_id, "orchestrated");
  assertIdEquals(ctx, "ResponsibilityKey", s.responsibility_key, "orchestrated");
  assertIdEquals(ctx, "Feature", s.feature, "orchestrated");
  assertIdEquals(ctx, "TriggerKind", s.trigger_kind, "orchestrated");
}

// ---------------------------------------------------------------------------
// 2. THE KEY SET CHANGED, AND CHANGED BY EXACTLY THE SEVEN. Checking one id in
//    isolation would not notice six missing siblings, nor a pre-existing key
//    clobbered on the way in.
// ---------------------------------------------------------------------------
{
  const { ctx } = await run(orchestratedPayload());
  const keys = Object.keys(ctx);

  for (const k of BASE_KEYS) {
    assert.ok(k in ctx, `orchestrated: pre-existing ctx key ${k} must survive this stage`);
  }
  assert.notEqual(
    keys.length,
    BASE_KEYS.length,
    `the agent context must have GROWN past its ${BASE_KEYS.length}-key baseline — ` +
    `a context that is still ${BASE_KEYS.length} keys carries no correlation id at all`,
  );
  assert.deepEqual(
    keys.slice().sort(),
    [...BASE_KEYS, ...CORRELATION_KEYS].sort(),
    `orchestrated ctx must be exactly the ${BASE_KEYS.length} baseline keys plus the ` +
    `${CORRELATION_KEYS.length} correlation keys (got ${keys.length}: ${keys.join(",")})`,
  );
  assert.equal(keys.length, 26, "19 baseline + 7 correlation = 26");
}

// ---------------------------------------------------------------------------
// 3. ROOT, NEVER `signal.metadata` — BOTH DIRECTIONS.
//
//    This repo reads the signal ROOT. The sibling client
//    (claude-code-suite-channel) reads `signal.metadata`, and that is correct
//    THERE and wrong HERE. Both halves below exist so a "harmonising" refactor
//    that switches the source cannot stay green.
// ---------------------------------------------------------------------------
{
  // (a) metadata POISONED, root intact -> the ROOT value must win.
  const payload = orchestratedPayload();
  payload.signal.metadata.plan_id = "METADATA-SENTINEL-PLAN";
  payload.signal.metadata.stage_id = "METADATA-SENTINEL-STAGE";
  payload.signal.metadata.responsibility_key = "METADATA-SENTINEL-KEY";
  payload.signal.metadata.project_id = "METADATA-SENTINEL-PROJECT";
  payload.signal.metadata.feature = "METADATA-SENTINEL-FEATURE";
  payload.signal.metadata.trigger_kind = "METADATA-SENTINEL-TRIGGER";
  payload.signal.metadata.task_id = "METADATA-SENTINEL-TASK";

  const { ctx } = await run(payload);
  const s = payload.signal;
  assertIdEquals(ctx, "PlanId", s.plan_id, "metadata-poisoned");
  assertIdEquals(ctx, "StageId", s.stage_id, "metadata-poisoned");
  assertIdEquals(ctx, "ResponsibilityKey", s.responsibility_key, "metadata-poisoned");
  assertIdEquals(ctx, "ProjectId", s.project_id, "metadata-poisoned");
  assertIdEquals(ctx, "Feature", s.feature, "metadata-poisoned");
  assertIdEquals(ctx, "TriggerKind", s.trigger_kind, "metadata-poisoned");
  assertIdEquals(ctx, "TaskId", s.task_id, "metadata-poisoned");
  for (const [k, v] of Object.entries(ctx)) {
    assert.ok(
      !(typeof v === "string" && v.startsWith("METADATA-SENTINEL")),
      `metadata-poisoned: ctx.${k} came from signal.metadata (${v}) — the handler must read the signal root`,
    );
  }
}

{
  // (b) root DELETED, metadata intact -> the handler must emit NOTHING. This is
  //     the half that actually pins the source; (a) alone passes against a
  //     metadata-reading handler whenever root and metadata agree.
  const payload = orchestratedPayload();
  const metadataCopy = { ...payload.signal.metadata };
  delete payload.signal.plan_id;
  delete payload.signal.stage_id;
  delete payload.signal.project_id;
  delete payload.signal.responsibility_key;
  delete payload.signal.feature;
  delete payload.signal.trigger_kind;
  delete payload.signal.task_id;

  const { ctx } = await run(payload);
  for (const k of CORRELATION_KEYS) {
    assert.ok(
      !(k in ctx),
      `root-deleted: ctx.${k} must be OMITTED, not read out of signal.metadata ` +
      `(got ${JSON.stringify(ctx[k])}; metadata still holds ${JSON.stringify(metadataCopy)})`,
    );
  }
  assert.equal(
    Object.keys(ctx).length,
    BASE_KEYS.length,
    "root-deleted: with no root ids the context must fall back to exactly the baseline keys — " +
    "the ids are omitted, never emitted as undefined",
  );
}

// ---------------------------------------------------------------------------
// 4. PARTIAL ENVELOPE — the bare `memory.dreaming` shape. It carries three of
//    the seven and none of the plan-engine ids; the three must arrive and the
//    four must be absent rather than undefined-valued.
// ---------------------------------------------------------------------------
{
  const payload = {
    signal: {
      reason: "system_event",
      responsibility_key: "memory.dreaming",
      feature: "memory",
      trigger_kind: "cron",
      agent_slug: "higgins",
      agent_id: "019dc658-b64c-7deb-bad7-c34d86924e32",
    },
  };
  const { ctx } = await run(payload);
  assertIdEquals(ctx, "ResponsibilityKey", payload.signal.responsibility_key, "bare");
  assertIdEquals(ctx, "Feature", payload.signal.feature, "bare");
  assertIdEquals(ctx, "TriggerKind", payload.signal.trigger_kind, "bare");
  for (const k of ["TaskId", "PlanId", "StageId", "ProjectId"]) {
    assert.ok(
      !(k in ctx),
      `bare: ctx.${k} must be omitted rather than emitted as undefined (got ${JSON.stringify(ctx[k])})`,
    );
  }
  assert.equal(
    Object.keys(ctx).length,
    BASE_KEYS.length + 3,
    "bare envelope carries exactly 3 of the 7 correlation ids",
  );
}

// ---------------------------------------------------------------------------
// 5. THE CHAT PATH IS UNTOUCHED. A human @mention has no correlation ids, and
//    this stage must not have started decorating chat contexts with undefined.
// ---------------------------------------------------------------------------
{
  const { ctx, sends } = await run({
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins" },
    message: { content: "hey higgins", author: "ryan" },
    context: {},
  });
  assert.deepEqual(
    Object.keys(ctx).slice().sort(),
    BASE_KEYS.slice().sort(),
    `chat ctx must be exactly the ${BASE_KEYS.length} baseline keys (got ${Object.keys(ctx).join(",")})`,
  );
  assert.equal(ctx.RawBody, "hey higgins", "chat body unchanged by this stage");
  assert.ok(sends.length > 0, "chat replies must still go on the wire");
  for (const s of sends) {
    assert.equal(s.space, SPACE, `chat sends stay addressed at the real space (saw ${JSON.stringify(s)})`);
  }
}

// ---------------------------------------------------------------------------
// 6. THE HARNESS ITSELF IS NOT INERT. If `dispatchReplyFromConfig` were the
//    obvious `async () => {}` stub, cases 1-5 would still be green while the
//    agent received nothing and no send ever left. Prove the callbacks fire.
// ---------------------------------------------------------------------------
{
  await run({
    signal: { reason: "mention", space_id: SPACE, agent_slug: "higgins" },
    message: { content: "prove the stub delivers", author: "ryan" },
  });
  assert.equal(streamed, 1, "the stub core must invoke onPartialReply — an inert stub proves nothing");
  assert.equal(delivered, 1, "the stub core must invoke deliver — an inert stub proves nothing");
  assert.equal(cleaned, 1, "the stub core must invoke onCleanup — an inert stub proves nothing");
  assert.ok(
    sends.some((s) => s.fn === "sendReply" && s.text === "final answer"),
    "deliver() must have reached the fake client: the agent's answer actually went out",
  );
  assert.ok(
    sends.some((s) => s.fn === "sendReplyChunk" && s.text === "streamed answer"),
    "onPartialReply() must have reached the fake client",
  );
}

console.log(
  "signal-root correlation ids OK: 19 -> 26 ctx keys, all 7 ids present and byte-equal to the " +
  "signal ROOT, metadata never read (both directions), partial + chat envelopes unpolluted, " +
  "stub core verified live",
);

process.exit(0);
