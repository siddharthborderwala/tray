// What `tray setup` remembers per tray, for re-runs and `tray upgrade`:
//   ~/.config/tray/setup.json   { [domain]: { accountId, zoneId, worker, bucket, email } }
//   keychain / auth.json        the Cloudflare API token, under `cloudflare:<domain>`
import { join } from "node:path";
import { readJson, writeJson } from "../config.ts";
import type { KeyStore } from "../credentials.ts";

export interface SetupRecord {
  accountId: string;
  zoneId: string;
  worker: string;
  bucket: string;
  email: string;
}

const file = (dir: string) => join(dir, "setup.json");

export function loadSetups(dir: string): Record<string, SetupRecord> {
  return readJson<Record<string, SetupRecord>>(file(dir), {});
}

export function saveSetup(dir: string, domain: string, record: SetupRecord): void {
  writeJson(file(dir), { ...loadSetups(dir), [domain]: record });
}

const tokenSlot = (domain: string) => `cloudflare:${domain}`;

export const savedToken = (store: KeyStore, domain: string) => store.get(tokenSlot(domain));
export const saveToken = (store: KeyStore, domain: string, token: string) =>
  store.set(tokenSlot(domain), token);

/** `thts.app` → `tray-thts-app` (valid as both an R2 bucket and a Worker name). */
export function resourceName(domain: string): string {
  return `tray-${domain.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 63).replace(/-+$/, "");
}
