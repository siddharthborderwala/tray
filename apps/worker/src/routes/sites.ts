import { createRoute, z } from "@hono/zod-openapi";
import {
  Deploy,
  DeployList,
  DeployListQuery,
  DeployRequest,
  DeployResponse,
  EditSiteRequest,
  MAX_DEPLOY_BYTES,
  type Manifest,
  RollbackRequest,
  Site,
  SiteList,
  SiteName,
} from "@tray-sh/schema";
import type { Env } from "../env.ts";
import { siteNotFound, TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import {
  type DeployRecord,
  getJson,
  listAll,
  loadSite,
  mapLimit,
  now,
  paths,
  putJson,
  randomHex,
  type SiteMeta,
  toSite,
} from "../storage.ts";

const siteParam = z.object({ site: SiteName });

// --- routes ---------------------------------------------------------------------

const listSites = createRoute({
  method: "get",
  path: "/sites",
  operationId: "listSites",
  summary: "List sites",
  description:
    "Every site with its URL, visibility, current deploy and custom domains, most recently updated first.",
  security: bearer,
  responses: { 200: json(SiteList, "Sites, most recently updated first"), ...errors() },
});

const getSite = createRoute({
  method: "get",
  path: "/sites/{site}",
  operationId: "getSite",
  summary: "Get a site",
  description: "One site's URL, visibility, current deploy, custom domains and share count.",
  security: bearer,
  request: { params: siteParam },
  responses: { 200: json(Site, "The site"), ...errors(404) },
});

const editSite = createRoute({
  method: "patch",
  path: "/sites/{site}",
  operationId: "updateSite",
  summary: "Change a site's visibility",
  description:
    "`private` limits it to the owner and its share list; `public` makes it visible to anyone with the link. The share list is kept either way.",
  security: bearer,
  request: { params: siteParam, body: body(EditSiteRequest) },
  responses: { 200: json(Site, "The updated site"), ...errors(404) },
});

const deleteSite = createRoute({
  method: "delete",
  path: "/sites/{site}",
  operationId: "deleteSite",
  summary: "Remove a site",
  description:
    "Deletes the site, its deploy records and its custom domains. Blobs are left for later garbage collection.",
  security: bearer,
  request: { params: siteParam },
  responses: { 204: { description: "Removed" }, ...errors(404, 502) },
});

const createDeploy = createRoute({
  method: "post",
  path: "/sites/{site}/deploys",
  operationId: "createDeploy",
  summary: "Deploy a manifest",
  description:
    "Creates the site if needed and makes the manifest live. Returns 200 with the current deploy when `files` and `spa` are unchanged, 409 `site_exists` when the site was last put from another `source` (pass `replace: true`), and 409 `missing_blobs` with `missing` when blobs need uploading first.",
  security: bearer,
  request: { params: siteParam, body: body(DeployRequest) },
  responses: {
    200: json(DeployResponse, "Unchanged: the manifest equals the current deploy"),
    201: json(DeployResponse, "New deploy"),
    ...errors(409, 413),
  },
});

const listDeploys = createRoute({
  method: "get",
  path: "/sites/{site}/deploys",
  operationId: "listDeploys",
  summary: "List deploys",
  description:
    "Newest first. Page with `limit` (default 20, max 100) and `before=<deployId>`; `hasMore` says whether older deploys exist.",
  security: bearer,
  request: { params: siteParam, query: DeployListQuery },
  responses: { 200: json(DeployList, "A page of deploys"), ...errors(404) },
});

const rollback = createRoute({
  method: "post",
  path: "/sites/{site}/rollback",
  operationId: "rollbackSite",
  summary: "Roll a site back to a deploy",
  description: "Makes deploy `to` live. `to` is required; list deploys to pick one.",
  security: bearer,
  request: { params: siteParam, body: body(RollbackRequest) },
  responses: { 200: json(Site, "The site, now serving `to`"), ...errors(404) },
});

// --- helpers --------------------------------------------------------------------

/** Sortable by time: base36 milliseconds (8 chars until 2059) + random suffix, e.g. `mh7q2k1c-8f1a`. */
export function newDeployId(at = Date.now()) {
  return `${at.toString(36)}-${randomHex(2)}`;
}

function sameDeploy(a: DeployRecord, files: Manifest, spa: boolean) {
  if (a.spa !== spa) return false;
  const keys = Object.keys(files);
  if (keys.length !== Object.keys(a.files).length) return false;
  return keys.every((k) => {
    const x = a.files[k];
    const y = files[k]!;
    return x !== undefined && x.hash === y.hash && x.size === y.size && x.type === y.type;
  });
}

function deploySummary(d: DeployRecord): Deploy {
  const entries = Object.values(d.files);
  return {
    id: d.id,
    files: entries.length,
    bytes: entries.reduce((n, f) => n + f.size, 0),
    spa: d.spa,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
  };
}

async function requireSite(env: Env, name: string) {
  const site = await loadSite(env, name);
  if (!site) throw siteNotFound(name);
  return site;
}

// --- handlers -------------------------------------------------------------------

export const sites = newRouter()
  .openapi(listSites, async (c) => {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.BUCKET.list({ prefix: paths.sitesPrefix, delimiter: "/", cursor });
      names.push(...page.delimitedPrefixes.map((p) => p.slice(paths.sitesPrefix.length, -1)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const loaded = await mapLimit(names, 50, async (name) => ({
      name,
      site: await loadSite(c.env, name),
    }));
    const data = loaded
      .filter((x) => x.site)
      .map(({ name, site }) => toSite(c.env, name, site!.meta, site!.current))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ data }, 200);
  })

  .openapi(getSite, async (c) => {
    const { site: name } = c.req.valid("param");
    const { meta, current } = await requireSite(c.env, name);
    return c.json(toSite(c.env, name, meta, current), 200);
  })

  .openapi(editSite, async (c) => {
    const { site: name } = c.req.valid("param");
    const { visibility } = c.req.valid("json");
    const { meta, current } = await requireSite(c.env, name);
    if (meta.visibility !== visibility) {
      meta.visibility = visibility;
      meta.updatedAt = now();
      await putJson(c.env.BUCKET, paths.meta(name), meta);
    }
    return c.json(toSite(c.env, name, meta, current), 200);
  })

  .openapi(deleteSite, async (c) => {
    const { site: name } = c.req.valid("param");
    const { meta } = await requireSite(c.env, name);
    if (meta.domains.length) {
      const cf = c.var.deps.cloudflare(c.env);
      for (const host of meta.domains) {
        await cf.detachDomain(host);
        await cf.removeSigninHost(host);
        await c.env.BUCKET.delete(paths.host(host));
      }
    }
    // Everything under sites/<site>/ (meta, current, deploy records). Blobs stay for a later gc.
    const keys = (await listAll(c.env.BUCKET, paths.sitePrefix(name))).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) await c.env.BUCKET.delete(keys.slice(i, i + 1000));
    return c.body(null, 204);
  })

  .openapi(createDeploy, async (c) => {
    const { site: name } = c.req.valid("param");
    const req = c.req.valid("json");
    const { email } = c.var.identity;
    const bucket = c.env.BUCKET;

    const bytes = Object.values(req.files).reduce((n, f) => n + f.size, 0);
    if (bytes > MAX_DEPLOY_BYTES) {
      throw new TrayError(
        413,
        "too_large",
        `deploy is ${bytes} bytes; the limit is ${MAX_DEPLOY_BYTES} (50 MB)`,
        { param: "files" },
      );
    }

    const existing = await loadSite(c.env, name);
    const src = existing?.meta.source;
    if (
      src &&
      (src.path !== req.source.path || src.machine !== req.source.machine) &&
      !req.replace
    ) {
      throw new TrayError(
        409,
        "site_exists",
        `${name} already exists (last put from ${src.path} on ${src.machine})`,
        {
          param: "site",
          hint: "Pass replace: true (CLI: --replace) or use another site name.",
        },
      );
    }

    const stamp = now();
    const meta: SiteMeta = existing?.meta ?? {
      visibility: req.visibility ?? "public",
      sharedWith: [],
      createdBy: email,
      domains: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    const metaChanged =
      !existing ||
      !src ||
      src.path !== req.source.path ||
      src.machine !== req.source.machine ||
      (req.replace === true && req.visibility !== undefined && req.visibility !== meta.visibility);
    meta.source = req.source;
    if (existing && req.replace && req.visibility) meta.visibility = req.visibility;

    const current = existing?.current
      ? await getJson<DeployRecord>(bucket, paths.deploy(name, existing.current))
      : null;

    // Same manifest as what's live: nothing to do (safe retry).
    if (current && sameDeploy(current, req.files, req.spa)) {
      if (metaChanged) {
        meta.updatedAt = stamp;
        await putJson(bucket, paths.meta(name), meta);
      }
      return c.json(
        { site: toSite(c.env, name, meta, current.id), deploy: deploySummary(current) },
        200,
      );
    }

    // Every blob the current deploy doesn't already reference must exist.
    const known = new Set(current ? Object.values(current.files).map((f) => f.hash) : []);
    const toCheck = [...new Set(Object.values(req.files).map((f) => f.hash))].filter(
      (h) => !known.has(h),
    );
    const heads = await mapLimit(toCheck, 50, (h) => bucket.head(paths.blob(h)));
    const missing = toCheck.filter((_, i) => !heads[i]);
    if (missing.length) {
      throw new TrayError(409, "missing_blobs", `${missing.length} blob(s) not uploaded yet`, {
        hint: "Upload them with PUT /v1/blobs/{sha256}, then deploy again.",
        extra: { missing },
      });
    }

    const record: DeployRecord = {
      id: newDeployId(),
      files: req.files,
      spa: req.spa,
      createdAt: stamp,
      createdBy: email,
    };
    const summary = deploySummary(record);
    await putJson(bucket, paths.deploy(name, record.id), record, {
      files: String(summary.files),
      bytes: String(summary.bytes),
      spa: String(summary.spa),
      createdAt: summary.createdAt,
      createdBy: summary.createdBy,
    });
    await bucket.put(paths.current(name), record.id);
    meta.updatedAt = stamp;
    await putJson(bucket, paths.meta(name), meta);

    return c.json({ site: toSite(c.env, name, meta, record.id), deploy: summary }, 201);
  })

  .openapi(listDeploys, async (c) => {
    const { site: name } = c.req.valid("param");
    const { limit, before } = c.req.valid("query");
    await requireSite(c.env, name);

    // Deploy ids sort by time, so key order is age order. Metadata carries the summary.
    const objects = await listAll(c.env.BUCKET, paths.deploysPrefix(name), ["customMetadata"]);
    const prefix = paths.deploysPrefix(name);
    const all = objects
      .map((o) => ({
        id: o.key.slice(prefix.length, -".json".length),
        meta: o.customMetadata ?? {},
      }))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const older = before ? all.filter((d) => d.id < before) : all;
    const page = older.slice(0, limit);

    const data: Deploy[] = await Promise.all(
      page.map(async ({ id, meta }) => {
        if (meta.createdAt) {
          return {
            id,
            files: Number(meta.files),
            bytes: Number(meta.bytes),
            spa: meta.spa === "true",
            createdAt: meta.createdAt,
            createdBy: meta.createdBy ?? "",
          };
        }
        const record = await getJson<DeployRecord>(c.env.BUCKET, paths.deploy(name, id));
        return deploySummary(record!);
      }),
    );
    return c.json({ data, hasMore: older.length > limit }, 200);
  })

  .openapi(rollback, async (c) => {
    const { site: name } = c.req.valid("param");
    const { to } = c.req.valid("json");
    const { meta, current } = await requireSite(c.env, name);
    if (current !== to) {
      const target = /^[a-z0-9-]+$/.test(to)
        ? await c.env.BUCKET.head(paths.deploy(name, to))
        : null;
      if (!target) {
        throw new TrayError(404, "deploy_not_found", `deploy ${to} not found on ${name}`, {
          param: "to",
          hint: `Run \`tray rollback ${name}\` to pick from recent deploys.`,
        });
      }
      await c.env.BUCKET.put(paths.current(name), to);
      meta.updatedAt = now();
      await putJson(c.env.BUCKET, paths.meta(name), meta);
    }
    return c.json(toSite(c.env, name, meta, to), 200);
  });
