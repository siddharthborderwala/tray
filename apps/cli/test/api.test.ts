import { describe, expect, test } from "bun:test";
import { ApiFailure, apiError, createApi, exitForStatus, olderThan } from "../src/api.ts";
import { TrayError } from "../src/errors.ts";
import { VERSION } from "../src/version.ts";
import { mockFetch } from "./helpers.ts";

const site = {
  name: "report",
  url: "https://report.thts.app",
  visibility: "public" as const,
  currentDeploy: "d2",
  domains: [],
  shareCount: 1,
  createdAt: "2026-10-26T09:12:03Z",
  updatedAt: "2026-10-26T09:12:03Z",
};
const H = (c: string) => c.repeat(64);
const make = (
  routes: Parameters<typeof mockFetch>[0],
  extra: { onOutdated?: (v: string) => void } = {},
) => {
  const m = mockFetch(routes);
  return {
    ...m,
    api: createApi({
      baseUrl: "https://tray.thts.app",
      key: "tray_k_test",
      fetch: m.fetch,
      ...extra,
    }),
  };
};

describe("requests", () => {
  test("uses /v1, bearer auth and JSON bodies", async () => {
    const { api, calls } = make({ "POST /v1/blobs/check": () => ({ missing: [H("a")] }) });
    expect(await api.checkBlobs([H("a"), H("b")])).toEqual({ missing: [H("a")] });
    expect(calls[0]!.path).toBe("/v1/blobs/check");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tray_k_test");
    expect(calls[0]!.body).toEqual({ hashes: [H("a"), H("b")] });
  });

  test("PUT /blobs/{sha} sends raw bytes with Content-Length", async () => {
    const { api, calls } = make({
      "PUT /v1/blobs/:sha": () => Response.json({ hash: H("c"), size: 3 }, { status: 201 }),
    });
    await api.putBlob(H("c"), new Uint8Array([1, 2, 3]));
    expect(calls[0]!.path).toBe(`/v1/blobs/${H("c")}`);
    expect(calls[0]!.headers.get("content-length")).toBe("3");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tray_k_test");
    expect(calls[0]!.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("blob PUT retries once on 5xx, not on 4xx", async () => {
    let n = 0;
    const { api } = make({
      "PUT /v1/blobs/:sha": () =>
        ++n === 1
          ? Response.json({ error: "boom", code: "internal" }, { status: 503 })
          : Response.json({ hash: H("a"), size: 1 }),
    });
    await api.putBlob(H("a"), new Uint8Array([1]));
    expect(n).toBe(2);

    let m = 0;
    const bad = make({
      "PUT /v1/blobs/:sha": () => (
        m++,
        Response.json({ error: "bad digest", code: "digest_mismatch" }, { status: 400 })
      ),
    });
    await expect(bad.api.putBlob("a", new Uint8Array([1]))).rejects.toThrow("bad digest");
    expect(m).toBe(1);
  });

  test("blob PUT retries once on a network error, then gives up", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: "https://tray.thts.app", key: "k", fetch: fetchImpl });
    const err = await api.putBlob("a", new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(TrayError);
    expect(err.code).toBe("network");
    expect(n).toBe(2);
  });

  test("deploy reports 201 as created and 200 as unchanged", async () => {
    let status = 201;
    const body = {
      site,
      deploy: {
        id: "d3",
        files: 0,
        bytes: 0,
        spa: false,
        createdAt: "2026-10-26T09:12:03Z",
        createdBy: "sid@acme.com",
      },
    };
    const { api, calls } = make({
      "POST /v1/sites/:site/deploys": () => Response.json(body, { status }),
    });
    const req = { files: {}, spa: false, source: { path: "/x", machine: "mbp-1234" } };
    expect(await api.deploy("report", req)).toEqual({ ...body, created: true });
    status = 200;
    expect((await api.deploy("report", req)).created).toBe(false);
    expect(calls[0]!.path).toBe("/v1/sites/report/deploys");
    expect(calls[0]!.body).toEqual(req);
  });

  test("getSite returns null on 404", async () => {
    const { api } = make({
      "GET /v1/sites/report": () => site,
      "GET /v1/sites/:site": () =>
        Response.json({ error: "no such site", code: "site_not_found" }, { status: 404 }),
    });
    expect((await api.getSite("report"))!.name).toBe("report");
    expect(await api.getSite("nope")).toBeNull();
  });

  test("deploys list sends limit/before; rollback sends to", async () => {
    const { api, calls } = make({
      "GET /v1/sites/:site/deploys": () => ({ data: [], hasMore: false }),
      "POST /v1/sites/:site/rollback": () => site,
    });
    await api.listDeploys("report", { limit: 20, before: "d9" });
    await api.rollback("report", "d1");
    expect(calls[0]!.path).toBe("/v1/sites/report/deploys?limit=20&before=d9");
    expect(calls[1]!.body).toEqual({ to: "d1" });
  });

  test("DELETEs put the item in the path, URL-encoded, and accept 204", async () => {
    const { api, calls } = make({
      "DELETE /v1/sites/:site/shares/:entry": () => new Response(null, { status: 204 }),
      "DELETE /v1/keys/current": () => new Response(null, { status: 204 }),
      "DELETE /v1/keys/:id": () => new Response(null, { status: 204 }),
      "DELETE /v1/domains/:host": () => new Response(null, { status: 204 }),
    });
    await api.removeShare("report", "@acme.com");
    await api.revokeCurrentKey();
    await api.revokeKey("3f9a0c1d2e4b");
    await api.removeDomain("docs.acme.com");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/sites/report/shares/%40acme.com",
      "DELETE /v1/keys/current",
      "DELETE /v1/keys/3f9a0c1d2e4b",
      "DELETE /v1/domains/docs.acme.com",
    ]);
    expect(calls.every((c) => c.body === undefined)).toBe(true);
  });

  test("device flow endpoints", async () => {
    const { api, calls } = make({
      "POST /v1/auth/device": () => ({
        deviceCode: "dc",
        userCode: "QXFT-7K2M",
        verificationUri: "https://tray.thts.app/approve",
        verificationUriComplete: "https://tray.thts.app/approve?code=QXFT-7K2M",
        expiresIn: 600,
        interval: 5,
      }),
      "GET /v1/auth/device/:code": () => ({
        name: "mbp",
        ip: "1.2.3.4",
        expiresAt: "2026-10-26T09:22:03Z",
      }),
      "POST /v1/auth/approve": () => new Response(null, { status: 204 }),
    });
    expect((await api.startDevice("mbp")).userCode).toBe("QXFT-7K2M");
    expect((await api.getDevice("QXFT-7K2M")).ip).toBe("1.2.3.4");
    await api.approveDevice("QXFT-7K2M");
    expect(calls[2]!.body).toEqual({ userCode: "QXFT-7K2M", approve: true });
  });
});

describe("errors", () => {
  test("status → exit code: 401/403 → 4, 400 → 2, else 1", () => {
    expect(exitForStatus(401)).toBe(4);
    expect(exitForStatus(403)).toBe(4);
    expect(exitForStatus(400)).toBe(2);
    expect(exitForStatus(404)).toBe(1);
    expect(exitForStatus(409)).toBe(1);
    expect(exitForStatus(500)).toBe(1);
  });

  test("uses the API error body, including param and extra fields", async () => {
    const { api } = make({
      "POST /v1/sites/:site/deploys": () =>
        Response.json(
          {
            error: "report already exists",
            code: "site_exists",
            hint: "use --replace",
            param: "site",
          },
          { status: 409 },
        ),
    });
    const err = await api
      .deploy("report", { files: {}, spa: false, source: { path: "/x", machine: "m" } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe("site_exists");
    expect(err.exit).toBe(1);
    expect(err.hint).toBe("use --replace");
    expect(err.param).toBeUndefined(); // CLI errors carry param only when the CLI sets it
    expect(err.body.param).toBe("site");
  });

  test("5xx includes the cf-ray request id", () => {
    const err = apiError(
      { status: 502, headers: new Headers({ "cf-ray": "8a1b2c3d4e-SJC" }) },
      { error: "upstream", code: "internal" },
    );
    expect(err.hint).toContain("8a1b2c3d4e-SJC");
    const bare = apiError({ status: 500, headers: new Headers({ "cf-ray": "x1" }) }, "not json");
    expect(bare.code).toBe("internal");
    expect(bare.hint).toContain("x1");
  });

  test("401 without a body still exits 4", () => {
    expect(apiError({ status: 401, headers: new Headers() }, undefined).exit).toBe(4);
  });

  test("network failure → exit 1, code network", async () => {
    const api = createApi({
      baseUrl: "https://tray.thts.app",
      fetch: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    const err = await api.listSites().catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.exit).toBe(1);
    expect(err.message).toContain("tray.thts.app");
  });

  test("a 2xx response that isn't JSON is bad_response", async () => {
    const { api } = make({ "GET /v1/sites": () => new Response("<html>proxy page</html>") });
    expect((await api.listSites().catch((e) => e)).code).toBe("bad_response");
  });
});

describe("Tray-Version", () => {
  test("warns once when the Worker is older than the CLI", async () => {
    const warnings: string[] = [];
    const { api } = make(
      {
        "GET /v1/sites": () =>
          Response.json({ data: [] }, { headers: { "Tray-Version": "0.0.1" } }),
      },
      { onOutdated: (v) => warnings.push(v) },
    );
    await api.listSites();
    await api.listSites();
    expect(warnings).toEqual(["0.0.1"]);
  });

  test("no warning for the same or a newer Worker", async () => {
    const warnings: string[] = [];
    const { api } = make(
      {
        "GET /v1/sites": () =>
          Response.json({ data: [] }, { headers: { "Tray-Version": VERSION } }),
      },
      { onOutdated: (v) => warnings.push(v) },
    );
    await api.listSites();
    expect(warnings).toEqual([]);
  });

  test("olderThan compares semver numerically", () => {
    expect(olderThan("0.9.0", "0.10.0")).toBe(true);
    expect(olderThan("1.0.0", "1.0.0")).toBe(false);
    expect(olderThan("v1.2.0", "1.1.9")).toBe(false);
    expect(olderThan("1.2.0-beta.1", "1.2.1")).toBe(true);
  });
});
