import type { Api } from "../api.ts";
import { setSiteRecord } from "../config.ts";
import { askSelect, authedApi, confirm, openBrowser, result, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import { formatTable, relativeTime } from "../format.ts";
import type { Deploy, Site, Visibility } from "../api.ts";

export async function list(ctx: Ctx): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data: sites } = await api.listSites();
  const rows = sites.map((s) => [
    s.name,
    s.url,
    s.visibility === "private" ? `private (${s.shareCount})` : "public",
    s.domains.length ? s.domains.join(", ") : "—",
    relativeTime(s.updatedAt),
  ]);
  const text = sites.length
    ? formatTable(["SITE", "URL", "VISIBILITY", "DOMAINS", "UPDATED"], rows)
    : "No sites yet. Run `tray put <path>`.";
  result(ctx, text, { sites });
}

async function requireSite(api: Api, name: string): Promise<Site> {
  const site = await api.getSite(name);
  if (!site)
    throw new TrayError(
      `no site named ${name}`,
      "site_not_found",
      EXIT.failed,
      "Run `tray list` to see your sites.",
      "site",
    );
  return site;
}

export async function open(ctx: Ctx, name: string): Promise<void> {
  const { api } = await authedApi(ctx);
  const site = await requireSite(api, name);
  if (ctx.mode.interactive) openBrowser(site.url);
  result(ctx, site.url, { site: site.name, url: site.url });
}

export async function edit(
  ctx: Ctx,
  name: string,
  visibility: Visibility | undefined,
): Promise<void> {
  const { api } = await authedApi(ctx);
  const vis =
    visibility ??
    (await askSelect<Visibility>(ctx, {
      flag: "--visibility public|private",
      message: `Visibility for ${name}`,
      options: [
        { value: "private", label: "private", hint: "only you and people you share with" },
        { value: "public", label: "public", hint: "anyone with the link" },
      ],
    }));
  if (
    vis === "public" &&
    !(await confirm(ctx, `${name} will be visible to anyone with the link. Continue?`))
  )
    throw cancelled();
  const site = await api.editSite(name, vis);
  result(ctx, `${site.name} is now ${site.visibility}: ${site.url}`, site);
}

/** The deploy before `current` in a newest-first list, if it's on this page. */
export function previousDeploy(deploys: Deploy[], current: string | null): Deploy | undefined {
  const i = deploys.findIndex((d) => d.id === current);
  return i === -1 ? undefined : deploys[i + 1];
}

export async function rollback(ctx: Ctx, name: string, to: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  let target = to;
  if (!target) {
    const site = await requireSite(api, name);
    const { data: deploys } = await api.listDeploys(name, { limit: 20 });
    const previous = previousDeploy(deploys, site.currentDeploy);
    const older = deploys.filter((d) => d.id !== site.currentDeploy);
    if (older.length === 0)
      throw new TrayError(`${name} has no earlier deploy`, "deploy_not_found", EXIT.failed);
    if (ctx.mode.interactive) {
      // Put the previous deploy first so Enter does the usual thing.
      const ordered = previous ? [previous, ...older.filter((d) => d.id !== previous.id)] : older;
      target = await askSelect(ctx, {
        flag: "--to <deploy>",
        message: "Roll back to",
        options: ordered.map((d) => ({
          value: d.id,
          label: d.id,
          hint: `${relativeTime(d.createdAt)} · ${d.files} files · ${d.createdBy}`,
        })),
      });
    } else {
      if (!previous)
        throw new TrayError(
          `can't tell which deploy came before ${site.currentDeploy}`,
          "deploy_not_found",
          EXIT.failed,
          "Pass --to <deploy>.",
          "--to",
        );
      target = previous.id;
    }
  }
  const site = await api.rollback(name, target);
  result(ctx, `${site.url}   (deploy ${site.currentDeploy})`, {
    site: site.name,
    url: site.url,
    deploy: site.currentDeploy,
  });
}

export async function remove(ctx: Ctx, name: string): Promise<void> {
  const { api, domain } = await authedApi(ctx);
  if (!(await confirm(ctx, `Remove ${name}? Its URL and custom domains stop working.`)))
    throw cancelled();
  await api.removeSite(name);
  setSiteRecord(ctx.configDir, domain, name, undefined);
  result(ctx, `Removed ${name}`, { site: name, removed: true });
}
