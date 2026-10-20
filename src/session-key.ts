export type TaskPhase = "planning" | "execution" | "review" | "deploying";

// Session keys are always derived by extending the route key OpenClaw already
// resolved (`agent:<agentId>:burrow:group:<peer>`). Replacing it wholesale
// drops the `agent:<id>:` prefix that the SQLite session scope reads back to
// decide which agent's store an entry belongs to.
const TASK_MARKER = ":task:";
const DISPATCH_MARKER = ":dispatch:";

export function buildTaskSessionKey(
  base: string,
  taskId: string,
  phase: TaskPhase,
  attempt?: string | number
) {
  const key = `${base}${TASK_MARKER}${taskId}:${phase}`;
  return attempt == null ? key : `${key}:attempt:${attempt}`;
}

// One-shot dispatches (responsibilities, historian/dreaming digests, meeting
// scribe/triage) get a key that has never been used before, which is the only
// way to guarantee an empty context: OpenClaw's `/new` reset deliberately
// replays the last ~6 turns across the boundary, so resetting a shared key
// would still leak the previous firing.
export function buildDispatchSessionKey(
  base: string,
  reason: string,
  discriminator: string
) {
  return `${base}${DISPATCH_MARKER}${reason}:${discriminator}`;
}

export function parseTaskSessionKey(sessionKey?: string | null):
  | { taskId: string; phase: TaskPhase }
  | null {
  if (!sessionKey) return null;

  const at = sessionKey.indexOf(TASK_MARKER);
  if (at === -1) return null;

  const rest = sessionKey.slice(at + TASK_MARKER.length);
  const match = rest.match(/^([^:]+):(planning|execution|review|deploying)(?::.*)?$/);
  if (!match) return null;

  return { taskId: match[1]!, phase: match[2] as TaskPhase };
}
