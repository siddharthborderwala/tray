import { authedApi, confirm, empty, receipt, result, retry, type Ctx } from "../ctx.ts";
import { cancelled, missingFlag } from "../errors.ts";
import { formatTable, timeCell } from "../format.ts";

/**
 * `host` arrives normalized (lowercase, no scheme or path) by the router's
 * HostnameInput schema. The Worker attaches the host as a Worker Custom Domain (Cloudflare creates
 * DNS + TLS), writes hosts/<host>, and answers 422 zone_not_in_account when the
 * zone is on another account.
 */
export async function domainAdd(ctx: Ctx, host: string, site: string | undefined): Promise<void> {
  if (!site) throw missingFlag("--site <SITE>", "--site", retry(ctx, "--site <SITE>"));
  const { api } = await authedApi(ctx);
  const d = await api.addDomain(host, site);
  receipt(ctx, `${d.host} serves ${d.site}`);
  result(ctx, `https://${d.host}`, { domain: d, outcome: "added" });
}

export async function domainRemove(ctx: Ctx, host: string): Promise<void> {
  const { api } = await authedApi(ctx);
  if (!(await confirm(ctx, `Remove ${host}? It will stop serving.`))) throw cancelled();
  await api.removeDomain(host);
  receipt(ctx, `Removed ${host}`);
  result(ctx, host, { domain: { host }, outcome: "removed" });
}

export async function domainList(ctx: Ctx, site: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data } = await api.listDomains(site);
  const headers = ["HOST", "SITE", "ADDED"];
  if (!data.length && !ctx.mode.json)
    return empty(ctx, headers, "No custom domains.", "tray domain add <HOST> --site <SITE>");
  const t = ctx.mode.stdoutTTY !== false;
  const rows = data.map((d) => [d.host, d.site, timeCell(d.createdAt, t)]);
  result(ctx, formatTable(headers, rows, t), { domains: data });
}
