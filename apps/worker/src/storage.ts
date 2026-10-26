// R2 layout (SPEC.md §2) and small helpers around it.
import type { Manifest, Site, Source, Visibility } from "@tray-sh/schema";
import type { Env, R2Bucket } from "./env.ts";

export const paths = {
  blob: (hash: string) => `blobs/${hash}`,
  sitesPrefix: "sites/",
  sitePrefix: (site: string) => `sites/${site}/`,
  meta: (site: string) => `sites/${site}/meta.json`,
  current: (site: string) => `sites/${site}/current`,
  deploysPrefix: (site: string) => `sites/${site}/deploys/`,
  deploy: (site: string, id: string) => `sites/${site}/deploys/${id}.json`,
  hostsPrefix: "hosts/",
  host: (host: string) => `hosts/${host}`,
  keysPrefix: "keys/",
  key: (id: string) => `keys/${id}.json`,
  pending: (deviceCode: string) => `auth/pending/${deviceCode}.json`,
  code: (userCode: string) => `auth/codes/${userCode}`,
  /** Marks a setup key as claimed, so revoking it later can't be undone by the secret. */
  setupKeyClaimed: (id: string) => `auth/setup-keys/${id}`,
};

export interface SiteMeta {
  visibility: Visibility;
  /** Emails and `@domain`s, lowercase. The owner (`createdBy`) is implicit. */
  sharedWith: string[];
  createdBy: string;
  source?: Source;
  /** Custom hosts (mirror of `hosts/*`, kept here so listing sites is cheap). */
  domains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DeployRecord {
  id: string;
  files: Manifest;
  spa: boolean;
  createdAt: string;
  createdBy: string;
}

export interface HostRecord {
  site: string;
  createdAt: string;
}

export interface KeyRecord {
  id: string;
  /** Full sha256(key), hex. */
  hash: string;
  name: string;
  email: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PendingDevice {
  userCode: string;
  name: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied";
  lastPollAt?: string;
  /** Set on approval; handed out once by `POST /auth/token`. */
  key?: string;
  email?: string;
}

export async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  return obj ? obj.json<T>() : null;
}

export async function putJson(
  bucket: R2Bucket,
  key: string,
  value: unknown,
  customMetadata?: Record<string, string>,
) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
    ...(customMetadata ? { customMetadata } : {}),
  });
}

export async function getText(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
}

/** Every object under `prefix`, following cursors. */
export async function listAll(
  bucket: R2Bucket,
  prefix: string,
  include?: ("customMetadata" | "httpMetadata")[],
) {
  const objects = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, ...(include ? { include } : {}) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const now = () => new Date().toISOString();

export function siteUrl(env: Env, site: string) {
  return `https://${site}.${env.DOMAIN}`;
}

export function toSite(env: Env, name: string, meta: SiteMeta, current: string | null): Site {
  return {
    name,
    url: siteUrl(env, name),
    visibility: meta.visibility,
    currentDeploy: current,
    domains: meta.domains,
    shareCount: 1 + meta.sharedWith.length,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export async function loadSite(env: Env, name: string) {
  const [meta, current] = await Promise.all([
    getJson<SiteMeta>(env.BUCKET, paths.meta(name)),
    getText(env.BUCKET, paths.current(name)),
  ]);
  return meta ? { meta, current } : null;
}

// --- crypto helpers ----------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (for equal-length hex digests). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
