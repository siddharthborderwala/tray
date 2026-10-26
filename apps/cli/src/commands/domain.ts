import { authedApi, confirm, result, type Ctx } from "../ctx.ts";
import { cancelled, missingFlag } from "../errors.ts";
import { formatTable, relativeTime } from "../format.ts";

/**
 * `host` arrives normalized (lowercase, no scheme or path) by the router's
 * HostnameInput schema. The Worker attaches the host as a Worker Custom Domain (Cloudflare creates
 * DNS + TLS), writes hosts/<host>, and answers 422 zone_not_in_account when the
 * zone is on another account.
 */
export async function domainAdd(ctx: Ctx, host: string, site: string | undefined): Promise<void> {
  if (!site) throw missingFlag("-s <site>", "site");
  const { api } = await authedApi(ctx);
  const d = await api.addDomain(host, site);
  result(ctx, `https://${d.host} → ${d.site}`, d);
}

export async function domainRemove(ctx: Ctx, host: string): Promise<void> {
  const { api } = await authedApi(ctx);
  if (!(await confirm(ctx, `Remove ${host}? It will stop serving.`))) throw cancelled();
  await api.removeDomain(host);
  result(ctx, `Removed ${host}`, { host, removed: true });
}

export async function domainList(ctx: Ctx, site: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data } = await api.listDomains(site);
  const text = data.length
    ? formatTable(
        ["HOST", "SITE", "ADDED"],
        data.map((d) => [d.host, d.site, relativeTime(d.createdAt)]),
      )
    : "No custom domains.";
  result(ctx, text, { data });
}
