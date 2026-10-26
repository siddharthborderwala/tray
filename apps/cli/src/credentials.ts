// Where API keys live and how the CLI picks a domain + key for a command.
import { join } from "node:path";
import { readJson, writeJson, type Accounts } from "./config.ts";
import { noDomain, notLoggedIn } from "./errors.ts";

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
  const domain = flag || env.TRAY_DOMAIN || accounts.current;
  if (!domain) throw noDomain();
  return normalizeDomain(domain);
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

/** Accept `acme.dev`, `tray.acme.dev`, `https://tray.acme.dev/` and reduce to `acme.dev`. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^tray\./, "");
}

/** API base URL for a tray. `TRAY_API_URL` overrides it (local Worker development). */
export function apiBaseUrl(domain: string, env: Record<string, string | undefined>): string {
  return env.TRAY_API_URL?.replace(/\/+$/, "") || `https://tray.${domain}`;
}
