import { authedApi, askText, confirm, info, receipt, result, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import { formatTable, relativeTime, timeCell } from "../format.ts";
import type { Key } from "../api.ts";

export async function keyCreate(ctx: Ctx, nameFlag: string | undefined): Promise<void> {
  const { api } = await authedApi(ctx);
  const name =
    nameFlag ??
    (await askText(ctx, { flag: "--name <name>", message: "Key name", placeholder: "ci" }));
  const created = await api.createKey(name);
  info(ctx, "Shown once. Store it somewhere safe, e.g. as TRAY_API_KEY in CI.");
  result(ctx, created.key, { key: created, outcome: "created" });
}

export async function keyList(ctx: Ctx): Promise<void> {
  const { api } = await authedApi(ctx);
  const { data } = await api.listKeys();
  const t = ctx.mode.stdoutTTY !== false;
  const rows = data.map((k) => [
    k.id,
    k.name,
    k.email,
    timeCell(k.createdAt, t),
    timeCell(k.lastUsedAt, t),
  ]);
  result(ctx, formatTable(["ID", "NAME", "EMAIL", "CREATED", "LAST USED"], rows, t), {
    keys: data,
  });
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
      `No key named ${nameOrId}`,
      "key_not_found",
      EXIT.failed,
      "See your keys:",
      "name",
      {
        next: ["tray key list"],
      },
    );
  throw new TrayError(
    `${matches.length} keys match ${nameOrId}`,
    "ambiguous_key",
    EXIT.usage,
    "Revoke one by id:",
    "name",
    {
      details: matches.map((k) => `${k.id}  ${k.email}, created ${relativeTime(k.createdAt)}`),
      next: matches.slice(0, 2).map((k) => `tray key revoke ${k.id}`),
    },
  );
}

export async function keyRevoke(ctx: Ctx, nameOrId: string): Promise<void> {
  const { api } = await authedApi(ctx);
  const keys = (await api.listKeys()).data;
  const id = keyIdFor(keys, nameOrId);
  const key = keys.find((k) => k.id === id)!;
  if (!(await confirm(ctx, `Revoke key ${key.name}? Agents and CI using it will stop working.`)))
    throw cancelled();
  await api.revokeKey(id);
  receipt(ctx, `Revoked ${key.name}`);
  result(ctx, id, { key: { id, name: key.name }, outcome: "revoked" });
}
