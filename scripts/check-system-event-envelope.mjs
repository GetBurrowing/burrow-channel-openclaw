// The captured-envelope harness (019fa618-ca92 stage 5).
//
// WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER HAND-WRITTEN PAYLOAD. The defect
// this task closes was six days of silence in which every native `system_event`
// was dropped, and it survived because the tests around the handler fed it the
// shape the handler expected instead of the shape the server sends. Careful,
// green, and blind. So the two payloads below are not typed out here: they are
// read from `scripts/fixtures/*.json`, which are byte-verbatim captures of live
// firings (see that directory's README, including the honest caveat that the
// 13325-byte prompt is elided — no assertion here is a length assertion).
//
// WHAT IT DRIVES. The COMPILED `handleSuiteInbound` from `dist/`, with a stubbed
// OpenClaw core installed via `setSuiteRuntime` — the same technique as
// `check-inbound-space-binding.mjs`, this repo's reference harness.
// `handleSuiteInbound` IS the websocket entry point: `src/channel.ts:752` calls
// it from `SuiteClient`'s `onAttention`, which `src/suite-client.ts:357-369`
// binds to the phoenix `"attention"` event. Nothing is re-implemented here.
//
// ANTI-VACUITY. Three habits, all load-bearing:
//
//   1. Every expected value is READ OUT OF the parsed fixture, never a literal
//      retyped into this file. `assert.equal(undefined, undefined)` is the
//      failure mode; `assertIdEquals` refuses an empty expectation outright.
//   2. The stub core DELIVERS. The reference harness's `dispatchReplyFromConfig`
//      is `async () => {}` and invokes neither `deliver` nor `onPartialReply` —
//      copy it verbatim and every "no send was addressed with X" assertion below
//      is true because nothing was ever sent at all. Case 7 pins the stub live.
//   3. Each mutation in the stage's detonation table was applied alone and the
//      suite verified red. A mutation that stays green means the assertion is
//      vacuous, not that the mutation is uninteresting.
//
// ATTRIBUTING A DETONATION TO ONE CASE. Set `ENVELOPE_CASE=<n>` to run a single
// case. Unset (the default, and what `npm test` runs) executes all seven. This
// exists because some mutations trip more than one case — M1's TypeError, for
// instance, is raised by case 1(b) before case 4 is reached — and the table in
// the PR body is only useful if each row names the case it was measured on.
//
// Loads the COMPILED files from dist/. Run `npm run build` first. `npm test`
// does NOT rebuild: a mutation loop that edits src and re-runs `npm test` alone
// is testing the PREVIOUS build. Always `npm run build && npm test`.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

function distUrl(...segments) {
  const file = path.join(repoRoot, "dist", ...segments);
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` first.`);
    process.exit(1);
  }
  return pathToFileURL(file).href;
}

function loadFixture(name) {
  const file = path.join(repoRoot, "scripts", "fixtures", name);
  if (!existsSync(file)) {
    console.error(`Missing fixture ${file}.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

const { handleSuiteInbound } = await import(distUrl("src", "inbound.js"));
const { setSuiteRuntime } = await import(distUrl("src", "runtime.js"));
const { formatAttentionError } = await import(distUrl("src", "attention-error.js"));

// The captures. Re-read (not shared by reference) per case so a case that
// poisons or deletes a key cannot leak into the next one.
const REVIEW_PLAN = "system-event-architecture-review-plan.json";
const BARE = "system-event-bare.json";

const PLACEHOLDER = "System dispatch: system_event";
const ROUTE_KEY = "agent:ryan-home-openclaw:startup-suite:group:moore";
// Used only by case 7, which needs a signal that is ALLOWED to reach the wire.
// Neither fixture has a space_id — that is the point of case 5.
const REAL_SPACE = "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55";

const ONLY = process.env.ENVELOPE_CASE || null;
const ran = [];
async function testCase(n, label, fn) {
  if (ONLY !== null && ONLY !== String(n)) return;
  ran.push(String(n));
  await fn(label);
}

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
      // The one-word change that makes the object handed to the agent
      // observable. The reference harness already passes ctx through; this only
      // keeps a reference to it.
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
      // DELIVERS FOR REAL — see anti-vacuity note 2 at the top of this file.
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

function reset() {
  captured = null;
  sends = [];
  logs = [];
  delivered = 0;
  streamed = 0;
  cleaned = 0;
}

function invoke(payload) {
  return handleSuiteInbound({
    payload,
    config: {},
    runtime,
    client: fakeClient,
    accountId: "default",
  });
}

// Drive the handler and fail with a case-labelled message if it throws. A raw
// rejection out of an ESM top-level await prints an unlabelled stack, which is
// exactly the unreadable failure this whole task is about.
async function run(payload, label) {
  reset();
  try {
    await invoke(payload);
  } catch (err) {
    assert.fail(`${label}: handler threw ${err && err.stack ? err.stack : String(err)}`);
  }
  return {
    ctx: captured,
    sends: sends.slice(),
    logs: logs.slice(),
    counters: { delivered, streamed, cleaned },
  };
}

// Assert an id both ARRIVED and is CORRECT, where "correct" is the value read
// back out of the parsed fixture rather than a literal retyped here.
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
    `${label}: ctx.${ctxKey} must be byte-equal to the value on the signal ROOT of the capture`,
  );
}

// The body assertions that survive the prompt elision. Deliberately NOT a length
// equality — see scripts/fixtures/README.md.
function assertRealBody(ctx, expected, label) {
  assert.ok(ctx, `${label}: the agent context must have been finalized — the handler produced none`);
  for (const key of ["RawBody", "BodyForAgent"]) {
    const value = ctx[key];
    assert.notEqual(value, undefined, `${label}: ctx.${key} must not be undefined`);
    assert.equal(typeof value, "string", `${label}: ctx.${key} must be a string (got ${typeof value})`);
    assert.notEqual(value, "", `${label}: ctx.${key} must not be the empty string`);
    assert.notEqual(
      value,
      PLACEHOLDER,
      `${label}: ctx.${key} is the "${PLACEHOLDER}" placeholder — the rendered prompt was on the ` +
      `wire and the handler substituted a constant for it, which is the original defect`,
    );
    assert.ok(
      value.length > 200,
      `${label}: ctx.${key} is only ${value.length} bytes; the captured prompt is far longer, ` +
      `so a short body means a placeholder or a truncation, not the real thing`,
    );
    assert.equal(value, expected, `${label}: ctx.${key} must be byte-equal to the captured prompt`);
  }
}

// ---------------------------------------------------------------------------
// 1. HAPPY PATH — the real capture, both rungs of the body chain.
//
//    (a) is the shape core sends once the `message` key lands (rung 1).
//    (b) is TODAY's production shape — `message` absent, prompt at the signal
//        root (rung 2). Rung 2 is the one that fires on deploy day, so a happy
//        path that only exercises (a) would ship green against a handler that
//        never reads `signal.prompt` at all.
// ---------------------------------------------------------------------------
await testCase(1, "happy-path", async (label) => {
  const fixture = loadFixture(REVIEW_PLAN);

  // The fixture itself is the thing that licenses rung 2: the fallback is only
  // safe because the two sources are the same bytes. Pin it here so a future
  // recapture that breaks the equality fails loudly instead of quietly changing
  // what "fall back to signal.prompt" means.
  assert.equal(
    fixture.message.content,
    fixture.signal.prompt,
    "capture: message.content must be byte-equal to signal.prompt — that equality is what makes " +
    "the signal.prompt fallback in src/inbound.ts equivalent rather than merely adequate",
  );
  assert.ok(
    fixture.signal.prompt.length > 200,
    "capture: the elided prompt must still be substantial; a stub prompt makes case 1 vacuous",
  );

  // (a) rung 1 — message.content present.
  {
    const { ctx } = await run(structuredClone(fixture), `${label}/message.content`);
    assertRealBody(ctx, fixture.message.content, `${label}/message.content`);
    assert.equal(
      ctx.RawBody,
      fixture.signal.prompt,
      `${label}/message.content: the body must equal signal.prompt too — the capture's two ` +
      `sources agree, so a body matching only one of them means the handler mangled it`,
    );
    assert.ok(
      ctx.Body.includes(fixture.signal.prompt),
      `${label}/message.content: the enriched envelope handed to the agent must carry the prompt`,
    );
  }

  // (b) rung 2 — `message` stripped, exactly as production sends it today.
  {
    const stripped = structuredClone(fixture);
    delete stripped.message;
    delete stripped.history;
    delete stripped.context;

    const { ctx } = await run(stripped, `${label}/signal.prompt`);
    assertRealBody(ctx, fixture.signal.prompt, `${label}/signal.prompt`);
    assert.equal(
      ctx.SenderName,
      "Startup Suite",
      `${label}/signal.prompt: with no message.author the sender must default to "Startup Suite" ` +
      `so the agent's prompt reads identically before and after core's message key lands`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. CORRELATION IDS — all seven, each compared against the parsed capture.
// ---------------------------------------------------------------------------
await testCase(2, "correlation-ids", async (label) => {
  const fixture = loadFixture(REVIEW_PLAN);
  const { ctx } = await run(structuredClone(fixture), label);
  assert.ok(ctx, `${label}: the agent context must have been finalized`);

  const s = fixture.signal;
  assertIdEquals(ctx, "PlanId", s.plan_id, label);
  assertIdEquals(ctx, "TaskId", s.task_id, label);
  assertIdEquals(ctx, "StageId", s.stage_id, label);
  assertIdEquals(ctx, "ProjectId", s.project_id, label);
  assertIdEquals(ctx, "ResponsibilityKey", s.responsibility_key, label);
  assertIdEquals(ctx, "Feature", s.feature, label);
  assertIdEquals(ctx, "TriggerKind", s.trigger_kind, label);
});

// ---------------------------------------------------------------------------
// 3. ROOT vs `signal.metadata` — BOTH DIRECTIONS.
//
//    The capture carries every id twice. (a) proves root WINS; (b) proves
//    metadata is NEVER read. Only (b) actually pins the source — (a) alone
//    passes against a metadata-reading handler whenever the two copies agree,
//    which on a real capture is always. (b) is also the half that catches the
//    plausible "harmonise with the sibling client" refactor
//    `signal?.plan_id ?? metadata.plan_id`, which survives (a) untouched.
//
//    The two halves are separately addressable (`ENVELOPE_CASE=3a` / `3b`)
//    because (a) trips first when both would fail, and a detonation table that
//    cannot name which half fired does not demonstrate that (b) is load-bearing.
// ---------------------------------------------------------------------------

// (a) metadata POISONED, root intact.
await testCase("3a", "root-vs-metadata", async (label) => {
  {
    const fixture = loadFixture(REVIEW_PLAN);
    for (const key of [
      "plan_id",
      "task_id",
      "stage_id",
      "project_id",
      "responsibility_key",
      "feature",
      "trigger_kind",
    ]) {
      fixture.signal.metadata[key] = `METADATA-SENTINEL-${key.toUpperCase()}`;
    }

    const { ctx } = await run(fixture, `${label}/metadata-poisoned`);
    const s = loadFixture(REVIEW_PLAN).signal;
    assertIdEquals(ctx, "PlanId", s.plan_id, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "TaskId", s.task_id, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "StageId", s.stage_id, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "ProjectId", s.project_id, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "ResponsibilityKey", s.responsibility_key, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "Feature", s.feature, `${label}/metadata-poisoned`);
    assertIdEquals(ctx, "TriggerKind", s.trigger_kind, `${label}/metadata-poisoned`);
    for (const [k, v] of Object.entries(ctx)) {
      assert.ok(
        !(typeof v === "string" && v.startsWith("METADATA-SENTINEL")),
        `${label}/metadata-poisoned: ctx.${k} came from signal.metadata (${v}) — ` +
        `src/inbound.ts must read the signal ROOT`,
      );
    }
  }
});

// (b) root DELETED, metadata intact -> the ids must be OMITTED.
await testCase("3b", "root-vs-metadata", async (label) => {
  {
    const fixture = loadFixture(REVIEW_PLAN);
    const metadataCopy = { ...fixture.signal.metadata };
    delete fixture.signal.plan_id;
    delete fixture.signal.task_id;
    delete fixture.signal.stage_id;
    delete fixture.signal.project_id;
    delete fixture.signal.responsibility_key;
    delete fixture.signal.feature;
    delete fixture.signal.trigger_kind;

    const { ctx } = await run(fixture, `${label}/root-deleted`);
    for (const k of [
      "PlanId",
      "TaskId",
      "StageId",
      "ProjectId",
      "ResponsibilityKey",
      "Feature",
      "TriggerKind",
    ]) {
      assert.ok(
        !(k in ctx),
        `${label}/root-deleted: ctx.${k} must be OMITTED, not read out of signal.metadata ` +
        `(got ${JSON.stringify(ctx[k])}; metadata still holds ` +
        `${JSON.stringify(metadataCopy[k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()])})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. BARE ENVELOPE — the regression case for the TypeError at inbound.ts.
//
//    `payload.message` is absent entirely. The unguarded `payload.message.author`
//    threw before the handler's own try/catch was even entered, and
//    src/channel.ts flattened it to one generic line. Here the placeholder IS
//    the correct body: this envelope genuinely carries no prompt.
// ---------------------------------------------------------------------------
await testCase(4, "bare-envelope", async (label) => {
  const fixture = loadFixture(BARE);
  reset();

  await assert.doesNotReject(
    () => invoke(structuredClone(fixture)),
    `${label}: a native system_event with no message/history/context must not throw — ` +
    `this is the exact envelope whose TypeError was swallowed into one log line`,
  );

  const ctx = captured;
  assert.ok(ctx, `${label}: the agent context must have been finalized — the agent has to WAKE`);
  assert.equal(
    ctx.RawBody,
    PLACEHOLDER,
    `${label}: with no message.content and no signal.prompt the placeholder is the correct body ` +
    `(got ${JSON.stringify(ctx.RawBody)})`,
  );
  assert.equal(ctx.BodyForAgent, PLACEHOLDER, `${label}: BodyForAgent must match RawBody`);
  assertIdEquals(ctx, "ResponsibilityKey", fixture.signal.responsibility_key, label);
  assertIdEquals(ctx, "Feature", fixture.signal.feature, label);
  assertIdEquals(ctx, "TriggerKind", fixture.signal.trigger_kind, label);
});

// ---------------------------------------------------------------------------
// 5. NO PHANTOM ADDRESSEE. Neither capture has a `space_id`, at the root or in
//    metadata — a responsibility firing has no chat room BY DESIGN. Server-side,
//    `runtime_channel.ex handle_in("reply", ...)` calls `NodeContext.set_space`
//    BEFORE the participant check, so a task id here poisons NodeContext and
//    DROPS the agent's answer; `"unknown"` is worse, raising Ecto.Query.CastError
//    against a :binary_id column and taking the channel process down.
//
//    The counters assertion is what stops this being vacuous: with an inert stub
//    nothing is ever sent, and "no send was addressed with X" is true for free.
// ---------------------------------------------------------------------------
await testCase(5, "no-phantom-addressee", async (label) => {
  for (const [name, file] of [["review-plan", REVIEW_PLAN], ["bare", BARE]]) {
    const fixture = loadFixture(file);
    assert.equal(
      fixture.signal.space_id,
      undefined,
      `${label}/${name}: the capture must have no root space_id, or this case proves nothing`,
    );
    assert.equal(
      fixture.signal.metadata?.space_id,
      undefined,
      `${label}/${name}: the capture must have no space_id in metadata either`,
    );

    const { sends: observed, logs: observedLogs, counters } = await run(
      structuredClone(fixture),
      `${label}/${name}`,
    );

    assert.ok(
      counters.delivered > 0 && counters.streamed > 0,
      `${label}/${name}: the stub core must have attempted a reply (streamed=${counters.streamed}, ` +
      `delivered=${counters.delivered}) — with nothing attempted, every assertion below is vacuous`,
    );

    const forbidden = [fixture.signal.task_id, "unknown"].filter(Boolean);
    for (const send of observed) {
      for (const bad of forbidden) {
        assert.notEqual(
          send.space,
          bad,
          `${label}/${name}: ${send.fn} went on the wire addressed to ${JSON.stringify(bad)} — ` +
          `that is not a space id (saw ${JSON.stringify(send)})`,
        );
      }
    }
    assert.deepEqual(
      observed,
      [],
      `${label}/${name}: with no real space id NOTHING may reach the wire (saw ` +
      `${JSON.stringify(observed)})`,
    );
    assert.ok(
      observedLogs.some((l) => l.includes("[suite-inbound] no reply space for signal=")),
      `${label}/${name}: suppressing the send must be logged, or the drop is silent again ` +
      `(logs: ${JSON.stringify(observedLogs)})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. ERROR FORMATTING. `formatAttentionError` is what src/channel.ts's catch now
//    logs. This is the first committed coverage of it — stage 4 shipped it
//    verified only by direct execution.
// ---------------------------------------------------------------------------
await testCase(6, "attention-error", async (label) => {
  const fixture = loadFixture(REVIEW_PLAN);

  // A genuinely thrown Error, so `stack` is real rather than assigned.
  let thrown;
  try {
    // eslint-disable-next-line no-undef
    undefined.author;
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof TypeError, `${label}: the harness must have captured a real throw`);

  const out = formatAttentionError(thrown, fixture);

  assert.match(out, /\n\s+at /, `${label}: the stack must survive — String(err) discarding it is ` +
    `the entire reason this module exists (got ${JSON.stringify(out)})`);
  assert.ok(
    out.length > String(thrown).length,
    `${label}: the formatted line must carry more than String(err) did`,
  );
  for (const [field, value] of [
    ["signal", fixture.signal.reason],
    ["responsibility_key", fixture.signal.responsibility_key],
    ["agent_slug", fixture.signal.agent_slug],
    ["task_id", fixture.signal.task_id],
    ["plan_id", fixture.signal.plan_id],
  ]) {
    assert.ok(
      typeof value === "string" && value.length > 0,
      `${label}: the capture's ${field} is empty, so asserting on it would prove nothing`,
    );
    assert.ok(
      out.includes(`${field}=${value}`),
      `${label}: the log line must name ${field}=${value} (got ${JSON.stringify(out)})`,
    );
  }
  assert.ok(out.includes("message=present"), `${label}: the capture HAS a message key`);

  // The bare envelope is the shape whose missing `message` key caused the
  // TypeError; the diagnostic has to say so.
  assert.ok(
    formatAttentionError(thrown, loadFixture(BARE)).includes("message=absent"),
    `${label}: a payload with no message key must be reported as message=absent — that field is ` +
    `the discriminator for this whole class of bug`,
  );

  // HOSTILE INPUT. The formatter runs on the error path, where the payload is by
  // definition something the handler could not process. A throw from inside the
  // formatter restores exactly the silence stage 4 removed.
  assert.doesNotThrow(
    () => formatAttentionError(null, undefined),
    `${label}: the formatter must survive a payload it cannot read`,
  );
  const hostile = formatAttentionError(null, undefined);
  assert.ok(
    hostile.includes("signal=unknown") && hostile.includes("message=absent"),
    `${label}: hostile input must degrade to named fallbacks, not blanks (got ${JSON.stringify(hostile)})`,
  );
  // A non-Error throw has no stack; String(err) is then the best available and
  // must still be printed rather than dropped.
  assert.ok(
    formatAttentionError("plain string failure", fixture).includes("plain string failure"),
    `${label}: a non-Error throw must still have its detail printed`,
  );
});

// ---------------------------------------------------------------------------
// 7. THE HARNESS ITSELF IS NOT INERT.
//
//    The reference harness this file mirrors stubs `dispatchReplyFromConfig` as
//    `async () => {}`, which invokes neither `deliver` nor `onPartialReply`.
//    Copied verbatim, case 5 would pass against ANY handler, including one that
//    addresses every reply to "unknown", because nothing would ever be sent.
//    Drive a signal that IS allowed on the wire and prove the traffic is real.
// ---------------------------------------------------------------------------
await testCase(7, "harness-liveness", async (label) => {
  const { sends: observed, counters } = await run(
    {
      signal: { reason: "mention", space_id: REAL_SPACE, agent_slug: "moore" },
      message: { content: "prove the stub delivers", author: "ryan" },
      context: {},
    },
    label,
  );

  assert.equal(counters.streamed, 1, `${label}: the stub must invoke onPartialReply`);
  assert.equal(counters.delivered, 1, `${label}: the stub must invoke deliver`);
  assert.equal(counters.cleaned, 1, `${label}: the stub must invoke onCleanup`);
  assert.ok(
    observed.some((s) => s.fn === "sendReply" && s.text === "final answer"),
    `${label}: deliver() must reach the fake client (saw ${JSON.stringify(observed)})`,
  );
  assert.ok(
    observed.some((s) => s.fn === "sendReplyChunk" && s.text === "streamed answer"),
    `${label}: onPartialReply() must reach the fake client (saw ${JSON.stringify(observed)})`,
  );
  for (const s of observed) {
    assert.equal(
      s.space,
      REAL_SPACE,
      `${label}: a genuine space id must still be addressed normally (saw ${JSON.stringify(s)})`,
    );
  }
});

console.log(
  ONLY !== null
    ? `captured system_event envelope: case ${ONLY} only (detonation run) — OK`
    : `captured system_event envelope OK: cases ${ran.join(",")} — real capture through the real ` +
      `handler; rung 1 + rung 2 bodies byte-equal to the capture, 7 correlation ids from the ` +
      `signal ROOT (metadata never read, both directions), bare envelope does not throw and ` +
      `placeholders correctly, no phantom addressee reached the wire, attention error names the ` +
      `signal + stack, stub core verified live`,
);

process.exit(0);
