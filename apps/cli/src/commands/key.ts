import { authedApi, askText, info, result, type Ctx } from "../ctx.ts";
import { EXIT, TrayError } from "../errors.ts";
import { formatTable, relativeTime } from "../format.ts";
import type { Key } from "../api.ts";

export async function keyCreate(ctx: Ctx, nameFlag: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  const name =
    nameFlag ??
    (await askText(ctx, { flag: "--name <name>", message: "Key name", placeholder: "ci" }));
  const created = await api.createKey(name);
  if (!ctx.mode.json) info(ctx, "Shown once. Store it somewhere safe, e.g. as TRAY_API_KEY in CI.");
  result(ctx, created.key, created);
}

export async function keyList(ctx: Ctx): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data } = await api.listKeys();
  const rows = data.map((k) => [
    k.id,
    k.name,
    k.email,
    relativeTime(k.createdAt),
    relativeTime(k.lastUsedAt),
  ]);
  result(ctx, formatTable(["ID", "NAME", "EMAIL", "CREATED", "LAST USED"], rows), { data });
}

/** Map a key name (or id) to its id. Errors when nothing matches or the name is ambiguous. */
export function keyIdFor(keys: Key[], nameOrId: string): string {
  const byId = keys.find((k) => k.id === nameOrId);
  // A key can be *named* like another key's id. Never guess which one is meant.
  const matches = keys.filter((k) => k.name === nameOrId || k.id === nameOrId);
  if (byId && matches.length === 1) return byId.id;
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0)
    throw new TrayError(
      `no key named ${nameOrId}`,
      "key_not_found",
      EXIT.failed,
      "Run `tray key list`.",
      "name",
    );
  throw new TrayError(
    `${matches.length} keys match ${nameOrId}`,
    "ambiguous_key",
    EXIT.usage,
    `Revoke one by id: ${matches.map((k) => `${k.id} (${k.email}, created ${relativeTime(k.createdAt)})`).join(", ")}`,
    "name",
  );
}

export async function keyRevoke(ctx: Ctx, nameOrId: string): Promise<void> {
  const { api } = await authedApi(ctx);
  const id = keyIdFor((await api.listKeys()).data, nameOrId);
  await api.revokeKey(id);
  result(ctx, `Revoked ${nameOrId}`, { id, revoked: true });
}
