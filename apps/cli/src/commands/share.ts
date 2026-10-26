import type { Api } from "../api.ts";
import { authedApi, result, type Ctx } from "../ctx.ts";
import { usageError } from "../errors.ts";
import { ShareEntry } from "@traysh/schema";
import type { Share } from "../api.ts";

export function validateEntries(entries: string[]): string[] {
  const clean = entries.map((e) => e.trim().toLowerCase());
  const bad = clean.filter((e) => !ShareEntry.safeParse(e).success);
  if (bad.length)
    throw usageError(
      `not an email or @domain: ${bad.join(", ")}`,
      "Examples: bob@acme.com, @acme.com",
      "entries",
    );
  return clean;
}

function render(ctx: Ctx, site: string, shares: Share[]): void {
  const lines = shares.map((s) => (s.owner ? `${s.entry} (owner)` : s.entry));
  result(ctx, lines.join("\n"), { site, data: shares });
}

/** `tray share <site>` lists; with entries it adds them. */
export async function share(ctx: Ctx, site: string, entries: string[]): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data } = entries.length
    ? await api.addShares(site, validateEntries(entries))
    : await api.listShares(site);
  render(ctx, site, data);
}

/** DELETE is one entry per call; then show what's left. */
export async function unshare(ctx: Ctx, site: string, entries: string[]): Promise<void> {
  const { api } = await authedApi(ctx);
  await removeAll(api, site, validateEntries(entries));
  render(ctx, site, (await api.listShares(site)).data);
}

async function removeAll(api: Api, site: string, entries: string[]) {
  for (const e of entries) await api.removeShare(site, e);
}
