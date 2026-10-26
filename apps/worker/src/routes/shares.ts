// Who can see a private site. Stored in meta.json `sharedWith[]` and enforced
// by the serving handler; no Cloudflare calls.
import { createRoute, z } from "@hono/zod-openapi";
import { AddSharesRequest, type Share, ShareEntry, ShareList, SiteName } from "@tray-sh/schema";
import type { Env } from "../env.ts";
import { siteNotFound, TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { loadSite, now, paths, putJson, type SiteMeta } from "../storage.ts";

const siteParam = z.object({ site: SiteName });

const listShares = createRoute({
  method: "get",
  path: "/sites/{site}/shares",
  summary: "Who can see a private site (owner first)",
  security: bearer,
  request: { params: siteParam },
  responses: { 200: json(ShareList, "Owner and share entries"), ...errors(404, 409) },
});

const addShares = createRoute({
  method: "post",
  path: "/sites/{site}/shares",
  summary: "Share a private site with emails or @domains",
  security: bearer,
  request: { params: siteParam, body: body(AddSharesRequest) },
  responses: { 200: json(ShareList, "The full share list"), ...errors(404, 409) },
});

const removeShare = createRoute({
  method: "delete",
  path: "/sites/{site}/shares/{entry}",
  summary: "Stop sharing with an email or @domain",
  security: bearer,
  request: { params: z.object({ site: SiteName, entry: ShareEntry }) },
  responses: { 204: { description: "Removed (or wasn't shared)" }, ...errors(404, 409) },
});

function shareList(meta: SiteMeta): { data: Share[] } {
  return {
    data: [
      { entry: meta.createdBy, owner: true },
      ...meta.sharedWith.map((entry) => ({ entry, owner: false })),
    ],
  };
}

async function privateSite(env: Env, name: string) {
  const site = await loadSite(env, name);
  if (!site) throw siteNotFound(name);
  if (site.meta.visibility !== "private") {
    throw new TrayError(409, "site_public", `${name} is public`, {
      param: "site",
      hint: `Make it private first: tray edit ${name} --visibility private`,
    });
  }
  return site.meta;
}

export const shares = newRouter()
  .openapi(listShares, async (c) => {
    const meta = await privateSite(c.env, c.req.valid("param").site);
    return c.json(shareList(meta), 200);
  })

  .openapi(addShares, async (c) => {
    const { site: name } = c.req.valid("param");
    const meta = await privateSite(c.env, name);
    const owner = meta.createdBy.toLowerCase();
    const added = c.req
      .valid("json")
      .entries.map((e) => e.toLowerCase())
      .filter((e, i, all) => e !== owner && !meta.sharedWith.includes(e) && all.indexOf(e) === i);
    if (added.length) {
      meta.sharedWith.push(...added);
      meta.updatedAt = now();
      await putJson(c.env.BUCKET, paths.meta(name), meta);
    }
    return c.json(shareList(meta), 200);
  })

  .openapi(removeShare, async (c) => {
    const { site: name, entry: raw } = c.req.valid("param");
    const entry = raw.toLowerCase();
    const meta = await privateSite(c.env, name);
    if (entry === meta.createdBy.toLowerCase()) {
      throw new TrayError(400, "invalid_request", "the owner can't be removed", { param: "entry" });
    }
    if (meta.sharedWith.includes(entry)) {
      meta.sharedWith = meta.sharedWith.filter((e) => e !== entry);
      meta.updatedAt = now();
      await putJson(c.env.BUCKET, paths.meta(name), meta);
    }
    return c.body(null, 204);
  });
