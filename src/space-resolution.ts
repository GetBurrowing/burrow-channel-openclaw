import { getTaskWorkers, spaceForSession } from "./plugin-state.js";
import { parseTaskSessionKey } from "./session-key.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Burrow stores space_id as a `:binary_id`. Anything that isn't a UUID raises
// Ecto.ChangeError server-side and takes the runtime channel process down with
// it, so nothing that fails this check may ever be sent as a space id.
export function isSpaceUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Resolve the Burrow space a session belongs to.
//
// There is deliberately NO fallback that derives a space from the session key
// string. Session keys extend OpenClaw's resolved route key
// (`agent:<agentId>:burrow:group:<peer>`) and `<peer>` is the Burrow
// agent slug — the space id is simply not in the key. Positional indexing used
// to return the slug ("higgins"), which is worse than returning nothing: it
// either crashes the channel on a non-UUID or, when the peer happens to be a
// UUID, files usage against the wrong space with no error anywhere.
//
// Unresolvable is a legitimate answer. Callers omit space_id.
export function resolveSpaceId(sessionKey?: string | null): string | undefined {
  if (!sessionKey) return undefined;

  const taskSession = parseTaskSessionKey(sessionKey);
  const candidate = taskSession
    ? getTaskWorkers().resolveExecutionSpaceId(sessionKey)
    : spaceForSession(sessionKey);

  return isSpaceUuid(candidate) ? candidate : undefined;
}
