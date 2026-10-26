import { createRoute, z } from "@hono/zod-openapi";
import { CreatedKey, CreateKeyRequest, type Key, KeyId, KeyList } from "@tray-sh/schema";
import { createKey } from "../auth.ts";
import { TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { getJson, type KeyRecord, listAll, mapLimit, paths } from "../storage.ts";

const listKeys = createRoute({
  method: "get",
  path: "/keys",
  summary: "List API keys",
  security: bearer,
  responses: { 200: json(KeyList, "Keys, oldest first"), ...errors() },
});

const newKey = createRoute({
  method: "post",
  path: "/keys",
  summary: "Create an API key (shown once)",
  security: bearer,
  request: { body: body(CreateKeyRequest) },
  responses: { 201: json(CreatedKey, "The new key"), ...errors() },
});

// Declared before /keys/{id}; "current" isn't a valid key id anyway.
const revokeCurrent = createRoute({
  method: "delete",
  path: "/keys/current",
  summary: "Revoke the key making this request (logout)",
  security: bearer,
  responses: { 204: { description: "Revoked" }, ...errors() },
});

const revokeKey = createRoute({
  method: "delete",
  path: "/keys/{id}",
  summary: "Revoke an API key",
  security: bearer,
  request: { params: z.object({ id: KeyId }) },
  responses: { 204: { description: "Revoked" }, ...errors(404) },
});

const toKey = (r: KeyRecord): Key => ({
  id: r.id,
  name: r.name,
  email: r.email,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

export const keys = newRouter()
  .openapi(listKeys, async (c) => {
    const objects = await listAll(c.env.BUCKET, paths.keysPrefix);
    const records = await mapLimit(objects, 50, (o) => getJson<KeyRecord>(c.env.BUCKET, o.key));
    const data = records
      .filter((r): r is KeyRecord => r !== null)
      .map(toKey)
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
    await c.env.BUCKET.delete(paths.key(keyId));
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
    await c.env.BUCKET.delete(paths.key(id));
    return c.body(null, 204);
  });
