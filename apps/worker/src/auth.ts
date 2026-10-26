// API keys, the bearer auth middleware, and device-code approval.
import { API_KEY_PREFIX, DEVICE_CODE_TTL_SECONDS } from "@tray-sh/schema";
import type { Context, MiddlewareHandler } from "hono";
import { accessToken } from "./access.ts";
import type { Env } from "./env.ts";
import { TrayError } from "./errors.ts";
import type { Ctx, Identity } from "./router.ts";
import {
  getJson,
  getText,
  type KeyRecord,
  now,
  paths,
  type PendingDevice,
  putJson,
  randomHex,
  safeEqual,
  sha256Hex,
} from "./storage.ts";

// --- keys ----------------------------------------------------------------------

export async function keyId(key: string) {
  const hash = await sha256Hex(key);
  return { id: hash.slice(0, 12), hash };
}

/** Mint a key; the plaintext is returned once and only its hash is stored. */
export async function createKey(env: Env, name: string, email: string) {
  const key = API_KEY_PREFIX + randomHex(24);
  const { id, hash } = await keyId(key);
  const record: KeyRecord = {
    id,
    hash,
    name,
    email: email.toLowerCase(),
    createdAt: now(),
    lastUsedAt: null,
  };
  await putJson(env.BUCKET, paths.key(id), record);
  return { id, name, key };
}

/** Don't rewrite keys/<id>.json on every request; once a minute is plenty for "last used". */
const LAST_USED_RESOLUTION_MS = 60_000;

async function identityFromKey(c: Context<Ctx>, header: string): Promise<Identity | null> {
  const key = header.slice("Bearer ".length).trim();
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const { id, hash } = await keyId(key);
  const record = await getJson<KeyRecord>(c.env.BUCKET, paths.key(id));
  if (!record || !safeEqual(record.hash, hash)) return null;

  const stale =
    !record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > LAST_USED_RESOLUTION_MS;
  if (stale) {
    const write = putJson(c.env.BUCKET, paths.key(id), { ...record, lastUsedAt: now() });
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      await write; // no ExecutionContext (tests, local runs)
    }
  }
  return { email: record.email, keyId: id };
}

/** Identity from the owner Access app on `tray.<domain>/approve`. */
export async function ownerFromAccess(c: Context<Ctx>): Promise<Identity | null> {
  const verified = await c.var.deps.verifyAccess(accessToken(c), {
    teamDomain: c.env.ACCESS_TEAM_DOMAIN,
    aud: c.env.ACCESS_APPROVE_AUD,
  });
  if (!verified) return null;
  if (c.env.OWNER_EMAIL && verified.email !== c.env.OWNER_EMAIL.toLowerCase()) return null;
  return { email: verified.email };
}

const PUBLIC_ROUTES = new Set([
  "POST /v1/auth/device",
  "POST /v1/auth/token",
  "GET /v1/openapi.json",
]);

/** Bearer key on every /v1 route except the public ones. `POST /auth/approve` also accepts the owner's Access identity. */
export const requireAuth: MiddlewareHandler<Ctx> = async (c, next) => {
  if (PUBLIC_ROUTES.has(`${c.req.method} ${c.req.path}`)) return next();

  const header = c.req.header("authorization");
  let identity: Identity | null = null;
  if (header?.startsWith("Bearer ")) identity = await identityFromKey(c, header);
  else if (c.req.method === "POST" && c.req.path === "/v1/auth/approve")
    identity = await ownerFromAccess(c);

  if (!identity) {
    throw new TrayError(
      401,
      "unauthenticated",
      header ? "invalid or revoked API key" : "missing API key",
      {
        hint: `Run \`tray login ${c.env.DOMAIN}\` or set TRAY_API_KEY.`,
      },
    );
  }
  c.set("identity", identity);
  await next();
};

// --- device codes ----------------------------------------------------------------

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // no vowels (no words), no 0/O/1/I

export function newUserCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join(
    "",
  );
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** `qxft7k2m`, `QXFT-7K2M`, ` qxft-7k2m ` → `QXFT-7K2M`. */
export function normalizeUserCode(input: string) {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export async function startDevice(env: Env, name: string, ip: string) {
  let userCode = newUserCode();
  while (await env.BUCKET.head(paths.code(userCode))) userCode = newUserCode();
  const deviceCode = randomHex(32);
  const created = Date.now();
  const pending: PendingDevice = {
    userCode,
    name,
    ip,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
    status: "pending",
  };
  await putJson(env.BUCKET, paths.pending(deviceCode), pending);
  await env.BUCKET.put(paths.code(userCode), deviceCode);
  return { deviceCode, userCode };
}

const expired = () =>
  new TrayError(400, "expired_token", "this code has expired or was already used", {
    param: "userCode",
    hint: "Start again with `tray login`.",
  });

export async function deleteDevice(env: Env, deviceCode: string, userCode: string) {
  await env.BUCKET.delete([paths.pending(deviceCode), paths.code(userCode)]);
}

/** The pending request for a user code, or `expired_token`. */
export async function findDevice(env: Env, userCodeInput: string) {
  const userCode = normalizeUserCode(userCodeInput);
  const deviceCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)
    ? await getText(env.BUCKET, paths.code(userCode))
    : null;
  const pending = deviceCode
    ? await getJson<PendingDevice>(env.BUCKET, paths.pending(deviceCode))
    : null;
  if (!deviceCode || !pending) throw expired();
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    await deleteDevice(env, deviceCode, userCode);
    throw expired();
  }
  return { deviceCode, pending };
}

/** Approve (mint a key for `email`) or deny. Repeating the same decision is a no-op. */
export async function decideDevice(env: Env, userCode: string, approve: boolean, email: string) {
  const { deviceCode, pending } = await findDevice(env, userCode);
  const decision = approve ? "approved" : "denied";
  if (pending.status === decision) return pending;
  if (pending.status !== "pending") throw expired();

  if (approve) {
    const { key } = await createKey(env, pending.name, email);
    Object.assign(pending, { status: "approved", key, email: email.toLowerCase() });
  } else {
    pending.status = "denied";
  }
  await putJson(env.BUCKET, paths.pending(deviceCode), pending);
  return pending;
}
