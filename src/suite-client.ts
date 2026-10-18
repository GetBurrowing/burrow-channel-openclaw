// @ts-ignore phoenix ships JS without local type declarations in this plugin checkout
import { Socket } from "phoenix";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILD, BUILD_ERROR, PROCESS_STARTED_AT } from "./build-identity.js";

// Federation handshake: declare what client product is connecting so the Burrow
// dispatch renderer can distinguish OpenClaw runtimes (multi-agent per
// connection) from Claude-channel runtimes (single-agent per connection).
// Burrow-side treats missing client_info as "unknown" (forward compatible).
const PLUGIN_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/suite-client.ts → ../package.json from compiled dist/src/ as well
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {}
  // Fallback: try one level up (in case of a flatter dist layout)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {}
  return "unknown";
})();

// ── `build` / `build_error` / `started_at` ─────────────────────────────────
//
// `build` is the LOAD-BEARING identity: the commit sha the loaded code was
// copied or built from (build-info.json, stamped by install.sh / update.sh /
// `npm run build`; see src/build-identity.ts). It answers "is this runtime on
// the build whose source I am reading?". `version` stays for humans only - it
// is package.json's string and discriminates nothing. Without a valid stamp,
// `build` is OMITTED and `build_error` says why, so core can tell "tried and
// could not" from "predates the contract". `started_at` is the gateway
// PROCESS start, never a connection time. All resolved once at module load,
// so a rejoin re-sends the resident code's identity. Core reads them in
// runtime_channel.ex (`normalize_build/1`, `normalize_started_at/1`).
export interface ClientInfo {
  product: "openclaw";
  version: string;
  build?: string;
  build_error?: string;
  started_at: string;
}

export const CLIENT_INFO: ClientInfo = {
  product: "openclaw",
  version: PLUGIN_VERSION,
  ...(BUILD !== null ? { build: BUILD } : { build_error: BUILD_ERROR ?? "build unresolved" }),
  started_at: PROCESS_STARTED_AT,
};

export interface SuiteConfig {
  url: string;
  runtimeId: string;
  token: string;
  autoJoinSpaces: string[];
  reconnectIntervalMs: number;
  maxReconnectIntervalMs: number;
}

export interface SuiteHandlers {
  onAttention: (payload: AttentionPayload) => void;
  onToolResult: (payload: { call_id: string; status?: string; result?: unknown; error?: { error?: string } }) => void;
  onDisconnect: () => void;
  onSpacesManifest?: (spaces: Array<{ id: string; name: string; kind: string }>) => void;
}

export interface AttentionPayload {
  signal: {
    reason: string;
    space_id?: string;
    task_id?: string;
    task_status?: string;
    message_id?: string;
    // Target Burrow agent for this attention event. Present on Burrow versions
    // that pack the responder's agent identity into the external signal. Used
    // by the plugin to route to a specific OpenClaw agent via peer-matched
    // bindings instead of falling through to the channel default.
    agent_id?: string;
    agent_slug?: string;
    // Responsibility-firing fields. The server has sent these at the SIGNAL
    // ROOT for some time — it lifts them out of `metadata` specifically so a
    // federated runtime need not dig — but this client had never named them,
    // so nothing in the inbound path could read them without a cast. They are
    // the correlation ids a dispatched agent needs to call back into the plan
    // engine, plus the prompt body a native `system_event` carries INSTEAD of
    // a `message` key.
    //
    // `metadata` also mirrors the four ids AND repeats the (multi-kilobyte)
    // prompt. Read the root, never `metadata`: forwarding metadata wholesale
    // doubles the payload, and this repo's whole inbound path already reads
    // root only. (The sibling client, claude-code-suite-channel, pulls these
    // out of `signal.metadata`. That is the right call THERE and the wrong
    // call here — do not "harmonise" the two.)
    prompt?: string;
    responsibility_key?: string;
    feature?: string;
    trigger_kind?: string;
    project_id?: string;
    plan_id?: string;
    stage_id?: string;
    metadata?: Record<string, unknown>;
  };
  // OPTIONAL, AND THAT IS THE POINT. A native `system_event` — the shape
  // `Platform.Responsibilities.Router.native_reason_for/1` produces when it
  // maps `:event_topic` / `:cron` / `:webhook` -> `:system_event` — sends
  // `signal` ALONE. It omits `message`, `history` and `context` entirely.
  // Only the chat path sends all four keys.
  //
  // Declaring these three required was not a cosmetic inaccuracy: it is what
  // licensed the unguarded `payload.message.author` at src/inbound.ts:71-72,
  // which throws `TypeError: Cannot read properties of undefined (reading
  // 'author')` on every native system_event, gets flattened to a single
  // `attention handler error` line by src/channel.ts, and drops the dispatch
  // silently. The agent never wakes.
  //
  // CAVEAT: tsconfig.json sets `"strict": false`, so widening these does NOT
  // make `tsc` flag that dereference. This change buys documentation, editor
  // signal, and a type that stops lying — it is not the fix. The runtime
  // guard and the captured-envelope fixture are.
  message?: { content?: string; author?: string; attachments?: unknown[] };
  history?: Array<{ content: string; author: string; role?: string }>;
  context?: {
    // Chat attention context (from ContextPlane)
    space?: { id: string; name: string; description?: string };
    canvases?: Array<{ id: string; title: string; content: string }>;
    tasks?: Array<{ id: string; title: string; status: string }>;
    agents?: Array<{ id: string; name: string; status: string }>;
    activity_summary?: string;
    // Task orchestration context (from ContextAssembler)
    project?: {
      name: string;
      repo_url?: string;
      tech_stack?: Record<string, unknown>;
      deploy_config?: Record<string, unknown>;
    };
    epic?: {
      name: string;
      description?: string;
      acceptance_criteria?: string;
    };
    task?: {
      id: string;
      title: string;
      description?: string;
      status: string;
      priority?: string;
      dependencies?: Array<Record<string, unknown>>;
      metadata?: Record<string, unknown>;
    };
    plan?: {
      id: string;
      version: number;
      status: string;
      stages: Array<{
        id: string;
        position: number;
        name: string;
        description?: string;
        status: string;
        validations: Array<{ id: string; kind: string; status: string }>;
      }>;
    };
    execution_space_id?: string;
    skills?: Array<{ name: string; content: string }>;
    // Org-level context bundle (from Platform.Org.Context.build_context/1)
    // Keys are file names: ORG_IDENTITY.md, ORG_MEMORY.md, ORG_AGENTS.md,
    // and ORG_NOTES-YYYY-MM-DD for recent daily memory entries.
    org?: Record<string, string>;
  };
  tools?: Array<{ name: string; description: string; parameters: object }>;
}

/** Optional annotations on a `reply` push (core `Platform.Chat.ReplyContext`). */
export interface ReplyExtras {
  in_reply_to_message_id?: string;
  context?: string;
}

function definedExtras(extras?: ReplyExtras): ReplyExtras {
  const out: ReplyExtras = {};
  if (extras?.in_reply_to_message_id !== undefined) {
    out.in_reply_to_message_id = extras.in_reply_to_message_id;
  }
  if (extras?.context !== undefined) out.context = extras.context;
  return out;
}

/**
 * Underscore wire names whose legacy dotted spelling an OLD Burrow server
 * still requires. Keyed by the underscore form; see SuiteClient.callTool.
 */
export const DOTTED_TWINS: Readonly<Record<string, string>> = Object.freeze({
  skill_list: "skill.list",
  skill_get: "skill.get",
  skill_upsert: "skill.upsert",
  epic_create: "epic.create",
});

/** `skill.list` -> `skill_list`; names without a dot pass through unchanged. */
export function underscoreToolName(tool: string): string {
  return tool.replace(/\./g, "_");
}

/** The dotted spelling to fall back to, or undefined when there is none. */
export function dottedTwin(tool: string): string | undefined {
  if (tool.includes(".")) return tool;
  return DOTTED_TWINS[tool];
}

/**
 * True only for core's name-lookup miss
 * ("unknown tool '<name>' (no such tool in the catalogue ...").
 * A permission denial ("tool '<name>' requires permission ...") shares the
 * `forbidden` code but must NOT match.
 */
export function isUnknownToolError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("unknown tool '");
}

export class SuiteClient {
  private socket: Socket | null = null;
  private channel: any = null;
  private config: SuiteConfig;
  private handlers: SuiteHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private stopped: boolean = false;
  private recentMessageIds = new Set<string>();
  private pendingToolCalls = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  constructor(config: SuiteConfig, handlers: SuiteHandlers) {
    this.config = config;
    this.handlers = handlers;
  }

  /**
   * Call a Burrow tool over the WebSocket and wait for the result.
   *
   * Wire-name negotiation (Burrow migration, task 01a14a7d). Core resolves
   * `tool_call` names by EXACT string membership, and its catalogue is moving
   * from dotted names (`skill.list`) to underscore names (`skill_list`), with
   * the dotted form kept only as a hidden alias on new servers. Old servers
   * know only the dotted form. So:
   *
   *   - the underscore form is always sent first (`.` -> `_`);
   *   - if the name has a dotted twin (it was passed dotted, or it is listed
   *     in DOTTED_TWINS) and the server rejects the first attempt as an
   *     UNKNOWN tool, the dotted twin is tried exactly once, and its outcome
   *     (success or error) is returned unchanged;
   *   - any other failure (permission denied, timeout, handler error) is
   *     surfaced as-is with no retry.
   *
   * The trigger is the error MESSAGE, not the code: core replies
   * `code: "forbidden"` both for an unknown name and for a known tool the
   * runtime is not granted, and only the message tells them apart.
   */
  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const primary = underscoreToolName(tool);
    const fallback = dottedTwin(tool);

    try {
      return await this.pushToolCall(primary, args);
    } catch (err) {
      if (fallback && fallback !== primary && isUnknownToolError(err)) {
        return this.pushToolCall(fallback, args);
      }
      throw err;
    }
  }

  private pushToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error(`Tool call ${tool} timed out after 30s`));
      }, 30_000);

      this.pendingToolCalls.set(callId, {
        resolve: (result: unknown) => { clearTimeout(timeout); resolve(result); },
        reject: (err: Error) => { clearTimeout(timeout); reject(err); },
      });

      this.channel?.push("tool_call", { call_id: callId, tool, args });
    });
  }

  connect(): void {
    this.stopped = false;

    // Clean up any existing connection first to prevent duplicate subscriptions
    if (this.channel) {
      try { this.channel.leave(); } catch {}
      this.channel = null;
    }
    if (this.socket) {
      try { this.socket.disconnect(); } catch {}
      this.socket = null;
    }

    // Phoenix JS client needs a WebSocket implementation in Node.js
    (globalThis as any).WebSocket = WebSocket;

    this.socket = new Socket(this.config.url, {
      params: {
        runtime_id: this.config.runtimeId,
        token: this.config.token,
      },
      // Disable Phoenix's built-in reconnect — we handle it ourselves
      reconnectAfterMs: () => 999999999,
    });

    this.socket.onOpen(() => {
      console.log(`[suite-client] Socket opened (attempt ${this.reconnectAttempts} resets to 0)`);
      this.reconnectAttempts = 0;
    });

    this.socket.onClose((event: any) => {
      console.warn(`[suite-client] Socket closed — code: ${event?.code ?? "unknown"}, reason: ${event?.reason || "none"}, wasClean: ${event?.wasClean ?? "unknown"}`);
      if (!this.stopped) {
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    });

    this.socket.onError((error: any) => {
      console.error(`[suite-client] Socket error:`, error?.message || error);
      if (!this.stopped) {
        this.handlers.onDisconnect();
      }
    });

    this.socket.connect();
    this.joinChannel();
  }

  disconnect(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      this.channel.leave();
      this.channel = null;
    }

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * `extras` carries optional reply annotations (task 01a0d8de), today only
   * `in_reply_to_message_id`. Undefined values are left off the wire, so a
   * reply without extras pushes the same `{space_id, content}` it always did.
   * Core validates each annotation and drops an invalid one without failing
   * the reply.
   */
  sendReply(spaceId: string, content: string, extras?: ReplyExtras): void {
    this.channel?.push("reply", { space_id: spaceId, content, ...definedExtras(extras) });
  }

  sendTyping(spaceId: string, typing: boolean): void {
    this.channel?.push("typing", { space_id: spaceId, typing });
  }

  sendReplyChunk(spaceId: string, chunkId: string, text: string, done: boolean): void {
    this.channel?.push("reply_chunk", {
      space_id: spaceId,
      chunk_id: chunkId,
      text,
      done,
    });
  }

  sendToolCall(callId: string, tool: string, args: object): void {
    this.channel?.push("tool_call", { call_id: callId, tool, args });
  }

  sendUsageEvent(event: Record<string, unknown>): void {
    this.channel?.push("usage_event", event);
  }

  sendExecutionEvent(event: Record<string, unknown>): void {
    this.channel?.push("execution_event", event);
  }

  sendReplyWithMedia(
    spaceId: string,
    content: string,
    attachments: Array<{
      filename: string;
      contentType: string;
      data: string; // base64
    }>
  ): void {
    this.channel?.push("reply_with_media", {
      space_id: spaceId,
      content,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content_type: a.contentType,
        data: a.data,
      })),
    });
  }

  private joinChannel(): void {
    if (!this.socket) return;

    const topic = `runtime:${this.config.runtimeId}`;
    this.channel = this.socket.channel(topic, {
      client_info: CLIENT_INFO,
    });

    this.channel.on("capabilities", (payload: { tools: any[]; tool_count: number }) => {
      const registered = [
        "suite_canvas_create",
        "suite_canvas_update",
        "suite_send_media",
        "suite_project_list",
        "suite_epic_list",
        "suite_task_create",
        "suite_task_get",
        "suite_task_list",
        "suite_task_update",
        "suite_task_complete",
        "suite_plan_create",
        "suite_plan_get",
        "suite_plan_submit",
        "suite_stage_start",
        "suite_stage_list",
        "suite_validation_evaluate",
        "validation_pass",
        "stage_complete",
        "report_blocker",
        "suite_validation_list",
        "review_request_create",
        "suite_review_request_create",
        "suite_space_list",
        "suite_space_get_context",
        "space_get_context",
        "suite_space_search_messages",
        "space_search_messages",
        "suite_space_get_messages",
        "space_get_messages",
        "suite_canvas_list",
        "canvas_list",
        "suite_canvas_get",
        "canvas_get",
        "prompt_template_list",
        "suite_prompt_template_list",
        "prompt_template_update",
        "suite_prompt_template_update",
        "suite_federation_status",
        "suite_org_context_read",
        "suite_org_context_write",
        "suite_org_context_list",
        "suite_org_memory_append",
        "suite_org_memory_search",
        // Skill registry — old Burrow servers advertise dotted names
        // (`skill.list`, etc.); new servers advertise underscore names and
        // keep the dotted ones as hidden aliases. The plugin exposes
        // underscored tools (suite_skill_*, skill_*) and callTool sends the
        // underscore wire name first, falling back to dotted. Include both
        // forms here so (a) the tool-contract check matches plugin agentTools
        // names and (b) the available-vs-registered diff stays quiet against
        // old and new servers alike.
        "suite_skill_list",
        "skill_list",
        "suite_skill_get",
        "skill_get",
        "suite_skill_upsert",
        "skill_upsert",
        "skill.list",
        "skill.get",
        "skill.upsert",
        // Epic registry — current Burrow registers `epic_create`; `epic.create`
        // is kept for older servers. The plugin exposes both
        // `suite_epic_create` and the unprefixed `epic_create` alias for
        // legacy WS-channel agents (task 019d60ca).
        "suite_epic_create",
        "epic_create",
        "epic.create",
      ];
      const available = (payload.tools || []).map((t: any) => t.name);
      const unregistered = available.filter(
        (t: string) => !registered.includes(t) && !registered.includes(`suite_${t}`)
      );
      if (unregistered.length > 0) {
        console.warn(`[suite-client] Burrow advertises tools not registered in plugin: ${unregistered.join(", ")}. Update the plugin to add these.`);
      }
      console.log(`[suite-client] Burrow capabilities: ${payload.tool_count} tools available, ${registered.length} registered in plugin`);
    });

    this.channel.on("attention", (payload: AttentionPayload) => {
      // Deduplicate — Burrow may broadcast once but multiple channel joins can receive it
      const msgId = payload.signal?.message_id || payload.message?.content?.slice(0, 50) || "";
      const dedupeKey = `${payload.signal?.space_id}:${msgId}:${Date.now() >> 10}`; // ~1s window
      if (this.recentMessageIds.has(dedupeKey)) return;
      this.recentMessageIds.add(dedupeKey);
      // Clean old entries
      if (this.recentMessageIds.size > 50) {
        const first = this.recentMessageIds.values().next().value;
        if (first) this.recentMessageIds.delete(first);
      }
      this.handlers.onAttention(payload);
    });

    this.channel.on("tool_result", (payload: { call_id: string; status: string; result?: unknown; error?: { error?: string } }) => {
      const pending = this.pendingToolCalls.get(payload.call_id);
      if (pending) {
        this.pendingToolCalls.delete(payload.call_id);
        if (payload.status === "ok") {
          pending.resolve(payload.result);
        } else {
          pending.reject(new Error(payload.error?.error || "Tool call failed"));
        }
      }
      this.handlers.onToolResult(payload);
    });

    this.channel.on("spaces_manifest", (payload: { spaces: Array<{ id: string; name: string; kind: string }> }) => {
      console.log(`[suite-client] spaces_manifest: ${payload.spaces.length} spaces`);
      this.handlers.onSpacesManifest?.(payload.spaces);
    });

    this.channel.on("ping", (_payload: { timestamp?: string }) => {
      this.channel?.push("pong", { timestamp: new Date().toISOString() });
    });

    this.channel
      .join()
      .receive("ok", () => {
        console.log(`[suite-client] Joined ${topic}`);
      })
      .receive("error", (reason: unknown) => {
        console.error(`[suite-client] Failed to join ${topic}:`, reason);
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectIntervalMs
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    console.log(`[suite-client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
  }
}
