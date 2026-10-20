/**
 * Runtime-token references for a Burrow account.
 *
 * ONE resolver for BOTH ref schemes, shared in syntax with suite-cli's
 * `--token-ref` (src/token_ref.ts there) and the core installer's channel
 * step, so a ref written by one is read by the others:
 *
 *   token: "file:<absolute path>"
 *   token: "keychain:<item>"   + tokenKeychainService: "<service>"   (macOS only)
 *   token: "<anything else>"   a LITERAL: still accepted for backward
 *                              compatibility, with one deprecation warning
 *                              per account per process.
 *
 * A `file:` ref must be a regular file (symlinks refused), owned by the
 * gateway's uid, mode 0600 or 0400 -- the same rule suite-cli enforces, so a
 * file one accepts the other accepts. Ownership and mode are checked BEFORE
 * the content is read. One trailing newline is stripped.
 *
 * A `keychain:` ref is read with exactly
 *   /usr/bin/security find-generic-password -s <service> -a <item> -w
 * so argv carries NAMES only and the value arrives on the child's stdout, into
 * memory. The path is ABSOLUTE on purpose: a `security` earlier on PATH must
 * not be able to answer for the keychain. Tests reach a fake through the
 * {@link TokenRefDeps.securityBin} seam, never through PATH.
 *
 * Every failure is ONE log line naming the account and the ref (path or item
 * NAME). No log line, reason or thrown error ever carries a resolved value or
 * a literal token.
 *
 * Resolution is SYNCHRONOUS because OpenClaw's `ChannelConfigAdapter.
 * resolveAccount` is synchronous. A successful keychain read is cached for
 * the life of the process (keyed by service + item), so repeated config
 * resolution does not re-spawn `security`; a rotated keychain value is picked
 * up on the next gateway start.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const FILE_PREFIX = "file:";
export const KEYCHAIN_PREFIX = "keychain:";
export const SECURITY_BIN = "/usr/bin/security";

export type TokenRefKind = "file" | "keychain" | "literal";

export type TokenRefResult =
  | { ok: true; value: string; kind: TokenRefKind }
  | { ok: false; reason: string; kind: TokenRefKind };

export interface TokenRefDeps {
  /** Platform check seam. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Absolute path of `security`. Only tests change it. */
  securityBin?: string;
  /** Runs `bin` with `args`, no shell; returns exit status and stdout. */
  exec?: (bin: string, args: string[]) => { status: number; stdout: string };
  /** The gateway's uid. Seam so the foreign-owner branch is testable without root. */
  uid?: number;
  /** Where the one-line warnings and failures go. Defaults to console.warn. */
  log?: (line: string) => void;
}

export interface ResolveOptions {
  /** Account id, used only to label log lines. */
  accountId?: string;
  /** Required for `keychain:` refs. */
  keychainService?: string;
}

let defaultDeps: TokenRefDeps = {};

/** Test seam: set the deps every caller without explicit deps gets. Returns the previous value. */
export function setTokenRefDeps(deps: TokenRefDeps): TokenRefDeps {
  const prev = defaultDeps;
  defaultDeps = deps;
  return prev;
}

const literalWarned = new Set<string>();
const failureLogged = new Set<string>();
const keychainCache = new Map<string, string>();

/** Test seam: forget one-time warnings and the keychain cache. */
export function resetTokenRefState(): void {
  literalWarned.clear();
  failureLogged.clear();
  keychainCache.clear();
}

/** The argv of the keychain read. Names only; pinned by test; identical to suite-cli's. */
export function securityArgs(service: string, item: string): string[] {
  return ["find-generic-password", "-s", service, "-a", item, "-w"];
}

function stripOneNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function execNoShell(bin: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    return { status: 0, stdout: String(stdout) };
  } catch (err: any) {
    // A non-zero exit carries `status`; a spawn failure (ENOENT) does not.
    // stdout of a failed call is discarded: it is never a value we trust.
    return { status: typeof err?.status === "number" ? err.status : -1, stdout: "" };
  }
}

function resolveFile(path: string, deps: TokenRefDeps): { ok: true; value: string } | { ok: false; reason: string } {
  if (!isAbsolute(path)) return { ok: false, reason: `file: ref needs an absolute path, got ${JSON.stringify(path)}` };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, reason: `token file ${path} does not exist or cannot be stat'ed` };
  }
  if (!st.isFile()) return { ok: false, reason: `token file ${path} is not a regular file (symlinks are refused)` };
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  if (st.uid !== uid) return { ok: false, reason: `token file ${path} is owned by uid ${st.uid}, not by the gateway (uid ${uid})` };
  const perm = st.mode & 0o777;
  if (perm !== 0o600 && perm !== 0o400) {
    return { ok: false, reason: `token file ${path} has mode ${modeString(st.mode)}; it must be 0600 or 0400` };
  }
  let value: string;
  try {
    value = stripOneNewline(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: `token file ${path} could not be read` };
  }
  if (value === "") return { ok: false, reason: `token file ${path} is empty` };
  return { ok: true, value };
}

function resolveKeychain(
  item: string,
  service: string,
  deps: TokenRefDeps,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (item === "") return { ok: false, reason: "keychain: ref needs an item name" };
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { ok: false, reason: `keychain:${item}: keychain refs are macOS-only` };
  }
  if (service === "") return { ok: false, reason: `keychain:${item} needs tokenKeychainService` };
  const cacheKey = `${service}\u0000${item}`;
  const cached = keychainCache.get(cacheKey);
  if (cached !== undefined) return { ok: true, value: cached };
  const bin = deps.securityBin ?? SECURITY_BIN;
  const r = (deps.exec ?? execNoShell)(bin, securityArgs(service, item));
  const value = r.status === 0 ? stripOneNewline(r.stdout) : "";
  if (value === "") {
    return {
      ok: false,
      reason:
        `the keychain did not return item ${JSON.stringify(item)} of service ${JSON.stringify(service)} ` +
        `(security exit ${r.status}); unlock the login keychain or add the item`,
    };
  }
  keychainCache.set(cacheKey, value);
  return { ok: true, value };
}

/**
 * Resolve an account's `token` field to the runtime token, IN MEMORY.
 * Never log, print or serialise the returned value.
 */
export function resolveTokenRef(
  token: unknown,
  options: ResolveOptions = {},
  deps: TokenRefDeps = defaultDeps,
): TokenRefResult {
  const account = options.accountId ?? "default";
  const log = deps.log ?? ((line: string) => console.warn(line));
  const fail = (kind: TokenRefKind, reason: string): TokenRefResult => {
    const key = `${account}\u0000${reason}`;
    if (!failureLogged.has(key)) {
      failureLogged.add(key);
      log(`burrow(${account}): token ref unresolved: ${reason}`);
    }
    return { ok: false, reason, kind };
  };

  if (typeof token !== "string" || token === "") return fail("literal", "token is missing");

  if (token.startsWith(FILE_PREFIX)) {
    const r = resolveFile(token.slice(FILE_PREFIX.length), deps);
    return "reason" in r ? fail("file", r.reason) : { ok: true, value: r.value, kind: "file" };
  }

  if (token.startsWith(KEYCHAIN_PREFIX)) {
    const r = resolveKeychain(token.slice(KEYCHAIN_PREFIX.length), options.keychainService ?? "", deps);
    return "reason" in r ? fail("keychain", r.reason) : { ok: true, value: r.value, kind: "keychain" };
  }

  if (!literalWarned.has(account)) {
    literalWarned.add(account);
    log(
      `burrow(${account}): a literal runtime token in config is deprecated; ` +
        `use token "file:<absolute path>" (mode 0600) or "keychain:<item>" with tokenKeychainService`,
    );
  }
  return { ok: true, value: token, kind: "literal" };
}
