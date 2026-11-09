import type { Api } from "../api.ts";
import { setSiteRecord } from "../config.ts";
import {
  askSelect,
  authedApi,
  confirm,
  empty,
  info,
  openBrowser,
  receipt,
  result,
  type Ctx,
} from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import { emptyCell, formatPairs, formatTable, plural, relativeTime, timeCell } from "../format.ts";
import type { Deploy, Site, Visibility } from "../api.ts";

const tty = (ctx: Ctx) => ctx.mode.stdoutTTY !== false;

export async function list(ctx: Ctx): Promise<void> {
  const { api, domain } = await authedApi(ctx);
  const { data: sites } = await api.listSites();
  const headers = ["SITE", "URL", "VISIBILITY", "DOMAINS", "UPDATED"];
  if (!sites.length && !ctx.mode.json)
    return empty(ctx, headers, `No sites on ${domain}.`, "tray put <PATH>");
  const t = tty(ctx);
  const rows = sites.map((s) => [
    s.name,
    s.url,
    s.visibility === "private" ? `private (${s.shareCount})` : "public",
    s.domains.length ? s.domains.join(", ") : emptyCell(t),
    timeCell(s.updatedAt, t),
  ]);
  result(ctx, formatTable(headers, rows, t), { sites });
}

async function requireSite(api: Api, name: string): Promise<Site> {
  const site = await api.getSite(name);
  if (!site)
    throw new TrayError(
      `No site named ${name}`,
      "site_not_found",
      EXIT.failed,
      "See your sites:",
      "site",
      {
        next: ["tray list"],
      },
    );
  return site;
}

export async function open(ctx: Ctx, name: string): Promise<void> {
  const { api } = await authedApi(ctx);
  const site = await requireSite(api, name);
  if (ctx.mode.interactive && !ctx.noOpen) openBrowser(site.url);
  result(ctx, site.url, { site });
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
      flag: "--visibility <public|private>",
      message: `Visibility for ${name}?`,
      options: [
        { value: "private", label: "private", hint: "only you and people you share with" },
        { value: "public", label: "public", hint: "anyone with the link" },
      ],
    }));
  if (
    vis === "public" &&
    !(await confirm(ctx, `Make ${name} public? Anyone with the link can view it.`))
  )
    throw cancelled();
  const site = await api.editSite(name, vis);
  receipt(ctx, `${site.name} is ${site.visibility}`);
  result(ctx, site.url, { site, outcome: "updated" });
}

/** The deploy before `current` in a newest-first list, if it's on this page. */
export function previousDeploy(deploys: Deploy[], current: string | null): Deploy | undefined {
  const i = deploys.findIndex((d) => d.id === current);
  return i === -1 ? undefined : deploys[i + 1];
}

/** `tray deploys <site>`: newest first, the live one marked. `--next` pages with the last id. */
export async function deploys(
  ctx: Ctx,
  name: string,
  opts: { limit?: number; next?: string },
): Promise<void> {
  const { api } = await authedApi(ctx);
  const site = await requireSite(api, name);
  const { data, hasMore } = await api.listDeploys(name, { limit: opts.limit, before: opts.next });
  const next = hasMore ? data.at(-1)?.id : undefined;
  const headers = ["", "DEPLOY", "CREATED", "FILES", "BY"];
  if (!data.length && !ctx.mode.json) return empty(ctx, headers, `No deploys for ${name}.`);
  const t = tty(ctx);
  const rows = data.map((d) => [
    d.id === site.currentDeploy ? "*" : "",
    d.id,
    timeCell(d.createdAt, t),
    String(d.files),
    d.createdBy,
  ]);
  result(ctx, formatTable(headers, rows, t), {
    deploys: data.map((d) => ({ ...d, current: d.id === site.currentDeploy })),
    ...(next ? { next } : {}),
  });
  if (next && !ctx.mode.json) info(ctx, `More:\n    tray deploys ${name} --next ${next}`);
}

/**
 * Point a site at another deploy. Interactive with no `--to`: pick one. Never
 * guesses non-interactively: without `--to` it fails, naming the deploy it
 * would have picked.
 */
export async function rollback(ctx: Ctx, name: string, to: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  const site = await requireSite(api, name);
  let target = to;
  if (!target) {
    const { data: recent } = await api.listDeploys(name, { limit: 20 });
    const previous = previousDeploy(recent, site.currentDeploy);
    const older = recent.filter((d) => d.id !== site.currentDeploy);
    if (older.length === 0)
      throw new TrayError(`No earlier deploy for ${name}`, "deploy_not_found", EXIT.failed);
    if (!ctx.mode.interactive)
      throw new TrayError(
        `Rollback needs a deploy id in non-interactive mode`,
        "missing_input",
        EXIT.usage,
        previous ? "Roll back to the previous deploy:" : "Pick a deploy:",
        "deploy",
        {
          next: [previous ? `tray rollback ${name} ${previous.id}` : `tray deploys ${name}`],
        },
      );
    // Put the previous deploy first so Enter does the usual thing.
    const ordered = previous ? [previous, ...older.filter((d) => d.id !== previous.id)] : older;
    target = await askSelect(ctx, {
      flag: "--to <DEPLOY>",
      message: `Roll ${name} back to`,
      options: ordered.map((d) => ({
        value: d.id,
        label: d.id,
        hint: `${relativeTime(d.createdAt)} · ${d.files} files · ${d.createdBy}`,
      })),
    });
  }
  info(
    ctx,
    formatPairs([
      ["From", site.currentDeploy ?? "none"],
      ["To", target],
    ]),
  );
  const live = await api.rollback(name, target);
  receipt(ctx, `${live.name} is on ${live.currentDeploy}`);
  result(ctx, live.url, { site: live, outcome: "rolled_back" });
}

/** Can't be undone, so: look the site up, show what goes, then confirm. */
export async function remove(ctx: Ctx, name: string): Promise<void> {
  const { api, domain } = await authedApi(ctx);
  const site = await requireSite(api, name);
  const { data: recent, hasMore } = await api.listDeploys(name, { limit: 100 });
  const count = `${recent.length}${hasMore ? "+" : ""}`;
  const preview = formatPairs([
    ["Site", site.name],
    ["URL", site.url],
    ["Custom domains", site.domains.length ? site.domains.join(", ") : "none"],
    ["Deploys", count],
  ]);
  if (!ctx.mode.json && !ctx.yes) info(ctx, `${preview}\n\nThis cannot be undone.`);
  const ok = await confirm(
    ctx,
    `Remove ${name}? ${site.domains.length ? `Its URL and ${plural(site.domains.length, "custom domain")} stop` : "Its URL stops"} working, and its deploys are deleted.`,
  );
  if (!ok) throw cancelled();
  await api.removeSite(name);
  setSiteRecord(ctx.configDir, domain, name, undefined);
  receipt(ctx, `Removed ${name}`);
  result(ctx, name, { site: { name }, outcome: "removed" });
}
