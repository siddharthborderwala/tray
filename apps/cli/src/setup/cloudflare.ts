// Cloudflare REST API calls for `tray setup` and `tray upgrade`. Plain fetch,
// no SDK, no Wrangler. Every `ensure*` is idempotent: it looks first, then
// creates or updates, so re-running setup fixes whatever is missing.
//
// Endpoints (https://api.cloudflare.com/client/v4):
//   GET  /zones?name=                                    zone + account for the domain
//   GET  /accounts/{a}/access/organizations              Zero Trust enabled? team domain
//   GET  /accounts/{a}/r2/buckets/{name}, POST /accounts/{a}/r2/buckets
//   GET/POST /accounts/{a}/access/identity_providers     one-time PIN login method
//   GET/POST/PUT /accounts/{a}/access/policies[/{id}]    reusable policies
//   GET/POST/PUT /accounts/{a}/access/apps[/{id}]        self-hosted Access apps
//   PUT  /accounts/{a}/workers/scripts/{name}            module upload with bindings
//   PUT  /accounts/{a}/workers/scripts/{name}/content    code only (keeps bindings)
//   PUT  /accounts/{a}/workers/domains                   Worker Custom Domain
//   GET/POST/PUT /zones/{z}/workers/routes[/{id}]        Workers route
//   GET/POST /zones/{z}/dns_records                      proxied wildcard record
import { EXIT, TrayError } from "../errors.ts";

export const API = "https://api.cloudflare.com/client/v4";

/** What the token needs. Printed when Cloudflare refuses a call. */
export const TOKEN_PERMISSIONS =
  "Account: Workers Scripts Edit, Workers R2 Storage Edit, Access: Apps and Policies Edit, " +
  "Access: Organizations, Identity Providers, and Groups Edit. " +
  "Zone (your domain): Zone Read, DNS Edit, Workers Routes Edit.";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

/** A failed Cloudflare call, with the API's error codes. */
export class CloudflareError extends TrayError {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
    hint?: string,
  ) {
    super(
      message,
      status === 401 || status === 403 ? "cloudflare_forbidden" : "cloudflare_error",
      status === 401 || status === 403 ? EXIT.auth : EXIT.failed,
      hint,
    );
  }
}

export interface Zone {
  id: string;
  name: string;
  account: { id: string; name?: string };
}

export interface AccessApp {
  id: string;
  aud: string;
  name: string;
  domain?: string;
  destinations?: { type: string; uri?: string }[];
  [field: string]: unknown;
}

export interface Binding {
  type: "plain_text" | "secret_text" | "r2_bucket";
  name: string;
  text?: string;
  bucket_name?: string;
}

export type CloudflareClient = ReturnType<typeof cloudflare>;

export function cloudflare(token: string, fetchImpl: Fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await fetchImpl(API + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
      });
    } catch (err) {
      throw new TrayError(
        `could not reach the Cloudflare API: ${(err as Error).message}`,
        "network",
        EXIT.failed,
      );
    }
    const data = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !data?.success) {
      const errors = data?.errors ?? [];
      const detail =
        errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${res.status}`;
      const denied =
        res.status === 401 ||
        res.status === 403 ||
        errors.some((e) => e.code === 10000 || e.code === 9109);
      throw new CloudflareError(
        denied ? 403 : res.status,
        errors.map((e) => e.code),
        `Cloudflare API ${method} ${path.split("?")[0]}: ${detail}`,
        denied ? `Check the API token's permissions. It needs ${TOKEN_PERMISSIONS}` : undefined,
      );
    }
    return data;
  }

  const get = async <T>(path: string) => (await call<T>("GET", path)).result;
  const send = async <T>(method: string, path: string, body?: unknown) =>
    (await call<T>(method, path, body)).result;

  /** All pages of a list endpoint. */
  async function list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await call<T[]>("GET", `${path}${sep}page=${page}&per_page=50`);
      out.push(...(data.result ?? []));
      const total = data.result_info?.total_pages ?? 1;
      if (page >= total || (data.result ?? []).length === 0) return out;
    }
  }

  return { get, send, list, call };
}

// --- steps ------------------------------------------------------------------------

export async function findZone(cf: CloudflareClient, domain: string): Promise<Zone> {
  let zones: Zone[];
  try {
    zones = await cf.list<Zone>(`/zones?name=${encodeURIComponent(domain)}`);
  } catch (err) {
    if (
      err instanceof CloudflareError &&
      (err.status === 400 || err.status === 401 || err.status === 403)
    ) {
      throw new TrayError(
        "Cloudflare rejected the API token",
        "cloudflare_forbidden",
        EXIT.auth,
        `Create a token at https://dash.cloudflare.com/profile/api-tokens with ${TOKEN_PERMISSIONS}`,
      );
    }
    throw err;
  }
  const zone = zones.find((z) => z.name === domain);
  if (!zone) {
    throw new TrayError(
      `${domain} isn't a zone on this Cloudflare account`,
      "zone_not_found",
      EXIT.failed,
      "Add the domain to Cloudflare first (the apex, e.g. acme.dev), and give the token Zone Read on it.",
      "--domain",
    );
  }
  return zone;
}

/** The Zero Trust team domain, e.g. `acme.cloudflareaccess.com`. Exits with the enable link when Zero Trust is off. */
export async function zeroTrustTeam(cf: CloudflareClient, accountId: string): Promise<string> {
  const enable = `https://one.dash.cloudflare.com/${accountId}/`;
  let org: { auth_domain?: string } | null = null;
  try {
    org = await cf.get<{ auth_domain?: string }>(`/accounts/${accountId}/access/organizations`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 403) throw err;
    org = null;
  }
  if (!org?.auth_domain) {
    throw new TrayError(
      "Cloudflare Zero Trust isn't enabled on this account",
      "zero_trust_disabled",
      EXIT.failed,
      `Enable it once (the Free plan is fine): ${enable}\nThen run \`tray setup\` again.`,
    );
  }
  return org.auth_domain;
}

export async function ensureBucket(
  cf: CloudflareClient,
  accountId: string,
  name: string,
): Promise<"created" | "exists"> {
  try {
    await cf.get(`/accounts/${accountId}/r2/buckets/${name}`);
    return "exists";
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err;
    if (err.codes.includes(10042)) throw r2NotEnabled(accountId);
    if (err.status !== 404 && !err.codes.includes(10006)) throw err;
  }
  try {
    await cf.send("POST", `/accounts/${accountId}/r2/buckets`, { name });
  } catch (err) {
    if (err instanceof CloudflareError && err.codes.includes(10042)) throw r2NotEnabled(accountId);
    throw err;
  }
  return "created";
}

const r2NotEnabled = (accountId: string) =>
  new TrayError(
    "R2 isn't enabled on this Cloudflare account",
    "r2_disabled",
    EXIT.failed,
    `Enable R2 once in the dashboard: https://dash.cloudflare.com/${accountId}/r2/overview\nThen run \`tray setup\` again.`,
  );

/** The one-time PIN (email code) login method; created if missing. */
export async function ensureOtpLogin(cf: CloudflareClient, accountId: string): Promise<string> {
  const idps = await cf.list<{ id: string; type: string }>(
    `/accounts/${accountId}/access/identity_providers`,
  );
  const otp = idps.find((i) => i.type === "onetimepin");
  if (otp) return otp.id;
  const created = await cf.send<{ id: string }>(
    "POST",
    `/accounts/${accountId}/access/identity_providers`,
    {
      name: "One-time PIN",
      type: "onetimepin",
      config: {},
    },
  );
  return created.id;
}

/** A reusable Access policy, matched by name; its rules are brought up to date. */
export async function ensurePolicy(
  cf: CloudflareClient,
  accountId: string,
  name: string,
  include: unknown[],
): Promise<string> {
  const body = { name, decision: "allow", include };
  const existing = (
    await cf.list<{ id: string; name: string; include?: unknown[] }>(
      `/accounts/${accountId}/access/policies`,
    )
  ).find((p) => p.name === name);
  if (existing) {
    if (JSON.stringify(existing.include) !== JSON.stringify(include)) {
      await cf.send("PUT", `/accounts/${accountId}/access/policies/${existing.id}`, body);
    }
    return existing.id;
  }
  return (await cf.send<{ id: string }>("POST", `/accounts/${accountId}/access/policies`, body)).id;
}

/**
 * A self-hosted Access app, matched by name. `keepExtra` keeps destinations
 * already on the app (the sign-in app also covers custom hosts the Worker added).
 */
export async function ensureAccessApp(
  cf: CloudflareClient,
  accountId: string,
  opts: {
    name: string;
    uris: string[];
    policyId: string;
    idpId: string;
    sessionDuration: string;
    keepExtra?: boolean;
  },
): Promise<AccessApp> {
  const existing = (await cf.list<AccessApp>(`/accounts/${accountId}/access/apps`)).find(
    (a) => a.name === opts.name,
  );
  const kept = opts.keepExtra
    ? (existing?.destinations ?? []).filter((d) => d.type === "public" && d.uri).map((d) => d.uri!)
    : [];
  const uris = [...opts.uris, ...kept.filter((u) => !opts.uris.includes(u))];
  const body = {
    name: opts.name,
    type: "self_hosted",
    domain: uris[0],
    destinations: uris.map((uri) => ({ type: "public", uri })),
    policies: [{ id: opts.policyId, precedence: 1 }],
    allowed_idps: [opts.idpId],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    session_duration: opts.sessionDuration,
  };
  if (existing)
    return cf.send<AccessApp>("PUT", `/accounts/${accountId}/access/apps/${existing.id}`, body);
  return cf.send<AccessApp>("POST", `/accounts/${accountId}/access/apps`, body);
}

/** The Worker bundle embedded in this binary (loaded on demand). */
export const loadWorkerSource = async (): Promise<string> =>
  (await import("./bundle.ts")).WORKER_SOURCE;

export const COMPATIBILITY_DATE = "2026-10-01";
const MODULE_NAME = "worker.js";

function moduleForm(metadata: unknown, source: string): FormData {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    MODULE_NAME,
    new Blob([source], { type: "application/javascript+module" }),
    MODULE_NAME,
  );
  return form;
}

/** Upload the Worker with its full set of bindings (setup). */
export async function uploadWorker(
  cf: CloudflareClient,
  accountId: string,
  name: string,
  source: string,
  bindings: Binding[],
) {
  const metadata = { main_module: MODULE_NAME, compatibility_date: COMPATIBILITY_DATE, bindings };
  await cf.send(
    "PUT",
    `/accounts/${accountId}/workers/scripts/${name}`,
    moduleForm(metadata, source),
  );
}

/** Replace only the Worker's code; bindings and settings stay as they are (upgrade). */
export async function updateWorkerCode(
  cf: CloudflareClient,
  accountId: string,
  name: string,
  source: string,
) {
  await cf.send(
    "PUT",
    `/accounts/${accountId}/workers/scripts/${name}/content`,
    moduleForm({ main_module: MODULE_NAME }, source),
  );
}

export async function ensureCustomDomain(
  cf: CloudflareClient,
  accountId: string,
  zoneId: string,
  hostname: string,
  service: string,
) {
  await cf.send("PUT", `/accounts/${accountId}/workers/domains`, {
    hostname,
    service,
    zone_id: zoneId,
  });
}

export async function ensureRoute(
  cf: CloudflareClient,
  zoneId: string,
  pattern: string,
  script: string,
) {
  const routes = await cf.get<{ id: string; pattern: string; script?: string }[]>(
    `/zones/${zoneId}/workers/routes`,
  );
  const existing = routes.find((r) => r.pattern === pattern);
  if (existing?.script === script) return;
  if (existing)
    await cf.send("PUT", `/zones/${zoneId}/workers/routes/${existing.id}`, { pattern, script });
  else await cf.send("POST", `/zones/${zoneId}/workers/routes`, { pattern, script });
}

/**
 * Proxied hostnames under `<domain>` that the `*.<domain>/*` route now sends
 * to Tray (so they show the Tray 404). Best effort: `[]` if listing fails.
 */
export async function subdomainsTakenOver(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<string[]> {
  try {
    const records = await cf.list<{ name: string; proxied?: boolean }>(
      `/zones/${zoneId}/dns_records?proxied=true`,
    );
    const ours = new Set([`*.${domain}`, `tray.${domain}`]);
    const names = records
      .filter((r) => r.proxied && r.name.endsWith(`.${domain}`) && !ours.has(r.name))
      .map((r) => r.name);
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

/**
 * `*.<domain>` must resolve through Cloudflare's proxy for the route to run.
 * Creates a proxied placeholder AAAA (100::) if no wildcard record exists.
 * Returns a warning when an existing wildcard record isn't proxied.
 */
export async function ensureWildcardDns(
  cf: CloudflareClient,
  zoneId: string,
  domain: string,
): Promise<string | undefined> {
  const name = `*.${domain}`;
  const records = await cf.list<{ id: string; name: string; type: string; proxied?: boolean }>(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  );
  const wildcard = records.filter((r) => r.name === name);
  if (!wildcard.length) {
    await cf.send("POST", `/zones/${zoneId}/dns_records`, {
      type: "AAAA",
      name,
      content: "100::",
      proxied: true,
      comment: "tray: sites on *." + domain,
    });
    return undefined;
  }
  if (!wildcard.some((r) => r.proxied)) {
    return `${name} has a DNS record that isn't proxied; sites won't load until it is (orange cloud in the Cloudflare dashboard).`;
  }
  return undefined;
}
