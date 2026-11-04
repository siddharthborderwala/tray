// Serving sites on `<site>.<domain>` and custom hosts (SPEC.md §5 "Serving"
// and "Private sites").
import type { Manifest, ManifestEntry } from "@tray-sh/schema";
import { SiteName } from "@tray-sh/schema";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { accessToken } from "./access.ts";
import { messagePage, notFoundPage, PAGE_HEADERS } from "./pages.ts";
import type { Ctx } from "./router.ts";
import {
  type DeployRecord,
  getJson,
  getText,
  type HostRecord,
  paths,
  siteOwner,
  type SiteMeta,
} from "./storage.ts";
import { trayDomain } from "./domain.ts";
import { faviconBytes } from "./assets/favicon.ts";
import { injectInto, scannableType } from "./inject.ts";
import { ME_PATH, TOOLBAR_JS, TOOLBAR_PATH, TOOLBAR_VERSION, toolbarTag } from "./toolbar.ts";
import type { ToolbarMe } from "./toolbar-types.ts";

export const SIGNIN_PATH = "/.tray/signin";
export const SIGNOUT_PATH = "/.tray/signout";
/**
 * Who's signed in, as `__Host-tray_signin`: set by this Worker, for this host
 * only, HttpOnly. `CF_Authorization` isn't trusted on site pages, because a
 * sibling site's script can set one for the whole domain (and pick who you are).
 */
const SIGNIN_COOKIE = "tray_signin";
const SIGNIN_MAX_AGE = 24 * 60 * 60; // Access's default session; the JWT's own exp still applies

// Deploys are immutable, so manifests can be cached per isolate.
const manifests = new Map<string, DeployRecord>();
const MANIFEST_CACHE_SIZE = 100;

async function loadDeploy(c: Context<Ctx>, site: string, id: string) {
  const cacheKey = `${trayDomain(c.env)}/${site}/${id}`;
  const hit = manifests.get(cacheKey);
  if (hit) return hit;
  const record = await getJson<DeployRecord>(c.env.BUCKET, paths.deploy(site, id));
  if (record) {
    if (manifests.size >= MANIFEST_CACHE_SIZE) manifests.delete(manifests.keys().next().value!);
    manifests.set(cacheKey, record);
  }
  return record;
}

export function hostOf(c: Context): string {
  const header = c.req.header("host");
  return (header ? new URL(`http://${header}`) : new URL(c.req.url)).hostname;
}

/** Site name for a host: `<site>.<domain>` directly, anything else via `hosts/<host>`. */
async function siteForHost(c: Context<Ctx>, host: string): Promise<string | null> {
  const suffix = `.${trayDomain(c.env)}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    return SiteName.safeParse(label).success ? label : null;
  }
  const record = await getJson<HostRecord>(c.env.BUCKET, paths.host(host));
  return record?.site ?? null;
}

export function canView(meta: SiteMeta, email: string, owner: string = meta.createdBy) {
  const e = email.toLowerCase();
  const domain = "@" + e.split("@").pop();
  return (
    owner.toLowerCase() === e || meta.sharedWith.includes(e) || meta.sharedWith.includes(domain)
  );
}

export type Resolved = { entry: ManifestEntry; status: 200 | 404 } | { redirect: string } | null;

/** `/x` → `/x.html` → `/x/` (redirect) → `/x/index.html` → SPA `/index.html` → `/404.html` → null (Tray 404). */
export function resolvePath(files: Manifest, path: string, spa: boolean): Resolved {
  if (path.endsWith("/")) {
    const index = files[path + "index.html"];
    if (index) return { entry: index, status: 200 };
  } else {
    const direct = files[path] ?? files[path + ".html"];
    if (direct) return { entry: direct, status: 200 };
    if (files[path + "/index.html"]) return { redirect: path + "/" };
  }
  if (spa && files["/index.html"]) return { entry: files["/index.html"], status: 200 };
  if (files["/404.html"]) return { entry: files["/404.html"], status: 404 };
  return null;
}

function trayNotFound(c: Context<Ctx>, email: string | null) {
  const url = new URL(c.req.url);
  const html = notFoundPage(url.pathname + url.search, email);
  const headers = { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS };
  return c.req.method === "HEAD" ? c.body(null, 404, headers) : c.body(html, 404, headers);
}

/** Who's signed in on this host: our own sign-in cookie, or (on /.tray/signin) what Access passed in. */
async function viewer(
  c: Context<Ctx>,
  token: string | undefined = getCookie(c, SIGNIN_COOKIE, "host"),
): Promise<string | null> {
  if (!token) return null;
  const verified = await c.var.deps.verifyAccess(token, {
    teamDomain: c.env.ACCESS_TEAM_DOMAIN,
    aud: c.env.ACCESS_SIGNIN_AUD,
  });
  return verified?.email ?? null;
}

/** Only same-host relative paths, so this can't become an open redirect. */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if ([...next].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "/";
  const base = "https://tray.invalid";
  const url = new URL(next, base);
  // Dot segments normalise away (`/.//evil.com` → `//evil.com`), so check the result too.
  if (url.origin !== base || url.pathname.startsWith("//") || url.pathname.startsWith("/.tray/"))
    return "/";
  return url.pathname + url.search + url.hash;
}

/** `/.tray/signin` sits behind the sign-in Access app; once Access lets the visitor through, send them on. */
async function signin(c: Context<Ctx>) {
  const token = accessToken(c);
  if (!(await viewer(c, token))) {
    return c.html(
      messagePage(
        "Sign-in didn't complete",
        "Cloudflare Access didn't vouch for this request. Try again.",
      ),
      403,
      PAGE_HEADERS,
    );
  }
  setCookie(c, SIGNIN_COOKIE, token!, {
    prefix: "host",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SIGNIN_MAX_AGE,
  });
  return c.redirect(safeNext(c.req.query("next")), 302);
}

/** Forget our cookie, then let Access end its session too. */
function signout(c: Context<Ctx>) {
  deleteCookie(c, SIGNIN_COOKIE, { prefix: "host", path: "/", secure: true });
  return c.redirect("/cdn-cgi/access/logout", 302);
}

/**
 * The site for this host, who's signed in here (`email`), and whether they may
 * see it. Private sites always check sign-in; public ones only when our cookie
 * is present, so anonymous visits to public sites cost no extra work.
 */
async function lookup(c: Context<Ctx>) {
  // The same lookups happen whether or not the site exists or is private, so
  // a missing site, a private one without sign-in, and one not shared with
  // the visitor are indistinguishable (SPEC.md §5 "Private sites").
  const name = (await siteForHost(c, hostOf(c))) ?? "-";
  const [meta, current] = await Promise.all([
    getJson<SiteMeta>(c.env.BUCKET, paths.meta(name)),
    getText(c.env.BUCKET, paths.current(name)),
  ]);
  const signedIn =
    !meta || meta.visibility === "private" || getCookie(c, SIGNIN_COOKIE, "host") !== undefined;
  const email = signedIn ? await viewer(c) : null;
  const allowed =
    !!meta &&
    !!current &&
    (meta.visibility === "public" || (!!email && canView(meta, email, siteOwner(meta, c.env))));
  return { name, meta, current, email, allowed };
}

// No cache headers (Tray sets none); the toolbar fetches this with `cache: "no-store"`.
const ME_HEADERS = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

/**
 * `/.tray/me`: who's signed in here, for the toolbar. Same-origin only; the
 * share list only goes to the owner. Anyone else gets the same 404.
 */
async function me(c: Context<Ctx>) {
  const fetchSite = c.req.header("sec-fetch-site");
  const { name, meta, email, allowed } = await lookup(c);
  if (!meta || !email || !allowed || (fetchSite && fetchSite !== "same-origin"))
    return c.json({ error: "not found" }, 404, ME_HEADERS);
  const owner = siteOwner(meta, c.env);
  const you = email.toLowerCase();
  const isOwner = you === owner;
  const body: ToolbarMe = {
    email: you,
    role: isOwner ? "owner" : "viewer",
    site: name,
    host: hostOf(c),
    visibility: meta.visibility,
    owner,
    ...(isOwner ? { sharedWith: meta.sharedWith } : {}),
  };
  return c.json(body, 200, ME_HEADERS);
}

function toolbarScript(c: Context<Ctx>) {
  return c.body(TOOLBAR_JS, 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
}

export const FAVICON_PATH = "/favicon.ico";

/**
 * Tray's favicon, for every artifact without its own /favicon.ico (browsers
 * ask for that path when a page names no icon). The same bytes for missing,
 * private and unshared sites, so it reveals nothing.
 */
export function defaultFavicon(c: Context) {
  const bytes = faviconBytes();
  const headers = {
    "content-type": "image/x-icon",
    "content-length": String(bytes.byteLength),
    "x-content-type-options": "nosniff",
  };
  return c.req.method === "HEAD"
    ? c.body(null, 200, headers)
    : c.body(bytes as Uint8Array<ArrayBuffer>, 200, headers);
}

export async function serveSite(c: Context<Ctx>): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.text("Method Not Allowed", 405, { allow: "GET, HEAD" });
  }
  const url = new URL(c.req.url);
  if (url.pathname === SIGNIN_PATH) return signin(c);
  if (url.pathname === SIGNOUT_PATH) return signout(c);
  if (url.pathname === ME_PATH) return me(c);
  if (url.pathname === TOOLBAR_PATH) return toolbarScript(c);

  const { name, meta, current, email, allowed } = await lookup(c);
  const favicon = url.pathname === FAVICON_PATH;
  if (!meta || !current || !allowed) return favicon ? defaultFavicon(c) : trayNotFound(c, email);

  const deploy = await loadDeploy(c, name, current);
  if (!deploy) return favicon ? defaultFavicon(c) : trayNotFound(c, email);
  // Their own favicon.ico wins; otherwise ours, before any SPA or 404.html fallback.
  if (favicon && !deploy.files[FAVICON_PATH]) return defaultFavicon(c);

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return trayNotFound(c, email);
  }
  const resolved = resolvePath(deploy.files, path, deploy.spa);
  if (!resolved) return trayNotFound(c, email);
  if ("redirect" in resolved) return c.redirect(encodeURI(resolved.redirect) + url.search, 301);

  const { entry, status } = resolved;
  // Signed-in visitors get the toolbar on HTML pages (when it can go in safely: see inject.ts).
  const toolbar = !!email && scannableType(entry.type);
  // Weak: Cloudflare's edge drops strong ETags (it may re-encode the body), but keeps weak ones.
  // The toolbar's own version is part of it, so a new toolbar isn't served from a stale cache.
  const etag = toolbar ? `"${entry.hash}-${TOOLBAR_VERSION}"` : `"${entry.hash}"`;
  const headers: Record<string, string> = {
    etag: `W/${etag}`,
    "content-type": entry.type || "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (status === 200 && matches(c.req.header("if-none-match"), etag))
    return c.body(null, 304, headers);

  // HEAD with the toolbar: the length depends on the scan, so leave it out.
  if (c.req.method === "HEAD")
    return c.body(
      null,
      status,
      toolbar ? headers : { ...headers, "content-length": String(entry.size) },
    );
  const blob = await c.env.BUCKET.get(paths.blob(entry.hash));
  if (!blob) return c.text("Internal Server Error: file content missing", 500);
  if (!toolbar)
    return c.body(blob.body, status, { ...headers, "content-length": String(blob.size) });
  const { stream, injected } = await injectInto(blob.body, toolbarTag(url.origin));
  const length = blob.size + (injected ? toolbarTag(url.origin).byteLength : 0);
  return c.body(stream, status, { ...headers, "content-length": String(length) });
}

/** Weak comparison (RFC 9110 §8.8.3.2): `W/"x"` and `"x"` both match. */
function matches(ifNoneMatch: string | undefined, etag: string) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}
