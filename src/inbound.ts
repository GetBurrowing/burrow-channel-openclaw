import { type OpenClawConfig, type RuntimeEnv } from "./runtime-api.js";
import { getSuiteRuntime } from "./runtime.js";
import { getTaskWorkers, resolveAccountOptions, setSessionContext, setSessionOptions } from "./plugin-state.js";
import { buildDispatchSessionKey, buildTaskSessionKey, type TaskPhase } from "./session-key.js";
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
  const incomingBody = payload.message?.content?.trim() ?? "";
  const rawBody =
    incomingBody || (isDispatch ? `System dispatch: ${signalReason ?? "unknown"}` : "");
  if (!rawBody) {
    runtime.log(`[suite-inbound] empty message body, signal=${payload.signal?.reason} task=${payload.signal?.task_id}`);
    return;
  }

  // For orchestrated signals, the signal.space_id is the execution space which
  // isn't in the agent's routing config. Use the execution space for replies but
  // route via a synthetic peer so the default agent binding resolves correctly.
  const spaceId = payload.signal.space_id || payload.signal.task_id || "unknown";

  const senderId = payload.message.author || (isLifecycleSignal ? "TaskRouter" : "unknown");
  const senderName = payload.message.author || (isLifecycleSignal ? "TaskRouter" : "unknown");
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
      client.sendReplyChunk(spaceId, chunkId, text, done);
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
            client.sendReply(spaceId, text);
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
            client.sendTyping(spaceId, false);
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
    if (!isOrchestrated) {
      client.sendTyping(spaceId, false);
    }
  }
}
