// Test harness: an in-memory R2 bucket, a fake Cloudflare API, real Access
// JWT verification against a locally generated RSA key, and `app.request()`.
import { sign } from "hono/jwt";
import { createAccessVerifier } from "../src/access.ts";
import { createApp } from "../src/app.ts";
import { createKey } from "../src/auth.ts";
import type { CloudflareApi } from "../src/cloudflare.ts";
import type {
  Env,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../src/env.ts";
import { TrayError } from "../src/errors.ts";

// --- in-memory R2 ----------------------------------------------------------------

interface Stored {
  data: Uint8Array;
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class MemoryBucket implements R2Bucket {
  objects = new Map<string, Stored>();
  calls = { head: 0, get: 0, put: 0, list: 0, delete: 0 };

  private meta(key: string, s: Stored): R2Object {
    const etag = `${key}:${s.data.byteLength}`;
    return {
      key,
      size: s.data.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: s.uploaded,
      customMetadata: s.customMetadata,
    };
  }

  async head(key: string) {
    this.calls.head++;
    const s = this.objects.get(key);
    return s ? this.meta(key, s) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.calls.get++;
    const s = this.objects.get(key);
    if (!s) return null;
    const data = s.data;
    return {
      ...this.meta(key, s),
      body: new Response(data as Uint8Array<ArrayBuffer>).body!,
      text: async () => new TextDecoder().decode(data),
      json: async <T>() => JSON.parse(new TextDecoder().decode(data)) as T,
      arrayBuffer: async () => data.slice().buffer as ArrayBuffer,
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options: R2PutOptions = {},
  ) {
    this.calls.put++;
    const data = await toBytes(value);
    if (options.sha256 && (await sha256(data)) !== options.sha256) {
      throw new Error(
        "put: The SHA-256 checksum you specified did not match what we received. (10037)",
      );
    }
    const s: Stored = { data, customMetadata: options.customMetadata, uploaded: new Date() };
    this.objects.set(key, s);
    return this.meta(key, s);
  }

  async delete(keys: string | string[]) {
    this.calls.delete++;
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    this.calls.list++;
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;
    const start = options.cursor ? Number(options.cursor) : 0;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (!options.startAfter || k > options.startAfter))
      .sort();

    // Collapse delimited prefixes the way R2 does.
    const entries: ({ key: string } | { prefix: string })[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const at = options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if (at >= 0) {
        const p = prefix + rest.slice(0, at + options.delimiter!.length);
        if (!seen.has(p)) {
          entries.push({ prefix: p });
          seen.add(p);
        }
      } else entries.push({ key: k });
    }
    const page = entries.slice(start, start + limit);
    const truncated = start + limit < entries.length;
    return {
      objects: page
        .filter((e): e is { key: string } => "key" in e)
        .map((e) => {
          const o = this.meta(e.key, this.objects.get(e.key)!);
          return options.include?.includes("customMetadata")
            ? o
            : { ...o, customMetadata: undefined };
        }),
      delimitedPrefixes: page
        .filter((e): e is { prefix: string } => "prefix" in e)
        .map((e) => e.prefix),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    };
  }

  async json<T>(key: string): Promise<T | null> {
    const s = this.objects.get(key);
    return s ? (JSON.parse(new TextDecoder().decode(s.data)) as T) : null;
  }
}

// --- fake Cloudflare API ----------------------------------------------------------

export class FakeCloudflare implements CloudflareApi {
  calls: string[] = [];
  /** Zones on the account; hosts outside these get `zone_not_in_account`. */
  zones = ["acme.com"];
  signinHosts = new Set<string>();
  workerDomains = new Set<string>();

  async attachDomain(host: string) {
    if (!this.zones.some((z) => host === z || host.endsWith("." + z))) {
      throw new TrayError(422, "zone_not_in_account", `${host} isn't on this Cloudflare account`, {
        param: "host",
      });
    }
    this.calls.push(`attach ${host}`);
    this.workerDomains.add(host);
  }
  async detachDomain(host: string) {
    this.calls.push(`detach ${host}`);
    this.workerDomains.delete(host);
  }
  async addSigninHost(host: string) {
    this.calls.push(`signin+ ${host}`);
    this.signinHosts.add(host);
  }
  async removeSigninHost(host: string) {
    this.calls.push(`signin- ${host}`);
    this.signinHosts.delete(host);
  }
}

// --- Access JWTs ------------------------------------------------------------------

const TEAM = "acme";
const ISSUER = "https://acme.cloudflareaccess.com";
export const APPROVE_AUD = "approve-aud-tag";
export const SIGNIN_AUD = "signin-aud-tag";

const keyPair = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const privateJwk = {
  ...(await crypto.subtle.exportKey("jwk", keyPair.privateKey)),
  kid: "test-kid",
  alg: "RS256",
};
const publicJwk = {
  ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "test-kid",
  alg: "RS256",
};

export const certsFetch = async (input: Request | string | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${ISSUER}/cdn-cgi/access/certs`)
    return Response.json({ keys: [publicJwk], public_certs: [] });
  return new Response("not found", { status: 404 });
};

export function accessJwt(email: string, aud: string, opts: { exp?: number; iss?: string } = {}) {
  const t = Math.floor(Date.now() / 1000);
  return sign(
    {
      email,
      aud: [aud],
      iss: opts.iss ?? ISSUER,
      iat: t,
      nbf: t,
      exp: opts.exp ?? t + 3600,
      sub: "user-id",
    },
    privateJwk as never,
    "RS256",
  );
}

// --- harness ----------------------------------------------------------------------

/** Tests read JSON bodies loosely; the shapes are asserted with expect(). */
// oxlint-disable-next-line no-explicit-any
export type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

export const OWNER = "sid@acme.com";

export async function setup(overrides: Partial<Env> = {}) {
  const bucket = new MemoryBucket();
  const env: Env = {
    BUCKET: bucket,
    DOMAIN: "thts.app",
    OWNER_EMAIL: OWNER,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_APPROVE_AUD: APPROVE_AUD,
    ACCESS_SIGNIN_AUD: SIGNIN_AUD,
    ...overrides,
  };
  const cf = new FakeCloudflare();
  const app = createApp({ cloudflare: () => cf, verifyAccess: createAccessVerifier(certsFetch) });
  const { key } = await createKey(env, "test-machine", OWNER);

  /** Request to the API on tray.thts.app with the owner's key. */
  const api = (path: string, init: RequestInit & { json?: unknown; key?: string | null } = {}) => {
    const { json, key: k = key, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (k) headers.set("authorization", `Bearer ${k}`);
    if (json !== undefined) headers.set("content-type", "application/json");
    return <Promise<TestResponse>>(
      app.request(
        `https://tray.thts.app/v1${path}`,
        { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) },
        env,
      )
    );
  };

  /** Request to any host (sites, custom domains, /approve). */
  const visit = (url: string, init: RequestInit = {}) =>
    <Promise<TestResponse>>app.request(url, init, env);

  /** Upload content as blobs and return a manifest for it. */
  const upload = async (files: Record<string, string | { body: string; type: string }>) => {
    const manifest: Record<string, { hash: string; size: number; type: string }> = {};
    for (const [path, f] of Object.entries(files)) {
      const body = typeof f === "string" ? f : f.body;
      const type = typeof f === "string" ? guessType(path) : f.type;
      const data = new TextEncoder().encode(body);
      const hash = await sha256(data);
      await bucket.put(`blobs/${hash}`, data);
      manifest[path] = { hash, size: data.byteLength, type };
    }
    return manifest;
  };

  /** Upload + deploy in one go. */
  const deploy = async (
    site: string,
    files: Record<string, string | { body: string; type: string }>,
    opts: {
      spa?: boolean;
      visibility?: "public" | "private";
      replace?: boolean;
      source?: { path: string; machine: string };
    } = {},
  ) => {
    const manifest = await upload(files);
    return api(`/sites/${site}/deploys`, {
      method: "POST",
      json: {
        files: manifest,
        spa: opts.spa ?? false,
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
        ...(opts.replace ? { replace: true } : {}),
        source: opts.source ?? { path: `/work/${site}`, machine: "mbp" },
      },
    });
  };

  return { app, env, bucket, cf, key, api, visit, upload, deploy };
}

function guessType(path: string) {
  if (path.endsWith(".html")) return "text/html;charset=utf-8";
  if (path.endsWith(".css")) return "text/css;charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript;charset=utf-8";
  return "application/octet-stream";
}
