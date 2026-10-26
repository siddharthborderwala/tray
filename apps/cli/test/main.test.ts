import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteAliases } from "../src/app.ts";
import { pollForKey } from "../src/commands/auth.ts";
import { keyIdFor } from "../src/commands/key.ts";
import { previousDeploy } from "../src/commands/sites.ts";
import { createApi } from "../src/api.ts";
import { loadAccounts, saveAccounts } from "../src/config.ts";
import { main, mergeGlobals } from "../src/main.ts";
import { memoryKeyStore, mockFetch, tmp } from "./helpers.ts";

const siteBody = (over: Record<string, unknown> = {}) => ({
  name: "report",
  url: "https://report.thts.app",
  visibility: "public",
  currentDeploy: "d2",
  domains: [],
  shareCount: 1,
  createdAt: "2026-10-26T09:12:03Z",
  updatedAt: "2026-10-26T09:12:03Z",
  ...over,
});
const deployBody = (id: string, site = siteBody()) => ({
  site,
  deploy: {
    id,
    files: 2,
    bytes: 15,
    spa: false,
    createdAt: "2026-10-26T09:12:03Z",
    createdBy: "sid@acme.com",
  },
});
const notFound = () =>
  Response.json({ error: "no such site", code: "site_not_found" }, { status: 404 });

let configHome: string;
let out: string[];
let err: string[];
let keys: ReturnType<typeof memoryKeyStore>;

beforeEach(() => {
  configHome = tmp();
  out = [];
  err = [];
  keys = memoryKeyStore({ "thts.app": "tray_k_saved" });
  saveAccounts(join(configHome, "tray"), {
    current: "thts.app",
    accounts: { "thts.app": { email: "sid@acme.com", keyName: "mbp" } },
  });
});

function run(
  argv: string[],
  routes: Parameters<typeof mockFetch>[0] = {},
  env: Record<string, string> = {},
) {
  const m = mockFetch(routes);
  const done = main(argv, {
    env: { XDG_CONFIG_HOME: configHome, ...env },
    stdinTTY: false,
    stdoutTTY: false,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    keyStore: keys,
    fetch: m.fetch,
    sleep: async () => {},
  });
  return { done, calls: m.calls };
}

function siteDir() {
  const dir = join(tmp(), "report");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "style.css"), "h1{}");
  return dir;
}

describe("tray put", () => {
  test("new site, --json: check → upload → deploy → one JSON object", async () => {
    const { done, calls } = run(["put", siteDir(), "--json", "--private"], {
      "GET /v1/sites/report": () => notFound(),
      "POST /v1/blobs/check": ({ body }) => ({ missing: body.hashes }),
      "PUT /v1/blobs/:sha": ({ path }) =>
        Response.json({ hash: path.split("/").pop(), size: 1 }, { status: 201 }),
      "POST /v1/sites/report/deploys": () =>
        Response.json(deployBody("d3", siteBody({ visibility: "private" })), { status: 201 }),
    });
    expect(await done).toBe(0);
    expect(out.length).toBe(1);
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({
      site: "report",
      url: "https://report.thts.app",
      visibility: "private",
      deploy: "d3",
      files: 2,
      uploaded: 2,
    });
    const deploy = calls.find((c) => c.path === "/v1/sites/report/deploys")!;
    expect(Object.keys(deploy.body.files).sort()).toEqual(["/index.html", "/style.css"]);
    expect(deploy.body.visibility).toBe("private");
    expect(deploy.body.replace).toBe(false);
    expect(deploy.body.source.path).toEndWith("/report");
    expect(deploy.body.source.machine).toMatch(/-[0-9a-f]{4}$/);
    expect(calls.filter((c) => c.method === "PUT").length).toBe(2);
  });

  test("redeploy doesn't send --private; non-interactive output is just the URL", async () => {
    const { done, calls } = run(["put", siteDir(), "--private"], {
      "GET /v1/sites/report": () => siteBody(),
      "POST /v1/blobs/check": () => ({ missing: [] }),
      "POST /v1/sites/report/deploys": () => Response.json(deployBody("d2"), { status: 200 }),
    });
    expect(await done).toBe(0);
    expect(out).toEqual(["https://report.thts.app"]);
    expect(
      calls.find((c) => c.method === "POST" && c.path.endsWith("/deploys"))!.body.visibility,
    ).toBeUndefined();
    expect(err.join("\n")).toContain("--private only applies");
  });

  test("site put from elsewhere, non-interactive: exit 1, site_exists, hint --replace", async () => {
    const { done } = run(["put", siteDir(), "--json"], {
      "GET /v1/sites/report": () => siteBody(),
      "POST /v1/blobs/check": () => ({ missing: [] }),
      "POST /v1/sites/report/deploys": () =>
        Response.json(
          { error: "report already exists (last put from ~/work/x on mbp)", code: "site_exists" },
          { status: 409 },
        ),
    });
    expect(await done).toBe(1);
    const json = JSON.parse(out[0]!);
    expect(json.code).toBe("site_exists");
    expect(json.error).toContain("last put from ~/work/x on mbp");
    expect(json.hint).toContain("--replace");
    expect(json.hint).toContain("-s <other>");
  });

  test("--replace sends replace: true", async () => {
    const { done, calls } = run(["put", siteDir(), "--replace"], {
      "GET /v1/sites/report": () => siteBody(),
      "POST /v1/blobs/check": () => ({ missing: [] }),
      "POST /v1/sites/report/deploys": () => Response.json(deployBody("d4"), { status: 201 }),
    });
    expect(await done).toBe(0);
    expect(calls.find((c) => c.path.endsWith("/deploys"))!.body.replace).toBe(true);
  });

  test("409 missing_blobs: uploads those blobs and retries once", async () => {
    let deploys = 0;
    const { done, calls } = run(["put", siteDir()], {
      "GET /v1/sites/report": () => siteBody(),
      "POST /v1/blobs/check": () => ({ missing: [] }),
      "PUT /v1/blobs/:sha": ({ path }) => Response.json({ hash: path.split("/").pop(), size: 1 }),
      "POST /v1/sites/report/deploys": ({ body }) => {
        if (++deploys === 1) {
          const missing = [Object.values(body.files as Record<string, { hash: string }>)[0]!.hash];
          return Response.json(
            { error: "blobs missing", code: "missing_blobs", missing },
            { status: 409 },
          );
        }
        return Response.json(deployBody("d5"), { status: 201 });
      },
    });
    expect(await done).toBe(0);
    expect(deploys).toBe(2);
    expect(calls.filter((c) => c.method === "PUT").length).toBe(1);
  });

  test("invalid site name is exit 2 naming --site", async () => {
    const { done } = run(["put", siteDir(), "-s", "Bad_Name", "--json"]);
    expect(await done).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: "invalid_usage", param: "--site" });
  });

  test("over 50 MB exits 1 before any request", async () => {
    const dir = siteDir();
    writeFileSync(join(dir, "big.bin"), new Uint8Array(51 * 1024 * 1024));
    const { done, calls } = run(["put", dir]);
    expect(await done).toBe(1);
    expect(err.join("\n")).toContain("big.bin");
    expect(calls.length).toBe(0);
  });
});

describe("auth + modes", () => {
  test("not logged in: exit 4 with the spec's message on stderr", async () => {
    keys = memoryKeyStore();
    const { done } = run(["list"]);
    expect(await done).toBe(4);
    expect(out).toEqual([]);
    expect(err.join("\n")).toBe(
      "error: not logged in to thts.app\nRun `tray login thts.app` or set TRAY_API_KEY.",
    );
  });

  test("TRAY_API_KEY overrides the saved key; --domain overrides the account", async () => {
    const { done, calls } = run(
      ["list", "--domain", "other.dev"],
      { "GET /v1/sites": () => ({ data: [] }) },
      { TRAY_API_KEY: "tray_k_env", TRAY_API_URL: "https://tray.other.dev" },
    );
    expect(await done).toBe(0);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tray_k_env");
  });

  test("401 from the API exits 4", async () => {
    const { done } = run(["list", "--json"], {
      "GET /v1/sites": () =>
        Response.json({ error: "bad key", code: "unauthenticated" }, { status: 401 }),
    });
    expect(await done).toBe(4);
    expect(JSON.parse(out[0]!).code).toBe("unauthenticated");
  });

  test("confirmation without a TTY needs --yes (exit 2)", async () => {
    const { done, calls } = run(["remove", "report"]);
    expect(await done).toBe(2);
    expect(err.join("\n")).toContain("--yes");
    expect(calls.length).toBe(0);
  });

  test("remove --yes", async () => {
    const { done, calls } = run(["rm", "report", "-y"], {
      "DELETE /v1/sites/report": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[0]!.method).toBe("DELETE");
  });

  test("logout revokes the current key and forgets it", async () => {
    const { done, calls } = run(["logout"], {
      "DELETE /v1/keys/current": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[0]!.path).toBe("/v1/keys/current");
    expect(keys.data["thts.app"]).toBeUndefined();
    expect(loadAccounts(join(configHome, "tray")).current).toBeUndefined();
  });

  test("approve shows the device then approves with --yes", async () => {
    const { done, calls } = run(["approve", "qxft-7k2m", "--yes"], {
      "GET /v1/auth/device/:code": () => ({
        name: "ci-box",
        ip: "10.0.0.2",
        expiresAt: "2026-10-26T09:22:03Z",
      }),
      "POST /v1/auth/approve": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[0]!.path).toBe("/v1/auth/device/QXFT-7K2M");
    expect(err.join("\n")).toContain("ci-box");
    expect(calls[1]!.body).toEqual({ userCode: "QXFT-7K2M", approve: true });
  });

  test("login --json prints {approveUrl,userCode} then the result, and saves the key", async () => {
    keys = memoryKeyStore();
    let polls = 0;
    const { done } = run(["login", "new.dev", "--json", "--name", "ci"], {
      "POST /v1/auth/device": () => ({
        deviceCode: "dc",
        userCode: "AAAA-BBBB",
        verificationUri: "https://tray.new.dev/approve",
        verificationUriComplete: "https://tray.new.dev/approve?code=AAAA-BBBB",
        expiresIn: 600,
        interval: 5,
      }),
      "POST /v1/auth/token": () =>
        ++polls < 3
          ? Response.json({ error: "pending", code: "authorization_pending" }, { status: 400 })
          : { key: "tray_k_new", email: "sid@acme.com", name: "ci" },
    });
    expect(await done).toBe(0);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { approveUrl: "https://tray.new.dev/approve?code=AAAA-BBBB", userCode: "AAAA-BBBB" },
      { domain: "new.dev", email: "sid@acme.com", name: "ci" },
    ]);
    expect(keys.data["new.dev"]).toBe("tray_k_new");
    expect(loadAccounts(join(configHome, "tray")).current).toBe("new.dev");
  });
});

describe("other commands", () => {
  test("rollback without --to resolves the previous deploy and sends it", async () => {
    const { done, calls } = run(["rollback", "report"], {
      "GET /v1/sites/report": () => siteBody({ currentDeploy: "d3" }),
      "GET /v1/sites/report/deploys": () => ({
        data: ["d3", "d2", "d1"].map((id) => ({
          id,
          files: 1,
          bytes: 1,
          spa: false,
          createdAt: "2026-10-26T09:12:03Z",
          createdBy: "sid@acme.com",
        })),
        hasMore: false,
      }),
      "POST /v1/sites/report/rollback": () => siteBody({ currentDeploy: "d2" }),
    });
    expect(await done).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ to: "d2" });
    expect(out[0]).toContain("d2");
  });

  test("unshare deletes each entry, then lists", async () => {
    const { done, calls } = run(["unshare", "report", "bob@acme.com", "@acme.com"], {
      "DELETE /v1/sites/report/shares/:entry": () => new Response(null, { status: 204 }),
      "GET /v1/sites/report/shares": () => ({ data: [{ entry: "sid@acme.com", owner: true }] }),
    });
    expect(await done).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/sites/report/shares/bob%40acme.com",
      "DELETE /v1/sites/report/shares/%40acme.com",
      "GET /v1/sites/report/shares",
    ]);
    expect(out).toEqual(["sid@acme.com (owner)"]);
  });

  test("share rejects things that aren't emails or @domains (exit 2)", async () => {
    const { done, calls } = run(["share", "report", "bob"]);
    expect(await done).toBe(2);
    expect(calls.length).toBe(0);
  });

  test("key revoke maps the name to an id", async () => {
    const key = (id: string, name: string) => ({
      id,
      name,
      email: "sid@acme.com",
      createdAt: "2026-10-26T09:12:03Z",
      lastUsedAt: null,
    });
    const { done, calls } = run(["key", "revoke", "ci"], {
      "GET /v1/keys": () => ({ data: [key("aaaaaaaaaaaa", "mbp"), key("bbbbbbbbbbbb", "ci")] }),
      "DELETE /v1/keys/:id": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[1]!.path).toBe("/v1/keys/bbbbbbbbbbbb");
  });

  test("setup and upgrade are stubs that fail clearly", async () => {
    expect(await run(["setup", "--json"]).done).toBe(1);
    expect(JSON.parse(out[0]!).code).toBe("not_implemented");
    expect(await run(["upgrade"]).done).toBe(1);
  });
});

describe("parsing", () => {
  test("usage errors are exit 2, JSON with --json", async () => {
    expect(await run(["put", "--json"]).done).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: "invalid_usage" });
    expect(await run(["put", "x", "--bogus"]).done).toBe(2);
    expect(err.at(-1)).toContain("--bogus");
  });

  test("--help and --version exit 0 on stdout", async () => {
    expect(await run(["put", "--help"]).done).toBe(0);
    expect(out[0]).toContain("Usage:\n  tray put");
    expect(await run(["--version"]).done).toBe(0);
    expect(out[1]).toMatch(/^tray \d+\.\d+\.\d+/);
  });

  test("bare `tray` prints help (exit 0); bare group prints its help (exit 2)", async () => {
    expect(await run([]).done).toBe(0);
    expect(await run(["key"]).done).toBe(2);
    expect(err.at(-1)).toContain("tray key");
  });

  test("aliases only touch command words", () => {
    expect(rewriteAliases(["ls"])).toEqual(["list"]);
    expect(rewriteAliases(["rm", "ls"])).toEqual(["remove", "ls"]); // site named "ls"
    expect(rewriteAliases(["domains", "rm", "x.com"])).toEqual(["domain", "remove", "x.com"]);
    expect(rewriteAliases(["--domain", "ls", "keys", "ls"])).toEqual([
      "--domain",
      "ls",
      "key",
      "list",
    ]);
    expect(rewriteAliases(["put", "rm"])).toEqual(["put", "rm"]);
  });

  test("global flags merge across route levels", () => {
    expect(
      mergeGlobals({
        "/": { json: true, domain: "a.app" },
        "/put": { yes: true, domain: "b.app" },
      }),
    ).toEqual({
      json: true,
      nonInteractive: false,
      yes: true,
      domain: "b.app",
    });
  });
});

describe("pure helpers", () => {
  test("pollForKey: pending keeps polling, slow_down adds 5s, access_denied exits 4", async () => {
    const replies = ["authorization_pending", "slow_down", "ok"];
    const m = mockFetch({
      "POST /v1/auth/token": () => {
        const r = replies.shift()!;
        return r === "ok"
          ? { key: "tray_k_x", email: "e", name: "n" }
          : Response.json({ error: r, code: r }, { status: 400 });
      },
    });
    const sleeps: number[] = [];
    const api = createApi({ baseUrl: "https://tray.t.app", fetch: m.fetch });
    const token = await pollForKey(api, "dc", 5, { sleep: async (ms) => sleeps.push(ms) });
    expect(token.key).toBe("tray_k_x");
    expect(sleeps).toEqual([5000, 5000, 10000]);

    const denied = mockFetch({
      "POST /v1/auth/token": () =>
        Response.json({ error: "no", code: "access_denied" }, { status: 400 }),
    });
    const err = await pollForKey(
      createApi({ baseUrl: "https://tray.t.app", fetch: denied.fetch }),
      "dc",
      1,
      { sleep: async () => {} },
    ).catch((e) => e);
    expect(err.exit).toBe(4);
  });

  test("pollForKey stops at expired_token", async () => {
    const m = mockFetch({
      "POST /v1/auth/token": () =>
        Response.json({ error: "gone", code: "expired_token" }, { status: 400 }),
    });
    const err = await pollForKey(
      createApi({ baseUrl: "https://tray.t.app", fetch: m.fetch }),
      "dc",
      1,
      { sleep: async () => {} },
    ).catch((e) => e);
    expect(err.code).toBe("expired_token");
  });

  test("previousDeploy", () => {
    const d = (id: string) => ({
      id,
      files: 1,
      bytes: 1,
      spa: false,
      createdAt: "",
      createdBy: "",
    });
    expect(previousDeploy([d("c"), d("b"), d("a")], "c")!.id).toBe("b");
    expect(previousDeploy([d("c"), d("b")], "b")).toBeUndefined();
    expect(previousDeploy([d("c")], "zz")).toBeUndefined();
  });

  test("keyIdFor: by id, by unique name, errors on none or ambiguous", () => {
    const k = (id: string, name: string) => ({
      id,
      name,
      email: "e",
      createdAt: "2026-10-26T09:12:03Z",
      lastUsedAt: null,
    });
    const keys = [k("aaa", "mbp"), k("bbb", "ci"), k("ccc", "ci")];
    expect(keyIdFor(keys, "mbp")).toBe("aaa");
    expect(keyIdFor(keys, "ccc")).toBe("ccc");
    expect(() => keyIdFor(keys, "nope")).toThrow("no key named nope");
    try {
      keyIdFor(keys, "ci");
      throw new Error("expected ambiguity");
    } catch (e: any) {
      expect(e.code).toBe("ambiguous_key");
      expect(e.exit).toBe(2);
      expect(e.hint).toContain("bbb");
      expect(e.hint).toContain("ccc");
    }
  });
});
