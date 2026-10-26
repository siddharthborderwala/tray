// The only module that talks to the Tray Worker (API v1, SPEC.md §5).
//
// Hand-typed against @tray/schema (via ./wire.ts) for now. Once packages/worker
// exports `AppType`, replace `hc<any>` with `hc<AppType>` and the compiler will
// flag any drift between the routes below and the Worker.
import { hc } from "hono/client";
import type * as z from "zod";
import { EXIT, TrayError } from "./errors.ts";
import { VERSION } from "./version.ts";
import * as W from "./wire.ts";

export interface ApiOptions {
  /** e.g. `https://tray.thts.app` (the `/v1` prefix is added here). */
  baseUrl: string;
  key?: string;
  fetch?: typeof fetch;
  /** Called once if the Worker reports an older `Tray-Version` than this CLI. */
  onOutdated?: (workerVersion: string) => void;
}

export type Api = ReturnType<typeof createApi>;

/** Raised for any non-2xx response; carries the parsed error body. */
export class ApiFailure extends TrayError {
  constructor(
    message: string,
    code: string,
    exit: TrayError["exit"],
    hint: string | undefined,
    readonly status: number,
    readonly body?: W.ApiError,
  ) {
    super(message, code, exit, hint);
  }
}

export function exitForStatus(status: number): TrayError["exit"] {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 400) return EXIT.usage;
  return EXIT.failed;
}

/** Turn an HTTP error into an ApiFailure, using the `{ error, code, hint, param }` body when present. */
export function apiError(res: { status: number; headers: Headers }, body: unknown): ApiFailure {
  const parsed = W.ApiError.safeParse(body);
  const ray = res.status >= 500 ? res.headers.get("cf-ray") : null;
  const rayHint = ray ? `Request id (cf-ray): ${ray}` : undefined;
  if (parsed.success) {
    const { error, code, hint } = parsed.data;
    const fullHint = [hint, rayHint].filter(Boolean).join("\n") || undefined;
    return new ApiFailure(error, code, exitForStatus(res.status), fullHint, res.status, parsed.data);
  }
  const code = res.status >= 500 ? "internal" : `http_${res.status}`;
  return new ApiFailure(`request failed (HTTP ${res.status})`, code, exitForStatus(res.status), rayHint, res.status);
}

/** `a < b` for plain semver strings (pre-release tags ignored). */
export function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

const enc = encodeURIComponent;

export function createApi({ baseUrl, key, fetch: fetchImpl, onOutdated }: ApiOptions) {
  const root = baseUrl.replace(/\/+$/, "") + "/v1";
  const client: any = hc<any>(root, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const host = new URL(root).host;
  let warned = false;

  async function send(request: () => Promise<Response>): Promise<Response> {
    let res: Response;
    try {
      res = await request();
    } catch (err) {
      throw new TrayError(`could not reach ${host}: ${(err as Error).message}`, "network", EXIT.failed, "Check your connection and the tray domain.");
    }
    const worker = res.headers.get("tray-version");
    if (worker && !warned && olderThan(worker, VERSION)) {
      warned = true;
      onOutdated?.(worker);
    }
    if (!res.ok) throw apiError(res, await res.json().catch(() => undefined));
    return res;
  }

  async function call<T extends z.ZodType>(schema: T, request: () => Promise<Response>): Promise<z.output<T>> {
    const res = await send(request);
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new TrayError(`unexpected response from ${host}`, "bad_response", EXIT.failed, "The Worker may be a different version; try `tray upgrade`.");
    }
    return parsed.data;
  }

  /** For 204 responses. */
  async function none(request: () => Promise<Response>): Promise<void> {
    await send(request);
  }

  const site = (name: string) => ({ param: { site: enc(name) } });

  return {
    // --- blobs ---------------------------------------------------------------
    checkBlobs: (hashes: string[]) => call(W.CheckBlobsResponse, () => client.blobs.check.$post({ json: { hashes } })),

    /** PUT one blob. Retries once on a network error or 5xx (a single retry, not throttling). */
    async putBlob(hash: string, data: Uint8Array) {
      const put = () =>
        call(W.Blob, () =>
          client.blobs[":sha"].$put(
            { param: { sha: hash } },
            {
              init: {
                body: data,
                headers: {
                  ...(key ? { Authorization: `Bearer ${key}` } : {}),
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(data.byteLength),
                },
              },
            },
          ),
        );
      try {
        return await put();
      } catch (err) {
        const retryable = err instanceof ApiFailure ? err.status >= 500 : err instanceof TrayError && err.code === "network";
        if (!retryable) throw err;
        return put();
      }
    },

    // --- sites -----------------------------------------------------------------
    listSites: () => call(W.SiteList, () => client.sites.$get()),
    /** The site, or null when it doesn't exist. */
    async getSite(name: string): Promise<W.Site | null> {
      try {
        return await call(W.Site, () => client.sites[":site"].$get(site(name)));
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 404) return null;
        throw err;
      }
    },
    editSite: (name: string, visibility: W.Visibility) =>
      call(W.Site, () => client.sites[":site"].$patch({ ...site(name), json: { visibility } })),
    removeSite: (name: string) => none(() => client.sites[":site"].$delete(site(name))),

    // --- deploys -------------------------------------------------------------------
    /** 201 = new deploy, 200 = same as the current deploy. */
    async deploy(name: string, req: W.DeployRequest): Promise<W.DeployResponse & { created: boolean }> {
      let status = 0;
      const out = await call(W.DeployResponse, async () => {
        const res: Response = await client.sites[":site"].deploys.$post({ ...site(name), json: req });
        status = res.status;
        return res;
      });
      return { ...out, created: status === 201 };
    },
    listDeploys: (name: string, opts: { limit?: number; before?: string } = {}) =>
      call(W.DeployList, () =>
        client.sites[":site"].deploys.$get({
          ...site(name),
          query: { ...(opts.limit ? { limit: String(opts.limit) } : {}), ...(opts.before ? { before: opts.before } : {}) },
        }),
      ),
    rollback: (name: string, to: string) => call(W.Site, () => client.sites[":site"].rollback.$post({ ...site(name), json: { to } })),

    // --- shares ----------------------------------------------------------------------
    listShares: (name: string) => call(W.ShareList, () => client.sites[":site"].shares.$get(site(name))),
    addShares: (name: string, entries: string[]) =>
      call(W.ShareList, () => client.sites[":site"].shares.$post({ ...site(name), json: { entries } })),
    removeShare: (name: string, entry: string) =>
      none(() => client.sites[":site"].shares[":entry"].$delete({ param: { site: enc(name), entry: enc(entry) } })),

    // --- domains -------------------------------------------------------------------
    listDomains: (siteName?: string) => call(W.DomainList, () => client.domains.$get({ query: siteName ? { site: siteName } : {} })),
    addDomain: (host: string, siteName: string) => call(W.Domain, () => client.domains.$post({ json: { host, site: siteName } })),
    removeDomain: (h: string) => none(() => client.domains[":host"].$delete({ param: { host: enc(h) } })),

    // --- keys ------------------------------------------------------------------------
    listKeys: () => call(W.KeyList, () => client.keys.$get()),
    createKey: (name: string) => call(W.CreatedKey, () => client.keys.$post({ json: { name } })),
    revokeKey: (id: string) => none(() => client.keys[":id"].$delete({ param: { id: enc(id) } })),
    /** Revoke the key making this request (logout). */
    revokeCurrentKey: () => none(() => client.keys.current.$delete()),

    // --- auth (device flow) -------------------------------------------------------------
    startDevice: (name: string) => call(W.DeviceCode, () => client.auth.device.$post({ json: { name } })),
    pollToken: (deviceCode: string) => call(W.Token, () => client.auth.token.$post({ json: { deviceCode } })),
    getDevice: (userCode: string) => call(W.PendingDevice, () => client.auth.device[":code"].$get({ param: { code: enc(userCode) } })),
    approveDevice: (userCode: string) => none(() => client.auth.approve.$post({ json: { userCode, approve: true } })),
  };
}
