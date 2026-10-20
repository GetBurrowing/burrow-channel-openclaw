import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuiteClient, SuiteConfig } from "./suite-client.js";
import { TaskWorkerController } from "./task-worker-controller.js";
import { resolveTokenRef } from "./token-ref.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const clients = new Map<string, SuiteClient>();
const spaceToAccountId = new Map<string, string>();
const sessionContexts = new Map<string, unknown>();
// sessionKey -> space UUID. Session keys extend OpenClaw's resolved route key
// (`agent:<agentId>:burrow:group:<peer>`), and since the peer is the
// Burrow agent slug the space id is not recoverable from the key by parsing.
// Anything that needs the space for a session must read it from here.
const sessionSpaces = new Map<string, string>();

let taskWorkers: TaskWorkerController | null = null;

export interface SessionOptions {
  useMcpTools: boolean;
}

const sessionOptions = new Map<string, SessionOptions>();

export function setSessionContext(sessionKey: string, context: unknown): void {
  sessionContexts.set(sessionKey, context);
}

export function getSessionContext(sessionKey: string | null | undefined): unknown {
  if (!sessionKey) return undefined;
  return sessionContexts.get(sessionKey);
}

export function clearSessionContext(sessionKey: string): boolean {
  sessionOptions.delete(sessionKey);
  sessionSpaces.delete(sessionKey);
  return sessionContexts.delete(sessionKey);
}

// Record the space a session belongs to at the point the session key is minted,
// where the space id is still in scope. Never derive this by slicing the key:
// the key format is owned by OpenClaw's route resolver and has already changed
// once (0.6.6), which silently produced agent slugs where space ids were
// expected.
export function rememberSessionSpace(sessionKey: string, spaceId: string): void {
  if (!sessionKey || !spaceId) return;
  sessionSpaces.set(sessionKey, spaceId);
}

export function spaceForSession(sessionKey: string | null | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return sessionSpaces.get(sessionKey);
}

export function setSessionOptions(sessionKey: string, opts: SessionOptions): void {
  sessionOptions.set(sessionKey, opts);
}

export function getSessionOptions(sessionKey: string | null | undefined): SessionOptions | undefined {
  if (!sessionKey) return undefined;
  return sessionOptions.get(sessionKey);
}

export function resolveAccountOptions(cfg: any, accountId: string): SessionOptions {
  const account = channelConfigRoot(cfg)?.accounts?.[accountId];
  return { useMcpTools: Boolean(account?.useMcpTools) };
}

function loadLegacyConfig(): SuiteConfig {
  const raw = readFileSync(join(__dirname, "..", "config.json"), "utf-8");
  return JSON.parse(raw);
}

function channelConfigRoot(cfg: any): any {
  if (cfg?.channels?.["burrow"]) return cfg.channels["burrow"];
  if (cfg?.accounts) return cfg;
  return null;
}

// The account's `token` is a REF (`file:<path>`, `keychain:<item>` with
// `tokenKeychainService`) or a deprecated literal; see src/token-ref.ts. An
// account whose ref does not resolve is NOT configured: this returns null and
// the resolver has already logged one line naming the account and the ref.
export function resolveAccountConfig(cfg: any, accountId: string): SuiteConfig | null {
  const root = channelConfigRoot(cfg);
  const account = root?.accounts?.[accountId];
  if (account?.url && account?.runtimeId && account?.token) {
    const token = resolveTokenRef(account.token, {
      accountId,
      keychainService: account.tokenKeychainService,
    });
    if (!token.ok) return null;
    return {
      url: account.url,
      runtimeId: account.runtimeId,
      token: token.value,
      autoJoinSpaces: account.autoJoinSpaces ?? [],
      reconnectIntervalMs: account.reconnectIntervalMs ?? 5000,
      maxReconnectIntervalMs: account.maxReconnectIntervalMs ?? 60000,
    };
  }

  if (accountId === "default") {
    let legacy: any;
    try {
      legacy = loadLegacyConfig();
    } catch {
      return null;
    }
    if (!legacy?.url || !legacy?.runtimeId || !legacy?.token) return null;
    const token = resolveTokenRef(legacy.token, {
      accountId,
      keychainService: legacy.tokenKeychainService,
    });
    if (!token.ok) return null;
    const { tokenKeychainService: _svc, ...rest } = legacy;
    return { ...rest, token: token.value };
  }

  return null;
}

export function listConfiguredAccountIds(cfg: any): string[] {
  const accounts = channelConfigRoot(cfg)?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }

  try {
    loadLegacyConfig();
    return ["default"];
  } catch {
    return [];
  }
}

export function setClient(accountId: string, client: SuiteClient) {
  clients.set(accountId, client);
}

export function clearClient(accountId: string) {
  clients.delete(accountId);
  for (const [spaceId, mappedAccountId] of spaceToAccountId.entries()) {
    if (mappedAccountId === accountId) {
      spaceToAccountId.delete(spaceId);
    }
  }

  if (clients.size === 0 && taskWorkers) {
    taskWorkers.shutdown();
    taskWorkers = null;
  }
}

export function rememberSpaceAccount(spaceId: string, accountId: string) {
  spaceToAccountId.set(spaceId, accountId);
}

export function clientForSpace(spaceId?: string | null): SuiteClient | null {
  if (spaceId) {
    const accountId = spaceToAccountId.get(spaceId);
    if (accountId) {
      const client = clients.get(accountId);
      if (client) return client;
    }
  }

  return clients.values().next().value ?? null;
}

export function clientForTool(args: any): SuiteClient | null {
  const spaceId = args?.space_id;
  return clientForSpace(spaceId);
}

export function getTaskWorkers(): TaskWorkerController {
  if (!taskWorkers) {
    taskWorkers = new TaskWorkerController((executionSpaceId?: string) =>
      clientForSpace(executionSpaceId)
    );
  }

  return taskWorkers;
}
