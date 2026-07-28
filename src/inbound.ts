import { type OpenClawConfig, type RuntimeEnv } from "./runtime-api.js";
import { getSuiteRuntime } from "./runtime.js";
import { getTaskWorkers, rememberSessionSpace, resolveAccountOptions, setSessionContext, setSessionOptions } from "./plugin-state.js";
import { buildDispatchSessionKey, buildTaskSessionKey, type TaskPhase } from "./session-key.js";
import { isSpaceUuid } from "./space-resolution.js";
import type { AttentionPayload } from "./suite-client.js";
import type { SuiteClient } from "./suite-client.js";

const CHANNEL_ID = "startup-suite";

// Reasons that represent an ongoing human conversation — these share one
// session per space so the agent keeps its thread. Mirrors `@routable_reasons`
// in Suite's `Platform.Chat.AgentResponder`. Every other reason that reaches a
// runtime (`task_assigned`, `system_event`, `meeting_scribe_completion`,
// `meeting_triage_dispatch`) is an automated unit of work and runs isolated.
//
// Caveat: a responsibility with `trigger_kind: :chat_pattern` is emitted as
// `:mention`, indistinguishable from a human @mention until Suite forwards the
// responsibility metadata it currently drops in `build_external_signal/3`.
const CONVERSATIONAL_REASONS = new Set([
  "mention",
  "directed",
  "multi_mention",
  "active_agent",
  "watch",
  "sticky",
]);

export async function handleSuiteInbound(params: {
  payload: AttentionPayload;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  client: SuiteClient;
  accountId: string;
}): Promise<void> {
  const { payload, config, runtime, client, accountId } = params;
  const core = getSuiteRuntime();

  const taskId = payload.signal?.task_id;
  const taskStatus = payload.signal?.task_status;
  const signalReason = payload.signal?.reason;
  const isLifecycleSignal = !!(
    signalReason &&
    (signalReason === "task_assigned" || signalReason === "task_heartbeat")
  );

  // Classify by reason, not by the presence of task_id. Only the TaskRouter
  // sets task_id, so a task_id test files responsibility firings, historian /
  // dreaming digests and meeting scribe/triage dispatches under "chat" — where
  // they append to the space's permanent session until it can no longer be
  // compacted. Conversation shares a session; every dispatch gets its own.
  const isConversational = CONVERSATIONAL_REASONS.has(signalReason ?? "");
  const isDispatch = !isConversational;
  const isOrchestrated = !!taskId;

  // Meeting scribe/triage payloads carry no `message` key at all, so bailing on
  // an empty body meant those dispatches never reached the agent.
  //
  // Three rungs, in order. BOTH of the first two are load-bearing; neither may
  // be removed as redundant:
  //   1. `message.content` — the chat path, and (once the core change that adds
  //      a `message` key to a native `system_event` merges) the responsibility
  //      path too. Forward-compat: this must not regress when core lands.
  //   2. `signal.prompt` — what TODAY's production `system_event` carries. The
  //      server lifts the prompt to the signal root specifically so a federated
  //      runtime need not dig into `signal.metadata`. This is the rung that
  //      actually fires on deploy day; it must not later be deleted as "dead"
  //      once rung 1 starts firing.
  //   3. the placeholder — a dispatch that genuinely carries no body at all.
  const incomingBody = payload.message?.content?.trim() ?? "";
  const promptBody = payload.signal?.prompt?.trim() ?? "";
  const rawBody =
    incomingBody ||
    promptBody ||
    (isDispatch ? `System dispatch: ${signalReason ?? "unknown"}` : "");
  if (!rawBody) {
    runtime.log(`[suite-inbound] empty message body, signal=${payload.signal?.reason} task=${payload.signal?.task_id}`);
    return;
  }

  // For orchestrated signals, the signal.space_id is the execution space which
  // isn't in the agent's routing config. Use the execution space for replies but
  // route via a synthetic peer so the default agent binding resolves correctly.
  const spaceId = payload.signal?.space_id || payload.signal?.task_id || "unknown";

  // The ONLY address that may go on the wire. `spaceId` above is a local
  // discriminator: it legitimately falls back to the task id for session keys
  // and in-process maps, but a task id is NOT a space id and "unknown" is not
  // even a UUID. Server-side, `runtime_channel.ex handle_in("reply", ...)` calls
  // `NodeContext.set_space(agent_id, space_id)` BEFORE the participant check,
  // then pushes "Agent is not a participant in this space" and DROPS the
  // message — so a task id here discards the agent's entire answer and poisons
  // NodeContext. `"unknown"` is worse: `Repo.get_by(Participant, space_id:
  // "unknown", ...)` against a `:binary_id` column raises Ecto.Query.CastError
  // and takes the runtime channel process down.
  //
  // This gate generalises to the outbound path the discipline already applied
  // to the session<->space binding below ("Only a genuine `signal.space_id`
  // counts"). A responsibility firing has no chat space BY DESIGN — the agent
  // acts through MCP tools rather than replying into a room — so suppressing
  // the send is correct behaviour, not degradation.
  const replySpaceId = isSpaceUuid(payload.signal?.space_id)
    ? payload.signal.space_id!
    : null;
  let suppressedSendLogged = false;
  const noReplySpace = () => {
    if (suppressedSendLogged) return;
    suppressedSendLogged = true;
    runtime.log(
      `[suite-inbound] no reply space for signal=${signalReason ?? "unknown"} ` +
      `task=${taskId ?? "none"}; suppressing wire sends (would have addressed ${spaceId})`
    );
  };

  // `payload.message` is absent entirely on a native `system_event`. This
  // dereference used to be unguarded and threw
  // `TypeError: Cannot read properties of undefined (reading 'author')`
  // before the try/catch below was ever entered, which src/channel.ts flattened
  // to a single `attention handler error` line: the agent never woke.
  //
  // "Startup Suite" rather than "unknown" is load-bearing, not cosmetic:
  // `enrichedBody` below is `**${senderName}**: ${rawBody}`, and the server's
  // own chat-path payload carries `message.author == "Startup Suite"`. Matching
  // it keeps the two body sources interchangeable, so the agent's prompt reads
  // identically before and after core's `message` key lands.
  const author = payload.message?.author;
  const fallbackSender = isLifecycleSignal
    ? "TaskRouter"
    : isDispatch
      ? "Startup Suite"
      : "unknown";
  const senderId = author || fallbackSender;
  const senderName = author || fallbackSender;
  const isGroup = true;

  // Resolve agent route. Prefer the Suite agent identifier when Suite packs it
  // into the signal (newer Suite builds) — that lets per-agent peer bindings
  // target specific OpenClaw agents instead of falling through to the channel
  // default. Fall back to "orchestration" (orchestrated signals) or the spaceId
  // (plain chat) on older Suite builds that don't carry agent identity.
  const signalAgentPeer = payload.signal?.agent_slug || payload.signal?.agent_id;
  const routePeerId = signalAgentPeer ?? (isOrchestrated ? "orchestration" : spaceId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    peer: {
      kind: "group",
      id: routePeerId,
    },
  });

  // Store spaceId to accountId mapping for tools
  const { rememberSpaceAccount } = await import("./plugin-state.js");
  rememberSpaceAccount(spaceId, accountId);

  // Space-scope the session key: when routing uses the Suite agent identity
  // as the peer (so the same OpenClaw agent handles the agent across every
  // space), the resolved session key collapses all spaces into one session,
  // causing context bleed between rooms. Append the space_id to keep per-
  // space history isolated while preserving the agent-selection routing.
  // For task-orchestrated signals the sessionKey is already task-scoped
  // below (buildTaskSessionKey), so skip here; task sessions re-isolate.
  // Guard against double-appending: when the resolved peer already is the space
  // the key ends in that id, and appending again minted a second parallel
  // session for the same room (both forms are present in the live store).
  //
  // NOTE: never assign back onto `route`. OpenClaw memoizes resolved routes per
  // config, so mutating the returned object persists the override into the cache
  // and the *next* signal inherits it — which is how a chat message ended up
  // routed into `…:dispatch:system_event:<ts>:<spaceId>`. All session-key
  // derivation below works on locals and `route` is left untouched.
  let conversationSessionKey = route.sessionKey;

  if (
    !isOrchestrated &&
    signalAgentPeer &&
    spaceId &&
    spaceId !== "unknown" &&
    !conversationSessionKey.endsWith(`:${spaceId}`)
  ) {
    conversationSessionKey = `${conversationSessionKey}:${spaceId}`;
  }

  // The key this turn actually runs under. Diverges from
  // `conversationSessionKey` for task and dispatch signals.
  let sessionKey = conversationSessionKey;

  runtime.log(
    `[suite-inbound] reason=${signalReason || "chat"} task=${taskId || "none"} ` +
    `space=${spaceId} orchestrated=${isOrchestrated}`
  );

  // Simple enriched body - context is now injected via OpenClaw hooks
  const enrichedBody = `**${senderName}**: ${rawBody}`;

  function resolveTaskPhase(reason: string, status?: string): TaskPhase {
    if (reason === "task_assigned" && status === "planning") return "planning";
    if (status === "in_review") return "review";
    if (status === "deploying") return "deploying";
    return "execution";
  }

  const phase = isOrchestrated && taskId ? resolveTaskPhase(signalReason!, taskStatus) : null;

  // Override session key for orchestrated task signals — isolates context per task per phase.
  // If a prior run for the same task/phase blocked or failed, ensureWorker may freshen
  // the session key so retries get a clean agent context instead of reusing poisoned state.
  if (phase && taskId) {
    const workers = getTaskWorkers();
    const requestedKey =
      phase === "review"
        ? buildTaskSessionKey(conversationSessionKey, taskId, phase, Date.now())
        : buildTaskSessionKey(conversationSessionKey, taskId, phase);

    let worker = workers.ensureWorker({
      taskId,
      phase,
      executionSpaceId: spaceId,
      sessionKey: requestedKey,
    });

    if (phase === "review" && signalReason === "task_assigned") {
      worker = workers.forceFreshSession(taskId, phase, requestedKey) ?? worker;
    }

    sessionKey = worker.sessionKey;
    runtime.log(
      `[suite-inbound] task-route override: task=${taskId} phase=${phase} requested=${requestedKey} worker=${worker.sessionKey}`
    );

    if (signalReason === "task_heartbeat") {
      workers.noteHeartbeat(taskId, phase, "heartbeat acknowledged", {
        sessionKey,
      });
    }
  } else if (isDispatch) {
    // Non-task dispatches are one-shot: responsibilities, historian and
    // dreaming digests, meeting scribe/triage. Each firing gets a key that has
    // never been used, which is the only way to get a genuinely empty context —
    // OpenClaw's `/new` reset replays the last ~6 turns across the boundary, so
    // resetting a shared key would still carry the previous run's tail.
    //
    // Prefer message_id so a reconnect redelivery lands in the same session
    // rather than spawning a duplicate run. Suite does not forward message_id
    // on the chat path today, so most dispatches fall back to arrival time.
    const discriminator =
      payload.signal?.message_id ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    sessionKey = buildDispatchSessionKey(
      conversationSessionKey,
      signalReason ?? "dispatch",
      discriminator
    );

    runtime.log(
      `[suite-inbound] dispatch-route override: reason=${signalReason} space=${spaceId} ` +
      `session=${sessionKey} keyed_by=${payload.signal?.message_id ? "message_id" : "arrival"}`
    );
  }

  // Registered only after every session-key override above: the
  // `before_prompt_build` hook looks these up by the *final* session key, so
  // registering earlier filed the context under the pre-override key and the
  // preamble silently went missing on task and dispatch runs.
  setSessionContext(sessionKey, payload.context);
  setSessionOptions(sessionKey, resolveAccountOptions(config, accountId));

  // Bind the session to its space explicitly. The space id is NOT recoverable
  // from the session key — the route peer is the Suite agent slug — so usage
  // events and anything else that needs the space read it back from this map.
  // Only a genuine `signal.space_id` counts: `spaceId` above falls back to the
  // task id, which is a UUID and would insert cleanly under the wrong space.
  const signalSpaceId = payload.signal?.space_id;
  if (isSpaceUuid(signalSpaceId)) {
    rememberSessionSpace(sessionKey, signalSpaceId);
    // The room's own session outlives one-shot dispatch/task keys and stays the
    // last-route target, so bind it too.
    if (conversationSessionKey !== sessionKey) {
      rememberSessionSpace(conversationSessionKey, signalSpaceId);
    }
  } else {
    runtime.log(
      `[suite-inbound] no usable space_id on signal (got ${JSON.stringify(signalSpaceId)}); ` +
      `usage events for session=${sessionKey} will omit space_id`
    );
  }

  runtime.log(
    `[suite-inbound] resolved route: agent=${route.agentId} session=${sessionKey}`
  );

  // Build envelope
  const fromLabel = senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Startup Suite",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  // Correlation ids, read from the SIGNAL ROOT.
  //
  // NEW PLUMBING, NOT A REPAIR. Measured against the real handler before this
  // change, the finalized context was exactly 19 keys and not one of them was a
  // correlation id: `responsibility_key`, `feature`, `trigger_kind`,
  // `project_id`, `plan_id` and `stage_id` reached the agent NOT AT ALL, and
  // `task_id` was in scope at the top of this function but never forwarded. A
  // dispatched agent therefore had to re-derive the plan it was woken for.
  //
  // RULING — READ THE ROOT, NEVER `signal.metadata`. The ids appear in BOTH
  // places on the wire. Root wins here because:
  //   * root is the lift core added specifically so a federated runtime need
  //     not dig into metadata;
  //   * `signal.metadata` ALSO carries the full (multi-kilobyte) prompt, so
  //     anything that forwards metadata drags the payload around with it;
  //   * every other field this inbound path reads is already root-only
  //     (`task_id`, `agent_slug`, `agent_id`, `space_id`, `message_id`,
  //     `reason`, `task_status`), so reading metadata for these seven alone
  //     would be the sole exception in the file.
  //
  // DELIBERATE DIVERGENCE FROM THE SIBLING CLIENT — DO NOT "HARMONISE".
  // `claude-code-suite-channel` resolves the same ids out of `signal.metadata`,
  // and its own loop is metadata-shaped for reasons that hold THERE (its
  // handler was type-level blind to the root copies). That is the right call in
  // that repo and the wrong call in this one. The two clients are expected to
  // disagree on this line. A refactor that unifies them will silently break
  // one; check-signal-correlation-ids.mjs pins the source in BOTH directions
  // (metadata poisoned + root intact must emit the ROOT value; root deleted +
  // metadata intact must emit NOTHING) so such a change cannot pass green.
  //
  // Each id is omitted rather than emitted as `undefined` — a chat mention must
  // not start carrying seven empty keys.
  const correlationCtx = {
    ...(taskId ? { TaskId: taskId } : {}),
    ...(payload.signal?.plan_id ? { PlanId: payload.signal.plan_id } : {}),
    ...(payload.signal?.stage_id ? { StageId: payload.signal.stage_id } : {}),
    ...(payload.signal?.project_id ? { ProjectId: payload.signal.project_id } : {}),
    ...(payload.signal?.responsibility_key
      ? { ResponsibilityKey: payload.signal.responsibility_key }
      : {}),
    ...(payload.signal?.feature ? { Feature: payload.signal.feature } : {}),
    ...(payload.signal?.trigger_kind ? { TriggerKind: payload.signal.trigger_kind } : {}),
  };

  // Build finalized context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `startup-suite:${senderId}`,
    To: `startup-suite:${spaceId}`,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: payload.signal?.message_id || String(Date.now()),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `startup-suite:${spaceId}`,
    CommandAuthorized: true,
    ...correlationCtx,
  });

  // Dispatch through the full agent pipeline with token-level streaming
  const chunkId = `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lastChunkText = "";
  let lastChunkSentAt = 0;
  const CHUNK_THROTTLE_MS = 150;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  const flushChunk = (text: string, done: boolean) => {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    if (text && client) {
      if (!replySpaceId) {
        noReplySpace();
        return;
      }
      client.sendReplyChunk(replySpaceId, chunkId, text, done);
      lastChunkSentAt = Date.now();
      lastChunkText = text;
    }
  };

  const scheduleFlush = (text: string) => {
    const elapsed = Date.now() - lastChunkSentAt;
    if (elapsed >= CHUNK_THROTTLE_MS) {
      flushChunk(text, false);
    } else if (!pendingFlush) {
      pendingFlush = setTimeout(() => {
        pendingFlush = null;
        flushChunk(text, false);
      }, CHUNK_THROTTLE_MS - elapsed);
    }
  };

  try {
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      createIfMissing: true,
      // Last-route always points at the conversational key, never at a
      // one-shot dispatch or task key. Delivery routing for the space has to
      // keep resolving to the room's own session after a dispatch runs.
      updateLastRoute: {
        sessionKey: conversationSessionKey,
        channel: CHANNEL_ID,
        to: `startup-suite:${spaceId}`,
        accountId,
      },
      onRecordError: (err: unknown) => {
        runtime.error(`startup-suite: session meta error: ${String(err)}`);
      },
    });

    const { dispatcher, replyOptions: dispatcherReplyOptions, markDispatchIdle, markRunComplete } =
      core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (replyPayload: any, info: { kind: string }) => {
          const text = replyPayload?.text || "";
          if (!text || !client) return;

          if (info.kind !== "tool") {
            if (!replySpaceId) {
              noReplySpace();
              return;
            }
            client.sendReply(replySpaceId, text);
          }

          // Task-phase completion is now driven by real lifecycle/tool events
          // (session_start / llm_input / after_tool_call / agent_end), not by the
          // presence of a final reply string.
        },
        typingCallbacks: undefined,
        onError: (err: unknown, info: { kind: string }) => {
          runtime.error(`startup-suite ${info.kind} reply failed: ${String(err)}`);
        },
        onCleanup: () => {
          if (!isOrchestrated) {
            if (!replySpaceId) {
              noReplySpace();
              return;
            }
            client.sendTyping(replySpaceId, false);
          }
        },
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: config,
      dispatcher,
      replyOptions: {
        ...dispatcherReplyOptions,
        onPartialReply: (payload: any) => {
          const text = payload.text || "";
          if (text && text !== lastChunkText) {
            scheduleFlush(text);
            if (phase && taskId) {
              getTaskWorkers().noteProgress(taskId, phase, "streaming reply chunk");
            }
          }
        },
      },
    });

    markRunComplete();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    markDispatchIdle();

    // Signal streaming done so UI clears the streaming bubble
    flushChunk(lastChunkText || "", true);
  } catch (err: any) {
    if (phase && taskId) {
      getTaskWorkers().noteFailure(taskId, phase, String(err));
    }

    runtime.error?.(
      `[suite-inbound] dispatch failed: reason=${signalReason} task=${taskId} error=${String(err)}`
    );
  } finally {
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    // Reachable for the FIRST time as of this change: the TypeError above used
    // to escape before the `try` was entered, so this `finally` never ran. On a
    // bare envelope it would have called `sendTyping("unknown", false)` and
    // crashed the runtime channel process — the guard above is what keeps
    // fixing the silent drop from becoming a disconnect loop.
    if (!isOrchestrated) {
      if (replySpaceId) {
        client.sendTyping(replySpaceId, false);
      } else {
        noReplySpace();
      }
    }
  }
}
