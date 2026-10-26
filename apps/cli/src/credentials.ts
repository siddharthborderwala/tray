// Where API keys live and how the CLI picks a domain + key for a command.
import { join } from "node:path";
import { readJson, writeJson, type Accounts } from "./config.ts";
import { TrayDomainInput } from "@tray-sh/schema";
import { noDomain, notLoggedIn, usageError } from "./errors.ts";

export interface KeyStore {
  get(domain: string): Promise<string | null>;
  set(domain: string, key: string): Promise<void>;
  delete(domain: string): Promise<void>;
  /** Where the saved key for `domain` lives, for `tray whoami`. */
  source?(domain: string): Promise<"keychain" | "file" | null>;
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

/** OS keychain via Bun.secrets, falling back to auth.json when it is unavailable. */
export function defaultKeyStore(
  dir: string,
  secrets: typeof Bun.secrets | undefined = Bun.secrets,
): KeyStore {
  const file = fileKeyStore(dir);
  const fromKeychain = async (domain: string) => {
    try {
      return (await secrets?.get({ service: SERVICE, name: domain })) || null;
    } catch {
      return null;
    }
  };
  return {
    async get(domain) {
      return (await fromKeychain(domain)) ?? file.get(domain);
    },
    async source(domain) {
      if (await fromKeychain(domain)) return "keychain";
      return (await file.get(domain)) ? "file" : null;
    },
    async set(domain, key) {
      try {
        if (!secrets) throw new Error("no keychain");
        await secrets.set({ service: SERVICE, name: domain, value: key });
        await file.delete(domain); // don't leave a stale plaintext copy
        return;
      } catch {}
      await file.set(domain, key);
    },
    async delete(domain) {
      try {
        await secrets?.delete({ service: SERVICE, name: domain });
      } catch {}
      await file.delete(domain);
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
