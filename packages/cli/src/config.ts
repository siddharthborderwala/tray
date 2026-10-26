// Local state in ~/.config/tray (or $XDG_CONFIG_HOME/tray).
//
//   accounts.json   { current, accounts: { [domain]: { email, keyName } } }
//   auth.json       { [domain]: key }   (only when the keychain is unavailable; mode 600)
//   sites.json      { [domain]: { [site]: { absolutePath, machineId } } }
//   machine.json    { machineId }
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

export function configDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tray");
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown, mode?: number): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
  if (mode) chmodSync(file, mode); // writeFileSync's mode only applies on create
}

// --- accounts ---------------------------------------------------------------

export interface Account {
  email: string;
  keyName: string;
}
export interface Accounts {
  current?: string;
  accounts: Record<string, Account>;
}

export function loadAccounts(dir: string): Accounts {
  const a = readJson<Accounts>(join(dir, "accounts.json"), { accounts: {} });
  return { current: a.current, accounts: a.accounts ?? {} };
}

export function saveAccounts(dir: string, accounts: Accounts): void {
  writeJson(join(dir, "accounts.json"), accounts);
}

// --- site records (name-conflict detection) --------------------------------

export interface SiteRecord {
  absolutePath: string;
  machineId: string;
}

type SiteRecords = Record<string, Record<string, SiteRecord>>;

export function getSiteRecord(dir: string, domain: string, site: string): SiteRecord | undefined {
  return readJson<SiteRecords>(join(dir, "sites.json"), {})[domain]?.[site];
}

export function setSiteRecord(dir: string, domain: string, site: string, record: SiteRecord | undefined): void {
  const file = join(dir, "sites.json");
  const all = readJson<SiteRecords>(file, {});
  const forDomain = (all[domain] ??= {});
  if (record) forDomain[site] = record;
  else delete forDomain[site];
  writeJson(file, all);
}

// --- machine identity -------------------------------------------------------

export function machineId(dir: string): string {
  const file = join(dir, "machine.json");
  const existing = readJson<{ machineId?: string }>(file, {}).machineId;
  if (existing) return existing;
  const id = crypto.randomUUID();
  writeJson(file, { machineId: id });
  return id;
}

/** Short host name used as the default device/key name: `mbp.local` → `mbp`. */
export function shortHostname(): string {
  return osHostname().replace(/\.local$/, "").toLowerCase();
}
