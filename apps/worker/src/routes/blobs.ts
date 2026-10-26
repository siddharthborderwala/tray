import { createRoute, z } from "@hono/zod-openapi";
import {
  Blob,
  CheckBlobsRequest,
  CheckBlobsResponse,
  MAX_DEPLOY_BYTES,
  Sha256,
} from "@tray-sh/schema";
import { TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { paths } from "../storage.ts";

const check = createRoute({
  method: "post",
  path: "/blobs/check",
  operationId: "checkBlobs",
  summary: "Find which blobs are missing",
  description:
    "Takes up to 512 sha256 hashes and returns the ones not yet stored. Upload those with `PUT /blobs/{sha256}` before deploying.",
  security: bearer,
  request: { body: body(CheckBlobsRequest) },
  responses: { 200: json(CheckBlobsResponse, "Hashes not yet stored"), ...errors() },
});

const put = createRoute({
  method: "put",
  path: "/blobs/{sha256}",
  operationId: "uploadBlob",
  summary: "Upload a blob",
  description:
    "Raw file bytes as the body; `content-length` is required (411 without it, 413 over 50 MB). The body must hash to `sha256` (400 `digest_mismatch`). 201 when stored, 200 when it already existed.",
  security: bearer,
  request: {
    params: z.object({ sha256: Sha256 }),
    body: {
      required: true,
      content: { "application/octet-stream": { schema: z.string().meta({ format: "binary" }) } },
    },
  },
  responses: {
    200: json(Blob, "Already stored"),
    201: json(Blob, "Stored"),
    ...errors(411, 413),
  },
});

export const blobs = newRouter()
  .openapi(check, async (c) => {
    const { hashes } = c.req.valid("json");
    const unique = [...new Set(hashes)];
    // At most 512 heads: well under the per-request subrequest limit.
    const present = await Promise.all(unique.map((h) => c.env.BUCKET.head(paths.blob(h))));
    const missing = new Set(unique.filter((_, i) => !present[i]));
    return c.json({ missing: [...missing] }, 200);
  })
  .openapi(put, async (c) => {
    const { sha256 } = c.req.valid("param");
    const lengthHeader = c.req.header("content-length");
    if (lengthHeader === undefined) {
      throw new TrayError(411, "length_required", "content-length header required", {
        param: "content-length",
      });
    }
    const size = Number(lengthHeader);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TrayError(400, "invalid_request", "invalid content-length", {
        param: "content-length",
      });
    }
    if (size > MAX_DEPLOY_BYTES) {
      throw new TrayError(
        413,
        "too_large",
        `blob is ${size} bytes; the limit is ${MAX_DEPLOY_BYTES} (50 MB)`,
      );
    }

    const existing = await c.env.BUCKET.head(paths.blob(sha256));
    if (existing) return c.json({ hash: sha256, size: existing.size }, 200);

    try {
      // Streamed straight into R2; R2 verifies the digest.
      await c.env.BUCKET.put(paths.blob(sha256), c.req.raw.body ?? new Uint8Array(0), { sha256 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/sha-?256|checksum|digest/i.test(message)) {
        throw new TrayError(400, "digest_mismatch", `body does not match sha256 ${sha256}`, {
          param: "sha256",
          hint: "The file may have changed while uploading; run the command again.",
        });
      }
      throw err;
    }
    return c.json({ hash: sha256, size }, 201);
  });
