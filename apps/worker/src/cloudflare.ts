// The few Cloudflare REST API calls the Worker makes, for custom domains:
//
//   attach/detach a Worker Custom Domain
//     PUT    /accounts/{account}/workers/domains            { hostname, service, zone_id }
//     GET    /accounts/{account}/workers/domains?hostname=
//     DELETE /accounts/{account}/workers/domains/{id}
//   add/remove `<host>/.tray/signin` on the single sign-in Access app
//     GET    /accounts/{account}/access/apps/{app}
//     PUT    /accounts/{account}/access/apps/{app}
//   find the host's zone on this account
//     GET    /zones?name=&account.id=
//
// Per-site Access apps don't exist (SPEC.md §5 "Private sites").
import type { Env, Fetch } from "./env.ts";
import { TrayError } from "./errors.ts";

export interface CloudflareApi {
  /** Throws 422 `zone_not_in_account` when the host's zone isn't on this account. */
  attachDomain(host: string): Promise<void>;
  detachDomain(host: string): Promise<void>;
  addSigninHost(host: string): Promise<void>;
  removeSigninHost(host: string): Promise<void>;
}

const API = "https://api.cloudflare.com/client/v4";

export const signinUri = (host: string) => `${host}/.tray/signin`;

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface AccessApp {
  id: string;
  name?: string;
  type?: string;
  domain?: string;
  destinations?: { type: string; uri?: string }[];
  self_hosted_domains?: string[];
  policies?: { id: string; precedence?: number }[];
  [field: string]: unknown;
}

export function cloudflareApi(
  env: Env,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): CloudflareApi {
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;

  async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!account || !token) {
      throw new TrayError(500, "internal", "the Worker has no Cloudflare API token", {
        hint: "Re-run `tray setup` to store CF_API_TOKEN and CF_ACCOUNT_ID on the Worker.",
      });
    }
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !data?.success) {
      const detail =
        data?.errors?.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${res.status}`;
      throw new TrayError(
        502,
        "internal",
        `Cloudflare API ${method} ${path.split("?")[0]} failed: ${detail}`,
      );
    }
    return data.result;
  }

  async function findZone(host: string): Promise<string | null> {
    const labels = host.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await cf<{ id: string; name: string }[]>(
        "GET",
        `/zones?name=${encodeURIComponent(name)}&account.id=${account}`,
      );
      const zone = zones.find((z) => z.name === name);
      if (zone) return zone.id;
    }
    return null;
  }

  async function updateSigninApp(change: (uris: string[]) => string[]) {
    const appId = env.ACCESS_SIGNIN_APP_ID;
    if (!appId) {
      throw new TrayError(500, "internal", "the Worker doesn't know its sign-in Access app", {
        hint: "Re-run `tray setup` to store ACCESS_SIGNIN_APP_ID on the Worker.",
      });
    }
    const app = await cf<AccessApp>("GET", `/accounts/${account}/access/apps/${appId}`);
    const current = app.destinations?.length
      ? app.destinations.filter((d) => d.type === "public" && d.uri).map((d) => d.uri!)
      : (app.self_hosted_domains ?? (app.domain ? [app.domain] : []));
    const next = change(current);
    if (next.length === current.length && next.every((u, i) => u === current[i])) return;

    // PUT takes the whole app. Drop read-only fields; keep policies by id.
    const {
      id: _id,
      aud: _aud,
      created_at: _c,
      updated_at: _u,
      self_hosted_domains: _s,
      policies,
      ...rest
    } = app;
    await cf("PUT", `/accounts/${account}/access/apps/${appId}`, {
      ...rest,
      domain: next[0],
      destinations: next.map((uri) => ({ type: "public", uri })),
      ...(policies
        ? { policies: policies.map((p) => ({ id: p.id, precedence: p.precedence })) }
        : {}),
    });
  }

  return {
    async attachDomain(host) {
      const zoneId = await findZone(host);
      if (!zoneId) {
        throw new TrayError(
          422,
          "zone_not_in_account",
          `${host} isn't on this Cloudflare account`,
          {
            param: "host",
            hint: "Add the domain's zone to the Cloudflare account that runs this tray (v1 only supports same-account custom domains).",
          },
        );
      }
      await cf("PUT", `/accounts/${account}/workers/domains`, {
        hostname: host,
        service: env.WORKER_NAME || "tray",
        zone_id: zoneId,
      });
    },

    async detachDomain(host) {
      const domains = await cf<{ id: string; hostname: string }[]>(
        "GET",
        `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(host)}`,
      );
      for (const d of domains.filter((d) => d.hostname === host)) {
        await cf("DELETE", `/accounts/${account}/workers/domains/${d.id}`);
      }
    },

    addSigninHost: (host) =>
      updateSigninApp((uris) =>
        uris.includes(signinUri(host)) ? uris : [...uris, signinUri(host)],
      ),
    removeSigninHost: (host) =>
      updateSigninApp((uris) => uris.filter((u) => u !== signinUri(host))),
  };
}
