// Serving sites on `<site>.<domain>` and custom hosts (SPEC.md §5 "Serving"
// and "Private sites").
import type { Manifest, ManifestEntry } from "@traysh/schema";
import { SITE_NAME_RE } from "@traysh/schema";
import type { Context } from "hono";
import { accessToken } from "./access.ts";
import { messagePage, notFoundPage } from "./pages.ts";
import type { Ctx } from "./router.ts";
import {
  type DeployRecord,
  getJson,
  getText,
  type HostRecord,
  paths,
  type SiteMeta,
} from "./storage.ts";

export const SIGNIN_PATH = "/.tray/signin";

// Deploys are immutable, so manifests can be cached per isolate.
const manifests = new Map<string, DeployRecord>();
const MANIFEST_CACHE_SIZE = 100;

async function loadDeploy(c: Context<Ctx>, site: string, id: string) {
  const cacheKey = `${c.env.DOMAIN}/${site}/${id}`;
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
  return (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase().replace(/:\d+$/, "");
}

/** Site name for a host: `<site>.<domain>` directly, anything else via `hosts/<host>`. */
async function siteForHost(c: Context<Ctx>, host: string): Promise<string | null> {
  const suffix = `.${c.env.DOMAIN.toLowerCase()}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    return SITE_NAME_RE.test(label) ? label : null;
  }
  const record = await getJson<HostRecord>(c.env.BUCKET, paths.host(host));
  return record?.site ?? null;
}

export function canView(meta: SiteMeta, email: string) {
  const e = email.toLowerCase();
  const domain = "@" + e.split("@").pop();
  return (
    meta.createdBy.toLowerCase() === e ||
    meta.sharedWith.includes(e) ||
    meta.sharedWith.includes(domain)
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
  const headers = { "content-type": "text/html; charset=utf-8" };
  return c.req.method === "HEAD" ? c.body(null, 404, headers) : c.body(html, 404, headers);
}

/** Who's signed in on this host, via the sign-in Access app's `CF_Authorization` cookie. */
async function viewer(c: Context<Ctx>): Promise<string | null> {
  const token = accessToken(c);
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
  if (url.origin !== base || url.pathname === SIGNIN_PATH) return "/";
  return url.pathname + url.search + url.hash;
}

/** `/.tray/signin` sits behind the sign-in Access app; once Access lets the visitor through, send them on. */
async function signin(c: Context<Ctx>) {
  if (!(await viewer(c))) {
    return c.html(
      messagePage(
        "Sign-in didn't complete",
        "Cloudflare Access didn't vouch for this request. Try again.",
      ),
      403,
    );
  }
  return c.redirect(safeNext(c.req.query("next")), 302);
}

export async function serveSite(c: Context<Ctx>): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.text("Method Not Allowed", 405, { allow: "GET, HEAD" });
  }
  const url = new URL(c.req.url);
  if (url.pathname === SIGNIN_PATH) return signin(c);

  // The same lookups happen whether or not the site exists or is private, so
  // a missing site, a private one without sign-in, and one not shared with
  // the visitor are indistinguishable (SPEC.md §5 "Private sites").
  const name = (await siteForHost(c, hostOf(c))) ?? "-";
  const [meta, current] = await Promise.all([
    getJson<SiteMeta>(c.env.BUCKET, paths.meta(name)),
    getText(c.env.BUCKET, paths.current(name)),
  ]);

  let email: string | null = null;
  if (!meta || meta.visibility === "private") {
    email = await viewer(c);
    if (!meta || !current || !email || !canView(meta, email)) return trayNotFound(c, email);
  }
  if (!meta || !current) return trayNotFound(c, email);

  const deploy = await loadDeploy(c, name, current);
  if (!deploy) return trayNotFound(c, email);

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
  const etag = `"${entry.hash}"`;
  const headers: Record<string, string> = {
    etag: etag,
    "content-type": entry.type || "application/octet-stream",
    "x-content-type-options": "nosniff",
  };

  if (status === 200 && matches(c.req.header("if-none-match"), etag))
    return c.body(null, 304, headers);

  if (c.req.method === "HEAD")
    return c.body(null, status, { ...headers, "content-length": String(entry.size) });
  const blob = await c.env.BUCKET.get(paths.blob(entry.hash));
  if (!blob) return c.text("Internal Server Error: file content missing", 500);
  return c.body(blob.body, status, { ...headers, "content-length": String(blob.size) });
}

function matches(ifNoneMatch: string | undefined, etag: string) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}
