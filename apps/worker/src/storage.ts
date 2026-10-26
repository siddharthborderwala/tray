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
  /** The approver, set on approval. `POST /auth/token` mints the key for it once. */
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

/** Up to this many hashes, one `head` each is cheapest. */
const HEAD_LIMIT = 500;

/**
 * The hashes in `hashes` that have no `blobs/<hash>` object, sorted.
 *
 * R2 calls count against the Worker's per-request limit (1,000 on Free), so a
 * large set is swept with sorted `list` pages (up to 1,000 consecutive keys
 * per call) instead of one `head` per hash. Every hash is still checked.
 */
export async function missingBlobs(bucket: R2Bucket, hashes: readonly string[]) {
  const wanted = [...new Set(hashes)].sort();
  const missing: string[] = [];
  const headAll = async (rest: string[]) => {
    const heads = await mapLimit(rest, 50, (h) => bucket.head(paths.blob(h)));
    missing.push(...rest.filter((_, i) => !heads[i]));
  };
  if (wanted.length <= HEAD_LIMIT) {
    await headAll(wanted);
    return missing;
  }

  const prefix = paths.blob("");
  let i = 0;
  while (i < wanted.length) {
    // A strict prefix of the next wanted key sorts just before it.
    const page = await bucket.list({
      prefix,
      startAfter: paths.blob(wanted[i]!).slice(0, -1),
      limit: 1000,
    });
    const found = new Set(page.objects.map((o) => o.key.slice(prefix.length)));
    const lastKey = page.objects.at(-1)?.key.slice(prefix.length);
    if (page.truncated && lastKey === undefined) {
      await headAll(wanted.slice(i)); // shouldn't happen without a delimiter; stay correct anyway
      break;
    }
    // This page settles every wanted hash up to its last key (all of them once the listing ends).
    while (i < wanted.length && (!page.truncated || wanted[i]! <= lastKey!)) {
      if (!found.has(wanted[i]!)) missing.push(wanted[i]!);
      i++;
    }
  }
  return missing;
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
