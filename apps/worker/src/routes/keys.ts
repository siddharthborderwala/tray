import { createRoute, z } from "@hono/zod-openapi";
import { CreatedKey, CreateKeyRequest, type Key, KeyId, KeyList } from "@tray-sh/schema";
import { createKey } from "../auth.ts";
import type { R2Bucket } from "../env.ts";
import { TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { getJson, getText, type KeyRecord, listAll, mapLimit, paths } from "../storage.ts";

const listKeys = createRoute({
  method: "get",
  path: "/keys",
  operationId: "listKeys",
  summary: "List API keys",
  description: "Every key's id, name, owner email and timestamps. Never returns key secrets.",
  security: bearer,
  responses: { 200: json(KeyList, "Keys, oldest first"), ...errors() },
});

const newKey = createRoute({
  method: "post",
  path: "/keys",
  operationId: "createKey",
  summary: "Create an API key",
  description:
    "For agents and CI. The `key` is returned only in this response; only its hash is stored.",
  security: bearer,
  request: { body: body(CreateKeyRequest) },
  responses: { 201: json(CreatedKey, "The new key"), ...errors() },
});

// Declared before /keys/{id}; "current" isn't a valid key id anyway.
const revokeCurrent = createRoute({
  method: "delete",
  path: "/keys/current",
  operationId: "revokeCurrentKey",
  summary: "Revoke the calling key",
  description: "Logout: revokes the API key that authenticated this request.",
  security: bearer,
  responses: { 204: { description: "Revoked" }, ...errors() },
});

const revokeKey = createRoute({
  method: "delete",
  path: "/keys/{id}",
  operationId: "revokeKey",
  summary: "Revoke an API key",
  description: "Revokes a key by its 12-character id.",
  security: bearer,
  request: { params: z.object({ id: KeyId }) },
  responses: { 204: { description: "Revoked" }, ...errors(404) },
});

const toKey = (r: KeyRecord, lastUsedAt: string | null): Key => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: r.createdAt,
  lastUsedAt: lastUsedAt ?? r.lastUsedAt,
});

/** Revoke: the record first (that's what stops the key), then its "last used" marker. */
async function deleteKey(bucket: R2Bucket, id: string) {
  await bucket.delete(paths.key(id));
  await bucket.delete(paths.keyUsed(id));
}

export const keys = newRouter()
  .openapi(listKeys, async (c) => {
    const objects = await listAll(c.env.BUCKET, paths.keysPrefix);
    const data = (
      await mapLimit(objects, 50, async (o) => {
        const r = await getJson<KeyRecord>(c.env.BUCKET, o.key);
        return r && toKey(r, await getText(c.env.BUCKET, paths.keyUsed(r.id)));
      })
    )
      .filter((k): k is Key => k !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return c.json({ data }, 200);
  })

  .openapi(newKey, async (c) => {
    const { name } = c.req.valid("json");
    return c.json(await createKey(c.env, name, c.var.identity.email), 201);
  })

  .openapi(revokeCurrent, async (c) => {
    const { keyId } = c.var.identity;
    if (!keyId)
      throw new TrayError(400, "invalid_request", "this request wasn't made with an API key");
    await deleteKey(c.env.BUCKET, keyId);
    return c.body(null, 204);
  })

  .openapi(revokeKey, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await c.env.BUCKET.head(paths.key(id)))) {
      throw new TrayError(404, "key_not_found", `key ${id} not found`, {
        param: "id",
        hint: "Run `tray key list` to see keys.",
      });
    }
    await deleteKey(c.env.BUCKET, id);
    return c.body(null, 204);
  });
