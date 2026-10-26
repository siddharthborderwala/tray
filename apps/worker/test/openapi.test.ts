import { describe, expect, test } from "bun:test";
import { setup } from "./helpers.ts";

describe("GET /v1/openapi.json", () => {
  test("no auth; documents every §5 endpoint", async () => {
    const { api } = await setup();
    const res = await api("/openapi.json", { key: null });
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://tray.thts.app/v1" }]);

    const ops = Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(
      ([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(ops.sort()).toEqual(
      [
        "POST /blobs/check",
        "PUT /blobs/{sha256}",
        "GET /sites",
        "GET /sites/{site}",
        "PATCH /sites/{site}",
        "DELETE /sites/{site}",
        "POST /sites/{site}/deploys",
        "GET /sites/{site}/deploys",
        "POST /sites/{site}/rollback",
        "GET /sites/{site}/shares",
        "POST /sites/{site}/shares",
        "DELETE /sites/{site}/shares/{entry}",
        "GET /domains",
        "POST /domains",
        "DELETE /domains/{host}",
        "GET /keys",
        "POST /keys",
        "DELETE /keys/{id}",
        "DELETE /keys/current",
        "POST /auth/device",
        "POST /auth/token",
        "GET /auth/device/{userCode}",
        "POST /auth/approve",
      ].sort(),
    );

    for (const name of [
      "Site",
      "Deploy",
      "Share",
      "Domain",
      "Key",
      "DeviceCode",
      "Error",
      "Blob",
    ]) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.paths["/auth/device"].post.security).toBeUndefined();
    expect(doc.paths["/sites"].get.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(doc.paths["/sites/{site}/deploys"].post.responses)).toEqual(
      expect.arrayContaining(["200", "201", "409", "413"]),
    );
  });
});
