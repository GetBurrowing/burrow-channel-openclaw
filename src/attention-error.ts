import type { AttentionPayload } from "./suite-client.js";

// Diagnostic formatting for a throw out of the inbound attention handler
// (019fa618-ca92 stage 4).
//
// WHAT THIS REPLACES. The catch in `src/channel.ts` — inside the `onAttention`
// closure handed to `SuiteClient`, itself inside `gateway.startAccount` — used
// to log exactly this:
//
//     runtime.error(`startup-suite: attention handler error: ${String(err)}`)
//
// `String(err)` on an Error yields `"TypeError: Cannot read properties of
// undefined (reading 'author')"` and NOTHING ELSE: no stack, so no file and no
// line; and the line names neither the signal that arrived nor the agent it was
// meant for, so nothing correlates the failure to a dispatch. That one line was
// the entire production trace of a six-day outage in which every native
// `system_event` was swallowed and no agent ever woke. The failure was not that
// the error went unlogged — it was logged, every time — but that what got logged
// could not distinguish "one malformed payload" from "the whole system_event
// path is dead", and could not be traced back to a task.
//
// WHY A MODULE AND NOT AN INLINE TEMPLATE. The catch site is a closure inside a
// closure inside `gateway.startAccount`; reaching it from a test means standing
// up a websocket and a live gateway account. Exporting the formatter makes the
// diagnostic itself directly assertable — stage 5 imports this from
// `dist/src/attention-error.js` and pins the field set with no socket at all.
// The catch keeps only the call.
//
// THE CATCH STAYS, AND STILL DOES NOT RETHROW. An unhandled throw out of
// `onAttention` propagates through the phoenix channel callback and kills the
// socket, which turns one bad payload into a disconnect/reconnect loop for every
// space on the account. Swallowing was never the bug. Swallowing SILENTLY was.
// This module changes only what the line says.
//
// FIELDS, AND WHY EACH ONE. Every field below is chosen to answer a question
// that the old line left unanswerable:
//
//   reason              - which signal shape arrived. `system_event` vs a chat
//                         mention is the single most diagnostic bit: it is what
//                         separates "the responsibility path is broken" from
//                         "someone sent a weird message".
//   responsibility_key  - which responsibility fired. Distinguishes one bad rule
//                         from a global outage.
//   agent_slug          - who never woke up. Without it, a report of "the agent
//                         didn't respond" cannot be matched to a log line.
//   task_id / plan_id   - the correlation ids that tie the failure to the plan
//                         engine, so a stalled stage can be traced to a throw
//                         instead of being read as an agent that went quiet.
//   message key present - the discriminator for THIS class of bug. The outage
//                         was an unguarded `payload.message.author` on a payload
//                         that carries `signal` alone. `message=absent` next to
//                         a TypeError names that cause outright.
//   stack               - the file and line. `String(err)` discards it.

// Read a field without trusting the payload's shape. The formatter runs on the
// error path, where the payload is by definition something the handler could not
// process — quite possibly not the declared type, possibly not an object at all.
// A throw from inside the error formatter would restore the exact silence this
// stage exists to remove, so nothing here may dereference blindly.
function field(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// `present` iff there is a `message` object to have dereferenced. A key that is
// explicitly `null` reports `absent`: the question this field answers is "was
// there something to read `.author` off of", and for `null` the answer is no —
// it throws the same TypeError as `undefined`.
function messageKeyState(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "absent";
  const message = (payload as AttentionPayload).message;
  return message === undefined || message === null ? "absent" : "present";
}

export function formatAttentionError(err: unknown, payload: AttentionPayload): string {
  const signal =
    typeof payload === "object" && payload !== null
      ? ((payload as AttentionPayload).signal ?? undefined)
      : undefined;

  // `err.stack` already begins with the `Name: message` line, so it is a strict
  // superset of what `String(err)` produced — never both. Non-Error throws
  // (strings, plain objects, `undefined`) have no `stack`; `String(err)` is the
  // best available and must still be printed rather than dropped.
  const detail =
    typeof (err as any)?.stack === "string" && (err as any).stack.length > 0
      ? (err as any).stack
      : String(err);

  return (
    `burrow: attention handler error: ` +
    `signal=${field(signal?.reason, "unknown")} ` +
    `responsibility_key=${field(signal?.responsibility_key, "none")} ` +
    `agent_slug=${field(signal?.agent_slug, "none")} ` +
    `task_id=${field(signal?.task_id, "none")} ` +
    `plan_id=${field(signal?.plan_id, "none")} ` +
    `message=${messageKeyState(payload)}\n` +
    detail
  );
}
