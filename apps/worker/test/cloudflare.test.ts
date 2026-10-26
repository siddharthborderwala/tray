// The real Cloudflare API module, against a recorded fake of the REST API.
import { describe, expect, test } from "bun:test";
import { cloudflareApi } from "../src/cloudflare.ts";
import type { Env } from "../src/env.ts";
import { TrayError } from "../src/errors.ts";

const env = {
  DOMAIN: "thts.app",
  CF_ACCOUNT_ID: "acct",
  CF_API_TOKEN: "tok",
  ACCESS_SIGNIN_APP_ID: "app1",
  WORKER_NAME: "tray",
} as Env;

function fakeApi() {
  const calls: { method: string; url: string; body?: unknown; auth: string | null }[] = [];
  let app = {
    id: "app1",
    aud: "aud",
    name: "tray sign-in",
    type: "self_hosted",
    domain: "*.thts.app/.tray/signin",
    destinations: [{ type: "public", uri: "*.thts.app/.tray/signin" }],
    policies: [{ id: "pol1", precedence: 1, name: "anyone", decision: "allow" }],
    created_at: "x",
  };
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get("authorization") });
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    if (path.startsWith("/zones?")) {
      const name = new URL(url).searchParams.get("name");
      return ok(name === "acme.com" ? [{ id: "zone1", name: "acme.com" }] : []);
    }
    if (path === "/accounts/acct/workers/domains" && method === "PUT")
      return ok({ id: "dom1", ...body });
    if (path.startsWith("/accounts/acct/workers/domains?"))
      return ok([{ id: "dom1", hostname: "docs.acme.com" }]);
    if (path === "/accounts/acct/workers/domains/dom1" && method === "DELETE") return ok(null);
    if (path === "/accounts/acct/access/apps/app1" && method === "GET") return ok(app);
    if (path === "/accounts/acct/access/apps/app1" && method === "PUT") {
      app = { ...app, ...body };
      return ok(app);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: "No route" }], result: null },
      { status: 404 },
    );
  };
  return { calls, fetch, app: () => app };
}

describe("cloudflareApi", () => {
  test("attachDomain finds the zone, then PUTs the Worker custom domain", async () => {
    const f = fakeApi();
    await cloudflareApi(env, f.fetch).attachDomain("docs.acme.com");
    expect(
      f.calls.map(
        (c) => `${c.method} ${c.url.replace("https://api.cloudflare.com/client/v4", "")}`,
      ),
    ).toEqual([
      "GET /zones?name=docs.acme.com&account.id=acct",
      "GET /zones?name=acme.com&account.id=acct",
      "PUT /accounts/acct/workers/domains",
    ]);
    expect(f.calls[2]!.body).toEqual({
      hostname: "docs.acme.com",
      service: "tray",
      zone_id: "zone1",
    });
    expect(f.calls[0]!.auth).toBe("Bearer tok");
  });

  test("attachDomain → 422 zone_not_in_account when no zone matches", async () => {
    const f = fakeApi();
    const err = await cloudflareApi(env, f.fetch)
      .attachDomain("docs.other.org")
      .catch((e) => e);
    expect(err).toBeInstanceOf(TrayError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("zone_not_in_account");
  });

  test("detachDomain looks up by hostname and deletes", async () => {
    const f = fakeApi();
    await cloudflareApi(env, f.fetch).detachDomain("docs.acme.com");
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(f.calls[1]!.url).toEndWith("/workers/domains/dom1");
  });

  test("sign-in host add/remove updates destinations, keeps policies by id", async () => {
    const f = fakeApi();
    const cf = cloudflareApi(env, f.fetch);
    await cf.addSigninHost("docs.acme.com");
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      name: "tray sign-in",
      type: "self_hosted",
      domain: "*.thts.app/.tray/signin",
      destinations: [
        { type: "public", uri: "*.thts.app/.tray/signin" },
        { type: "public", uri: "docs.acme.com/.tray/signin" },
      ],
      policies: [{ id: "pol1", precedence: 1 }],
    });
    expect(put.body).not.toHaveProperty("id");
    expect(put.body).not.toHaveProperty("aud");

    // Adding again: no PUT.
    f.calls.length = 0;
    await cf.addSigninHost("docs.acme.com");
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);

    await cf.removeSigninHost("docs.acme.com");
    expect(f.app().destinations).toEqual([{ type: "public", uri: "*.thts.app/.tray/signin" }]);
  });

  test("API failures and missing config become TrayErrors", async () => {
    const f = fakeApi();
    const err = await cloudflareApi({ ...env, ACCESS_SIGNIN_APP_ID: "nope" }, f.fetch)
      .addSigninHost("x.acme.com")
      .catch((e) => e);
    expect(err).toBeInstanceOf(TrayError);
    expect(err.message).toContain("No route (7003)");

    const noToken = await cloudflareApi({ ...env, CF_API_TOKEN: undefined }, f.fetch)
      .attachDomain("x.acme.com")
      .catch((e) => e);
    expect(noToken.status).toBe(500);
    expect(noToken.options.hint).toContain("tray setup");
  });
});
