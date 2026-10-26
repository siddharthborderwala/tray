// Where API keys live and how the CLI picks a domain + key for a command.
import { join } from "node:path";
import { readJson, writeJson, type Accounts } from "./config.ts";
import { TrayDomainInput } from "@tray-sh/schema";
import { noDomain, notLoggedIn, usageError } from "./errors.ts";

export type KeySource = "keychain" | "file";

export interface KeyStore {
  get(domain: string): Promise<string | null>;
  set(domain: string, key: string): Promise<void>;
  delete(domain: string): Promise<void>;
  /** Where the saved key for `domain` lives, for `tray whoami`. */
  source?(domain: string): Promise<KeySource | null>;
}

const SERVICE = "sh.tray.cli";

/** ~/.config/tray/auth.json, mode 600. */
export function fileKeyStore(dir: string): KeyStore {
  const file = join(dir, "auth.json");
  const read = () => readJson<Record<string, string>>(file, {});
  return {
    async get(domain) {
      return read()[domain] ?? null;
    },
    async source(domain) {
      return read()[domain] ? "file" : null;
    },
    async set(domain, key) {
      writeJson(file, { ...read(), [domain]: key }, 0o600);
    },
    async delete(domain) {
      const all = read();
      if (!(domain in all)) return;
      delete all[domain];
      writeJson(file, all, 0o600);
    },
  };
}

/**
 * Which store new keys go to, and which is read first.
 *
 * - macOS: the Keychain only for our Developer ID-signed release binaries.
 *   The Keychain ties an item to the signature of the binary that created it,
 *   so every new unsigned build would get an "allow access?" prompt (and an
 *   agent would hang on it). Unsigned builds use auth.json.
 * - Windows: Credential Manager. Linux: the Secret Service. Both via
 *   Bun.secrets, with auth.json as the fallback when they fail or time out.
 */
export function preferredKeyStore(platform: NodeJS.Platform, macosSigned: boolean): KeySource {
  return platform === "darwin" && !macosSigned ? "file" : "keychain";
}

/** Keychain calls never wait longer than this when nobody can answer a prompt. */
export const KEYCHAIN_TIMEOUT_MS = 2_000;
/** In an interactive terminal the user can answer an OS prompt, so allow longer. */
export const KEYCHAIN_INTERACTIVE_TIMEOUT_MS = 60_000;

class KeychainTimeout extends Error {}

let stalled = false;
/** True once a keychain call timed out (it may still be pending in the OS). */
export const keychainStalled = () => stalled;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stalled = true;
      reject(new KeychainTimeout(`keychain didn't answer in ${ms}ms`));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface KeyStoreOptions {
  /** Bun.secrets, or a stand-in in tests. */
  secrets?: typeof Bun.secrets;
  platform?: NodeJS.Platform;
  /** True for release binaries signed with our Developer ID (see build.ts). */
  macosSigned?: boolean;
  /** Upper bound for any single keychain call. */
  timeoutMs?: number;
}

/**
 * The OS keychain or auth.json, chosen by `preferredKeyStore`. Reads check the
 * preferred store first and then the other one, so keys saved by an earlier
 * build keep working. Keychain calls are bounded by `timeoutMs` and treated as
 * "not there" when they fail, so a locked keyring or an unanswered prompt
 * can't hang the CLI.
 */
export function defaultKeyStore(dir: string, opts: KeyStoreOptions = {}): KeyStore {
  const secrets = "secrets" in opts ? opts.secrets : Bun.secrets;
  const timeoutMs = opts.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
  const preferred = preferredKeyStore(opts.platform ?? process.platform, opts.macosSigned ?? false);
  const file = fileKeyStore(dir);

  const keychain = {
    async get(domain: string): Promise<string | null> {
      if (!secrets) return null;
      try {
        return (
          (await withTimeout(secrets.get({ service: SERVICE, name: domain }), timeoutMs)) || null
        );
      } catch {
        return null;
      }
    },
    /** True when the key was stored. */
    async set(domain: string, key: string): Promise<boolean> {
      if (!secrets) return false;
      try {
        await withTimeout(secrets.set({ service: SERVICE, name: domain, value: key }), timeoutMs);
        return true;
      } catch {
        return false;
      }
    },
    async delete(domain: string): Promise<void> {
      if (!secrets) return;
      try {
        await withTimeout(secrets.delete({ service: SERVICE, name: domain }), timeoutMs);
      } catch {}
    },
  };

  const order: KeySource[] = preferred === "keychain" ? ["keychain", "file"] : ["file", "keychain"];
  async function lookup(domain: string): Promise<{ key: string; source: KeySource } | null> {
    for (const source of order) {
      const key = source === "keychain" ? await keychain.get(domain) : await file.get(domain);
      if (key) return { key, source };
    }
    return null;
  }

  return {
    async get(domain) {
      return (await lookup(domain))?.key ?? null;
    },
    async source(domain) {
      return (await lookup(domain))?.source ?? null;
    },
    async set(domain, key) {
      if (preferred === "keychain" && (await keychain.set(domain, key))) {
        await file.delete(domain); // don't leave a stale plaintext copy
        return;
      }
      await file.set(domain, key);
    },
    async delete(domain) {
      await file.delete(domain);
      await keychain.delete(domain);
    },
  };
}

/** `--domain` / `TRAY_DOMAIN` → saved current account → error. */
export function resolveDomain(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  accounts: Accounts,
): string {
  if (flag) return normalizeDomain(flag, "--domain");
  if (env.TRAY_DOMAIN) return normalizeDomain(env.TRAY_DOMAIN, "TRAY_DOMAIN");
  if (accounts.current) return normalizeDomain(accounts.current, "current account");
  throw noDomain();
}

/** `TRAY_API_KEY` → saved key for that domain → error. */
export async function resolveKey(
  domain: string,
  env: Record<string, string | undefined>,
  store: KeyStore,
): Promise<string> {
  if (env.TRAY_API_KEY) return env.TRAY_API_KEY;
  const saved = await store.get(domain);
  if (saved) return saved;
  throw notLoggedIn(domain);
}

/**
 * A tray domain from any input (flag, `TRAY_DOMAIN`, prompt, saved state):
 * `acme.dev`, `ACME.dev/`, `https://tray.acme.dev/` → `acme.dev`; `tray.sh`
 * stays `tray.sh`. Parsed with the shared schema (URL + Public Suffix List).
 */
export function normalizeDomain(input: string, source = "domain"): string {
  const parsed = TrayDomainInput.safeParse(input);
  if (!parsed.success) {
    throw usageError(
      `${source}: ${JSON.stringify(input)} isn't a domain`,
      "Use the domain your tray runs on, e.g. acme.dev.",
      "--domain",
    );
  }
  return parsed.data;
}

/**
 * A URL on a tray's API host, e.g. `apiUrl("acme.dev", env, "v1/keys")` →
 * `https://tray.acme.dev/v1/keys`. `TRAY_API_URL` overrides the host (local
 * Worker development); a path in it is kept as the base.
 */
export function apiUrl(domain: string, env: Record<string, string | undefined>, path = ""): string {
  const base = new URL(env.TRAY_API_URL || `https://tray.${domain}`);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(path, base).href;
}

/** The API base URL (ends in `/`). */
export function apiBaseUrl(domain: string, env: Record<string, string | undefined>): string {
  return apiUrl(domain, env);
}
