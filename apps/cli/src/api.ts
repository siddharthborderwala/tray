// The only module that talks to the Tray Worker (API v1, SPEC.md §5).
//
// Typed with Hono's `hc` client from the Worker's route definitions
// (`AppType`), so a changed path, param, body or response shape is a type
// error here. Request and response types for the rest of the CLI are derived
// from the client below rather than written by hand.
import { ApiError } from "@tray-sh/schema";
import type { AppType } from "@tray-sh/worker";
import { hc, type ClientResponse, type InferRequestType } from "hono/client";
import { EXIT, TrayError } from "./errors.ts";
import { VERSION } from "./version.ts";

export interface ApiOptions {
  /** e.g. `https://tray.acme.dev` (the `/v1` prefix is added here). */
  baseUrl: string;
  key?: string;
  fetch?: typeof fetch;
  /** Called once if the Worker reports an older `tray-version` than this CLI. */
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
    readonly body?: ApiError,
  ) {
    super(message, code, exit, hint, body?.param);
  }
}

export function exitForStatus(status: number): TrayError["exit"] {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 400) return EXIT.usage;
  return EXIT.failed;
}

/** Turn an HTTP error into an ApiFailure, using the `{ error, code, hint, param }` body when present. */
export function apiError(res: { status: number; headers: Headers }, body: unknown): ApiFailure {
  const parsed = ApiError.safeParse(body);
  const ray = res.status >= 500 ? res.headers.get("cf-ray") : null;
  const rayHint = ray ? `Request id (cf-ray): ${ray}` : undefined;
  if (parsed.success) {
    const { error, code, hint } = parsed.data;
    const fullHint = [hint, rayHint].filter(Boolean).join("\n") || undefined;
    return new ApiFailure(
      error,
      code,
      exitForStatus(res.status),
      fullHint,
      res.status,
      parsed.data,
    );
  }
  const code = res.status >= 500 ? "internal" : `http_${res.status}`;
  return new ApiFailure(
    `request failed (HTTP ${res.status})`,
    code,
    exitForStatus(res.status),
    rayHint,
    res.status,
  );
}

/** `a < b` by semver (Bun.semver). Unparseable versions never count as older. */
export function olderThan(a: string, b: string): boolean {
  try {
    return Bun.semver.order(a, b) < 0;
  } catch {
    return false;
  }
}

const enc = encodeURIComponent;

type Client = ReturnType<typeof hc<AppType>>;
/** The JSON body of the 200/201 members of a typed response union. */
type Ok<R> =
  R extends ClientResponse<infer T, infer S, infer F>
    ? S extends 200 | 201
      ? F extends "json"
        ? T
        : never
      : never
    : never;
type OkOf<F extends (...args: any) => any> = Ok<Awaited<ReturnType<F>>>;

// Shapes the commands use, all derived from the Worker's routes.
export type Site = OkOf<Client["sites"][":site"]["$get"]>;
export type Visibility = Site["visibility"];
export type Deploy = OkOf<Client["sites"][":site"]["deploys"]["$get"]>["data"][number];
export type Share = OkOf<Client["sites"][":site"]["shares"]["$get"]>["data"][number];
export type Key = OkOf<Client["keys"]["$get"]>["data"][number];
export type Token = OkOf<Client["auth"]["token"]["$post"]>;
export type DeployRequest = InferRequestType<Client["sites"][":site"]["deploys"]["$post"]>["json"];
export type Manifest = DeployRequest["files"];

export function createApi({ baseUrl, key, fetch: fetchImpl, onOutdated }: ApiOptions) {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const root = new URL("v1", base).href;
  const client = hc<AppType>(root, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const host = new URL(root).host;
  let warned = false;

  /** Run a request: network errors, the version check, and non-2xx → TrayError. */
  async function send<R extends ClientResponse<any>>(request: () => Promise<R>): Promise<R> {
    let res: R;
    try {
      res = await request();
    } catch (err) {
      throw new TrayError(
        `could not reach ${host}: ${(err as Error).message}`,
        "network",
        EXIT.failed,
        "Check your connection and the tray domain.",
      );
    }
    const worker = res.headers.get("tray-version");
    if (worker && !warned && olderThan(worker, VERSION)) {
      warned = true;
      onOutdated?.(worker);
    }
    if (!res.ok) throw apiError(res, await res.json().catch(() => undefined));
    return res;
  }

  /** The typed JSON body of a 2xx response. */
  async function call<R extends ClientResponse<any>>(request: () => Promise<R>): Promise<Ok<R>> {
    const res = await send(request);
    try {
      return (await res.json()) as Ok<R>;
    } catch {
      throw new TrayError(
        `unexpected response from ${host}`,
        "bad_response",
        EXIT.failed,
        "The Worker may be a different version; try `tray upgrade`.",
      );
    }
  }

  /** For 204 responses. */
  async function none(request: () => Promise<ClientResponse<any>>): Promise<void> {
    await send(request);
  }

  const site = (name: string) => ({ param: { site: enc(name) } });

  return {
    // --- blobs ---------------------------------------------------------------
    checkBlobs: (hashes: string[]) => call(() => client.blobs.check.$post({ json: { hashes } })),

    /** PUT one blob. Retries once on a network error or 5xx (a single retry, not throttling). */
    async putBlob(hash: string, data: Uint8Array) {
      // The route declares a binary body; hc can't express that, so the bytes go in `init`.
      const put = () =>
        call(() =>
          client.blobs[":sha256"].$put(
            { param: { sha256: hash } },
            {
              init: {
                body: data,
                headers: {
                  ...(key ? { authorization: `Bearer ${key}` } : {}),
                  "content-type": "application/octet-stream",
                  "content-length": String(data.byteLength),
                },
              },
            },
          ),
        );
      try {
        return await put();
      } catch (err) {
        const retryable =
          err instanceof ApiFailure
            ? err.status >= 500
            : err instanceof TrayError && err.code === "network";
        if (!retryable) throw err;
        return put();
      }
    },

    // --- sites -----------------------------------------------------------------
    listSites: () => call(() => client.sites.$get()),
    /** The site, or null when it doesn't exist. */
    async getSite(name: string): Promise<Site | null> {
      try {
        return await call(() => client.sites[":site"].$get(site(name)));
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 404) return null;
        throw err;
      }
    },
    editSite: (name: string, visibility: Visibility) =>
      call(() => client.sites[":site"].$patch({ ...site(name), json: { visibility } })),
    removeSite: (name: string) => none(() => client.sites[":site"].$delete(site(name))),

    // --- deploys -------------------------------------------------------------------
    /** 201 = new deploy, 200 = same as the current deploy. */
    async deploy(name: string, req: DeployRequest) {
      let status = 0;
      const out = await call(async () => {
        const res = await client.sites[":site"].deploys.$post({ ...site(name), json: req });
        status = res.status;
        return res;
      });
      return { ...out, created: status === 201 };
    },
    listDeploys: (name: string, opts: { limit?: number; before?: string } = {}) =>
      call(() =>
        client.sites[":site"].deploys.$get({
          ...site(name),
          query: {
            ...(opts.limit ? { limit: String(opts.limit) } : {}),
            ...(opts.before ? { before: opts.before } : {}),
          },
        }),
      ),
    rollback: (name: string, to: string) =>
      call(() => client.sites[":site"].rollback.$post({ ...site(name), json: { to } })),

    // --- shares ----------------------------------------------------------------------
    listShares: (name: string) => call(() => client.sites[":site"].shares.$get(site(name))),
    addShares: (name: string, entries: string[]) =>
      call(() => client.sites[":site"].shares.$post({ ...site(name), json: { entries } })),
    removeShare: (name: string, entry: string) =>
      none(() =>
        client.sites[":site"].shares[":entry"].$delete({
          param: { site: enc(name), entry: enc(entry) },
        }),
      ),

    // --- domains -------------------------------------------------------------------
    listDomains: (siteName?: string) =>
      call(() => client.domains.$get({ query: siteName ? { site: siteName } : {} })),
    addDomain: (host: string, siteName: string) =>
      call(() => client.domains.$post({ json: { host, site: siteName } })),
    removeDomain: (h: string) =>
      none(() => client.domains[":host"].$delete({ param: { host: enc(h) } })),

    // --- keys ------------------------------------------------------------------------
    listKeys: () => call(() => client.keys.$get()),
    createKey: (name: string) => call(() => client.keys.$post({ json: { name } })),
    revokeKey: (id: string) => none(() => client.keys[":id"].$delete({ param: { id: enc(id) } })),
    /** Revoke the key making this request (logout). */
    revokeCurrentKey: () => none(() => client.keys.current.$delete()),

    // --- auth (device flow) -------------------------------------------------------------
    startDevice: (name: string) => call(() => client.auth.device.$post({ json: { name } })),
    pollToken: (deviceCode: string) =>
      call(() => client.auth.token.$post({ json: { deviceCode } })),
    getDevice: (userCode: string) =>
      call(() => client.auth.device[":userCode"].$get({ param: { userCode: enc(userCode) } })),
    approveDevice: (userCode: string) =>
      none(() => client.auth.approve.$post({ json: { userCode, approve: true } })),
  };
}
