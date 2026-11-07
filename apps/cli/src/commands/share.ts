import type { Api } from "../api.ts";
import { authedApi, confirm, receipt, result, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import { formatTable, plural } from "../format.ts";
import { ShareEntry } from "@tray-sh/schema";
import type { Share } from "../api.ts";

/** Lowercased entries, or one error naming every invalid one. */
export function validateEntries(site: string, entries: string[]): string[] {
  const clean = entries.map((e) => e.trim().toLowerCase());
  const bad = clean.filter((e) => !ShareEntry.safeParse(e).success);
  if (bad.length)
    throw new TrayError(
      `Can't share ${site}: ${bad.length === 1 ? "1 entry is" : `${bad.length} entries are`} invalid`,
      "invalid_usage",
      EXIT.usage,
      "Use an email (bob@acme.com) or a whole domain (@acme.com).",
      "entries",
      { details: bad.map((e) => `${e}: not an email or @domain`) },
    );
  return clean;
}

/** The share list: the resulting table on stdout. */
function render(ctx: Ctx, site: string, shares: Share[], outcome?: string): void {
  const rows = shares.map((s) => [s.entry, s.owner ? "owner" : "viewer"]);
  result(ctx, formatTable(["WHO", "ROLE"], rows, ctx.mode.stdoutTTY !== false), {
    site: { name: site },
    shares,
    ...(outcome ? { outcome } : {}),
  });
}

/** `tray share <site>` lists; with entries it adds them. */
export async function share(ctx: Ctx, site: string, entries: string[]): Promise<void> {
  const { api } = await authedApi(ctx);
  if (!entries.length) return render(ctx, site, (await api.listShares(site)).data);
  const { data } = await api.addShares(site, validateEntries(site, entries));
  receipt(
    ctx,
    `Shared ${site} with ${entries.length === 1 ? entries[0] : plural(entries.length, "entry")}`,
  );
  render(ctx, site, data, "added");
}

/** Changes who can see it, so it's confirmed. DELETE is one entry per call; then show what's left. */
export async function unshare(ctx: Ctx, site: string, entries: string[]): Promise<void> {
  const clean = validateEntries(site, entries);
  const { api } = await authedApi(ctx);
  const who = clean.length === 1 ? clean[0]! : plural(clean.length, "entry");
  if (!(await confirm(ctx, `Remove ${who} from ${site}? They lose access.`))) throw cancelled();
  await removeAll(api, site, clean);
  receipt(ctx, `Removed ${who} from ${site}`);
  render(ctx, site, (await api.listShares(site)).data, "removed");
}

async function removeAll(api: Api, site: string, entries: string[]) {
  for (const e of entries) await api.removeShare(site, e);
}
