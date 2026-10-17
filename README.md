# Burrow Channel Plugin for OpenClaw

Burrow is the new name of Startup Suite. The identifiers OpenClaw config and
tooling key on are unchanged in this release: the channel id `startup-suite`,
the plugin and npm package id `startup-suite-channel-plugin`, the extension
directory `~/.openclaw/extensions/startup-suite-channel`, and every `suite_*`
tool name. An existing `openclaw.json` keeps working without edits.

Connect your OpenClaw agent to a Burrow deployment as a federated runtime. Your agent participates in Burrow spaces — receiving messages, responding through the OpenClaw channel pipeline, and calling Burrow tools (canvas, tasks, plans). The connection is outbound-only, so OpenClaw can run behind NAT without port forwarding.

## Architecture

```
Your OpenClaw (behind NAT) ──outbound WSS──► Burrow (public)
                                                  │
                              ◄── attention signals + context ──┘
                              ──► agent replies ────────────────►
                              ◄── tool results ─────────────────┘
                              ──► tool calls ───────────────────►
```

After connecting, the plugin joins a Phoenix channel (`runtime:<id>`) and listens for **attention** events. Each event includes the triggering message, conversation history, space context (canvases, tasks, participants), and available tools. The message bridge translates this into an OpenClaw agent session, and replies flow back to Burrow.

## Prerequisites

- OpenClaw 2026.2.0+ installed and running
- A Burrow deployment with a registered runtime (get this from Burrow's **Agent Resources → Federate**)
- Node.js 18+

## Installation

First, register a runtime in Burrow: **Agent Resources → Add Agent → Federate**. Copy the runtime ID and token.

### Interactive (recommended)

```bash
git clone <this repository's URL> openclaw-suite-channel
cd openclaw-suite-channel
bash install.sh
```

The script will prompt for your runtime ID and token, then handle everything: file copy, npm install, config, and OpenClaw registration.

### Non-interactive

```bash
bash install.sh --runtime-id my-runtime --token abc123def456
```

With a custom Burrow URL:

```bash
bash install.sh \
  --url wss://suite.example.com/runtime/ws \
  --runtime-id my-runtime \
  --token abc123def456
```

### What the installer does

1. Copies plugin files to `~/.openclaw/extensions/startup-suite-channel/`
2. Installs npm dependencies
3. Writes `config.json` with your runtime credentials (single-account default)
4. Registers the channel and plugin in `openclaw.json`
5. Optionally tests the connection

After install, restart OpenClaw:

```bash
openclaw gateway restart
```

---

## Updating

To update an existing installation after pulling new changes (without touching your config or `openclaw.json`):

```bash
git pull
bash update.sh
openclaw gateway restart
```

### Build identity

On every runtime-channel join the plugin sends `client_info.build`: the git
commit sha of the checkout it was copied or built from (40 hex characters,
with `-dirty` appended when tracked files differed from `HEAD`), and
`client_info.started_at`: when the gateway **process** that loaded the plugin
started (never the connection time). The installed copy has no `.git`, so
`install.sh` / `update.sh` (and `npm run build`, via `prebuild`) stamp the sha
into `build-info.json` next to the code with `scripts/write-build-info.mjs`;
the plugin reads it once when it loads. A reconnect therefore re-sends the
resident code's identity, while a restart after `update.sh` sends the new one.
Burrow's `federation_status` shows it as `client_build`. `version` is
`package.json`'s string, kept for humans only and never used as the build. If
the stamp is missing or invalid, `build` is omitted and
`client_info.build_error` says why; the plugin never guesses. To exercise the
install path without touching a live install, set `BURROW_CHANNEL_EXT_DIR`
(and, for `install.sh`, `BURROW_CHANNEL_OC_CONFIG`) to scratch paths.

### Environment variables

The scripts read the `BURROW_` spelling first. The pre-rename `SUITE_`
spelling still works, but is deprecated: when it is the one used, the script
prints one line to stderr naming the new spelling.

| Variable | Deprecated fallback | Read by | Meaning |
|---|---|---|---|
| `BURROW_CHANNEL_EXT_DIR` | `SUITE_CHANNEL_EXT_DIR` | `install.sh`, `update.sh` | Extension dir to install into (default `~/.openclaw/extensions/startup-suite-channel`) |
| `BURROW_CHANNEL_OC_CONFIG` | `SUITE_CHANNEL_OC_CONFIG` | `install.sh` | `openclaw.json` to write (default `~/.openclaw/openclaw.json`) |
| `BURROW_ACCOUNT_ID` | `SUITE_ACCOUNT_ID` | `scripts/test-connection.sh`, `scripts/test-connection.js` | Account to test when no argument is given |

When both spellings are set, the `BURROW_` value wins and nothing is
printed. The plugin itself reads no environment variables; its config lives
in `openclaw.json` and `config.json`.

---

## Configuration

### Single agent (simple — uses config.json)

The installer writes a `config.json` for the default account. No `openclaw.json` changes needed beyond what the installer does.

```json
{
  "url": "wss://suite.milvenan.technology/runtime/ws",
  "runtimeId": "my-agent-runtime-id",
  "token": "my-token",
  "autoJoinSpaces": [],
  "reconnectIntervalMs": 5000,
  "maxReconnectIntervalMs": 60000
}
```

### Multiple agents on one gateway

If you have multiple federated agents (e.g., Beacon + Sage) running from the same OpenClaw gateway, configure them as named accounts in `openclaw.json` instead of using separate plugin instances (which would cause duplicate tool registration errors).

Add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "startup-suite": {
      "accounts": {
        "beacon": {
          "url": "wss://suite.milvenan.technology/runtime/ws",
          "runtimeId": "beacon-runtime-uuid",
          "token": "beacon-token"
        },
        "sage": {
          "url": "wss://suite.milvenan.technology/runtime/ws",
          "runtimeId": "sage-runtime-uuid",
          "token": "sage-token"
        }
      }
    }
  }
}
```

Each named account becomes a separate WebSocket connection. Tools register once globally — no conflicts regardless of how many accounts are configured.

### Routing accounts to agents

Add `bindings` entries in `openclaw.json` to point each account at a specific OpenClaw agent. There are two important gotchas to get right:

**Gotcha 1: `match.accountId` is required for named accounts.** OpenClaw's router indexes bindings by account. A binding with **no** `match.accountId` is silently filed under `"default"` and only matches inbound events whose account is literally `default`. If you name your accounts (e.g., `beacon`, `sage`, `higgins`), bindings without `accountId` will not match and routing will fall through to the first agent in `agents.list` — usually `main`. Use `accountId: "<account-name>"` or `accountId: "*"` (any account):

```json
{
  "bindings": [
    { "agentId": "beacon-agent", "match": { "channel": "startup-suite", "accountId": "beacon" } },
    { "agentId": "sage-agent",   "match": { "channel": "startup-suite", "accountId": "sage" } }
  ]
}
```

**Gotcha 2: Per-Burrow-agent routing** — if several Burrow-side agents share one runtime account and you want each routed to a different OpenClaw agent, use peer-matched bindings on the Burrow `agent_slug` (available in the attention signal on server versions with agent identity packed in — ADR 0034 era). List peer-matched bindings **before** the channel-wildcard fallback:

```json
{
  "bindings": [
    { "agentId": "ops-agent",   "match": { "channel": "startup-suite", "accountId": "*", "peer": { "id": "ops-bot",  "kind": "group" } } },
    { "agentId": "reply-agent", "match": { "channel": "startup-suite", "accountId": "*", "peer": { "id": "concierge", "kind": "group" } } },
    { "agentId": "default-agent","match": { "channel": "startup-suite", "accountId": "*" } }
  ]
}
```

When a Burrow agent appears in multiple spaces (chat rooms), the plugin automatically appends the space id to the session key so each room keeps its own conversation history — no cross-space context bleed.

### Configuration reference

| Field | Description | Default |
|---|---|---|
| `url` | Burrow WebSocket endpoint | `wss://suite.milvenan.technology/runtime/ws` |
| `runtimeId` | Your registered runtime ID | *(required)* |
| `token` | Runtime token **reference**: `file:<absolute path>` (a regular file owned by the gateway user, mode `0600` or `0400`) or `keychain:<item>` (macOS login keychain, read with `/usr/bin/security find-generic-password -s <tokenKeychainService> -a <item> -w`). Any other value is a literal token: still accepted, deprecated, warned about once per account. An unresolvable ref leaves the account unconfigured and logs one line naming the path or item, never the value. | *(required)* |
| `tokenKeychainService` | Keychain service for a `keychain:<item>` ref. Required with keychain refs. | — |
| `autoJoinSpaces` | Space IDs to auto-join on connect | `[]` |
| `reconnectIntervalMs` | Initial reconnect delay (ms) | `5000` |
| `maxReconnectIntervalMs` | Max reconnect delay (ms) | `60000` |
| `useMcpTools` | Skip the channel-era `suite_*` tool-name hints in agent prompts and emit MCP-compatible guidance instead. Enable once the agent consumes Burrow tools via the `/mcp` endpoint (ADR 0034). | `false` |

---

## Burrow Tools

The plugin registers these tools for the agent:

### Canvas

| Tool | Description |
|---|---|
| `suite_canvas_create` | Create a collaborative canvas (table, code, diagram, dashboard) in a Burrow space |
| `suite_send_media` | Send a message with file attachments into a Burrow space |

### Tasks

| Tool | Description |
|---|---|
| `suite_project_list` | List all projects |
| `suite_epic_list` | List epics, optionally filtered by project |
| `suite_task_create` | Create a task on the kanban board |
| `suite_task_get` | Get a task by ID |
| `suite_task_list` | List tasks with optional filters (project, epic, status) |
| `suite_task_update` | Update a task (title, description, status, priority, epic) |

### Plans & Execution

| Tool | Description |
|---|---|
| `suite_plan_create` | Create an ordered plan (stages + validations) for a task |
| `suite_plan_get` | Get the current approved plan for a task with stage/validation status |
| `suite_plan_submit` | Submit a draft plan for human review |
| `suite_stage_start` | Start a stage (pending → running) |
| `suite_stage_list` | List all stages for a plan |
| `suite_validation_evaluate` | Submit a pass/fail result for a validation check |
| `suite_validation_list` | List all validations for a stage |

### Task lifecycle

Tasks move through a validated state machine. Not all transitions are allowed:

```
backlog → planning → ready → in_progress → in_review → done
           ↕           ↕          ↕              ↕
         blocked ←──────────────────────────────┘
```

Plans flow through their own lifecycle:

```
draft → pending_review → approved → executing → completed
                       → rejected
```

Stages within an approved plan:

```
pending → running → passed
                  → failed → running (retry)
                           → skipped
```

The plan engine advances stages automatically when all validations on a stage resolve as passed.

---

## Security

- All connections are **outbound** from OpenClaw (NAT-safe, no port forwarding needed)
- The runtime token authenticates the WebSocket connection to Burrow
- Burrow handles user authentication via OIDC
- Messages only route from authenticated Burrow users in spaces the agent has joined
- `token` values are sensitive — treat them like API keys; do not commit to source control. Prefer a `file:` or `keychain:` ref so `openclaw.json` holds no secret

---

## Uninstall

```bash
cd openclaw-suite-channel
bash uninstall.sh
openclaw gateway restart
```

This removes the extension directory and cleans up `openclaw.json`.

---

## Troubleshooting

**Connection refused**
- Check that Burrow is running and the URL is correct
- Verify the `/runtime/ws` endpoint is reachable from your network

**Auth failed**
- Verify `runtimeId` and `token` match what Burrow generated
- The token may have expired — re-register with Burrow if needed

**No responses**
- Check OpenClaw gateway logs: `openclaw gateway logs`
- Ensure the runtime is associated with at least one Burrow space

**Duplicate tool registration errors (multi-agent setup)**
- Do not run multiple plugin instances — use the multi-account config in `openclaw.json` instead (see above)
- If you previously had a `startup-suite-beacon` plugin, remove it; its tools are already registered by this plugin

**Duplicate messages**
- Restart OpenClaw gateway to clear stale connections: `openclaw gateway restart`

**All messages route to the first agent in `agents.list` (usually `main`) even though you wrote a binding for another agent**
- Your binding's `match` block is missing `accountId`. OpenClaw's router buckets such bindings under the internal account name `"default"` and will not match inbound events on a named account. Add `"accountId": "<your-account-name>"` (or `"accountId": "*"` to match any account) to each `bindings[].match` entry for this channel. See [Routing accounts to agents](#routing-accounts-to-agents) for full examples.

---

## License

MIT
