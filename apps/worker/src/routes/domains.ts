// Custom domains: a Worker Custom Domain on Cloudflare + `hosts/<host>` in R2.
// The host is also added to the sign-in Access app so "Sign in to view" works there.
import { createRoute, z } from "@hono/zod-openapi";
import { AddDomainRequest, Domain, DomainList, DomainListQuery, Hostname } from "@traysh/schema";
import { siteNotFound, TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { getJson, type HostRecord, listAll, loadSite, now, paths, putJson } from "../storage.ts";

const listDomains = createRoute({
  method: "get",
  path: "/domains",
  summary: "List custom domains",
  security: bearer,
  request: { query: DomainListQuery },
  responses: { 200: json(DomainList, "Custom domains, by host"), ...errors() },
});

const addDomain = createRoute({
  method: "post",
  path: "/domains",
  summary: "Attach a custom domain to a site",
  security: bearer,
  request: { body: body(AddDomainRequest) },
  responses: {
    200: json(Domain, "Already mapped to this site"),
    201: json(Domain, "Attached"),
    ...errors(404, 409, 422, 502),
  },
});

const removeDomain = createRoute({
  method: "delete",
  path: "/domains/{host}",
  summary: "Detach a custom domain",
  security: bearer,
  request: { params: z.object({ host: Hostname }) },
  responses: { 204: { description: "Detached" }, ...errors(404, 502) },
});

export const domains = newRouter()
  .openapi(listDomains, async (c) => {
    const { site } = c.req.valid("query");
    const objects = await listAll(c.env.BUCKET, paths.hostsPrefix, ["customMetadata"]);
    const all = await Promise.all(
      objects.map(async (o): Promise<Domain> => {
        const host = o.key.slice(paths.hostsPrefix.length);
        const meta = o.customMetadata;
        if (meta?.site && meta.createdAt)
          return { host, site: meta.site, createdAt: meta.createdAt };
        const rec = await getJson<HostRecord>(c.env.BUCKET, o.key);
        return { host, site: rec?.site ?? "", createdAt: rec?.createdAt ?? "" };
      }),
    );
    const data = all
      .filter((d) => !site || d.site === site)
      .sort((a, b) => a.host.localeCompare(b.host));
    return c.json({ data }, 200);
  })

  .openapi(addDomain, async (c) => {
    const req = c.req.valid("json");
    const host = req.host.toLowerCase();
    const domain = c.env.DOMAIN.toLowerCase();
    if (host.endsWith(`.${domain}`)) {
      throw new TrayError(400, "invalid_request", `${host} is already served by this tray`, {
        param: "host",
        hint: `Sites are at <site>.${domain} automatically.`,
      });
    }

    const existing = await getJson<HostRecord>(c.env.BUCKET, paths.host(host));
    if (existing) {
      if (existing.site === req.site) return c.json({ host, ...existing }, 200);
      throw new TrayError(409, "domain_taken", `${host} already points at ${existing.site}`, {
        param: "host",
        hint: `Remove it first: tray domain rm ${host}`,
      });
    }

    const site = await loadSite(c.env, req.site);
    if (!site) throw siteNotFound(req.site);

    const cf = c.var.deps.cloudflare(c.env);
    await cf.attachDomain(host);
    await cf.addSigninHost(host);

    const record: HostRecord = { site: req.site, createdAt: now() };
    await putJson(c.env.BUCKET, paths.host(host), record, { ...record });
    if (!site.meta.domains.includes(host)) {
      site.meta.domains = [...site.meta.domains, host].sort();
      site.meta.updatedAt = record.createdAt;
      await putJson(c.env.BUCKET, paths.meta(req.site), site.meta);
    }
    return c.json({ host, ...record }, 201);
  })

  .openapi(removeDomain, async (c) => {
    const host = c.req.valid("param").host.toLowerCase();
    const record = await getJson<HostRecord>(c.env.BUCKET, paths.host(host));
    if (!record) {
      throw new TrayError(404, "domain_not_found", `${host} isn't attached to any site`, {
        param: "host",
        hint: "Run `tray domain list` to see custom domains.",
      });
    }

    const cf = c.var.deps.cloudflare(c.env);
    await cf.detachDomain(host);
    await cf.removeSigninHost(host);
    await c.env.BUCKET.delete(paths.host(host));

    const site = await loadSite(c.env, record.site);
    if (site?.meta.domains.includes(host)) {
      site.meta.domains = site.meta.domains.filter((d) => d !== host);
      site.meta.updatedAt = now();
      await putJson(c.env.BUCKET, paths.meta(record.site), site.meta);
    }
    return c.body(null, 204);
  });
