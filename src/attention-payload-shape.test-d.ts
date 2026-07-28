// Type-level assertions for `AttentionPayload` (019fa618-ca92 stage 1).
//
// WHY A TYPE TEST AND NOT A RUNTIME ONE. Widening a TypeScript interface
// changes no behaviour — types vanish at `tsc` output. A stage that only
// widened `AttentionPayload` and then observed a green `npm run build` would
// have pinned exactly nothing: the build was green before the widening too.
// So the widening ships with these assertions, which are checked by the same
// `npm run build` (`tsc -p tsconfig.json`) that is this repo's lint gate, and
// which FAIL TO COMPILE if the interface is narrowed back.
//
// They fail in both directions of the stage-1 change:
//
//   * `bareSystemEvent` omits `message` / `history` / `context` entirely.
//     Re-marking any of the three required makes this declaration error with
//     TS2739/TS2741 ("missing the following properties"). That is the half
//     that matters: `AttentionPayload` asserting `message` is always present
//     is precisely what licensed the unguarded `payload.message.author`
//     dereference at src/inbound.ts:71-72, which throws a TypeError on every
//     native `system_event` the server sends today.
//
//   * both literals name the signal-root fields the server sends. Deleting
//     any of them from the interface makes the declaration error with TS2353
//     (excess property in an object literal), because object-literal
//     assignment is excess-property-checked.
//
// NOTE ON `strict: false`. tsconfig.json sets `"strict": false`, so `tsc`
// will NOT flag `payload.message.author` even now that `message` is optional.
// Nothing here is a substitute for the runtime guard (stage 2) or the
// captured-envelope fixture (stage 5). These assertions pin the TYPE against
// silent renarrowing, and nothing more. Missing-property (TS2739/TS2741) and
// excess-property (TS2353) checks are not gated on `strict`, so they hold.

import type { AttentionPayload } from "./suite-client.js";

// 1. A NATIVE `system_event`. `Platform.Responsibilities.Router.native_reason_for/1`
//    maps `:event_topic` / `:cron` / `:webhook` -> `:system_event`, and that
//    path sends `signal` ALONE: no `message`, no `history`, no `context`.
//    This is the shape production sends and the shape the old interface said
//    was impossible.
export const bareSystemEvent: AttentionPayload = {
  signal: {
    reason: "system_event",
    responsibility_key: "memory.dreaming",
    feature: "memory",
    trigger_kind: "cron",
    agent_id: "019dc658-b64c-7deb-bad7-c34d86924e32",
    agent_slug: "higgins",
  },
};

// 2. An ORCHESTRATED dispatch. The signal root carries the lifted prompt and
//    the correlation ids (core lifts them out of `metadata` specifically so a
//    federated runtime need not dig), and the chat keys are all present.
export const orchestratedSystemEvent: AttentionPayload = {
  signal: {
    reason: "system_event",
    responsibility_key: "architecture.review_plan",
    feature: "architecture",
    trigger_kind: "event_topic",
    prompt: "Review the submitted plan.",
    project_id: "019fa618-0000-7000-a000-000000000001",
    task_id: "019fa618-ca92-78bb-b73a-c3cc04ba3973",
    plan_id: "019fa622-6c43-73d0-b526-c679153939fa",
    stage_id: "019fa622-6c44-7c75-b774-df3709d7a7fa",
    agent_slug: "higgins",
    metadata: { prompt: "Review the submitted plan." },
  },
  message: { content: "Review the submitted plan.", author: "Startup Suite" },
  history: [],
  context: {},
};

// 3. A PLAIN CHAT mention still type-checks unchanged — the widening is
//    additive, it must not have made the chat envelope illegal.
export const chatMention: AttentionPayload = {
  signal: {
    reason: "mention",
    space_id: "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55",
    message_id: "019fa618-0000-7000-a000-00000000000f",
    agent_slug: "higgins",
  },
  message: { content: "hey", author: "ryan" },
  history: [{ content: "hey", author: "ryan", role: "user" }],
  context: { space: { id: "5a7f9c31-2d64-4b08-9f12-7c3e8a1d0b55", name: "general" } },
};
