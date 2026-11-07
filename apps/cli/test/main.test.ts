import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@bomb.sh/router";
import { app, rewriteAliases } from "../src/app.ts";
import { EXAMPLES } from "../src/help.ts";
import { pollForKey } from "../src/commands/auth.ts";
import { keyIdFor } from "../src/commands/key.ts";
import { previousDeploy } from "../src/commands/sites.ts";
import { createApi } from "../src/api.ts";
import { loadAccounts, saveAccounts } from "../src/config.ts";
import { main, mergeGlobals, normalizeArgv } from "../src/main.ts";
import { memoryKeyStore, mockFetch, tmp } from "./helpers.ts";

const siteBody = (over: Record<string, unknown> = {}) => ({
  name: "report",
  url: "https://report.acme.dev",
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
  keys = memoryKeyStore({ "acme.dev": "tray_k_saved" });
  saveAccounts(join(configHome, "tray"), {
    current: "acme.dev",
    accounts: { "acme.dev": { email: "sid@acme.com", keyName: "mbp" } },
  });
});

function run(
  argv: string[],
  routes: Parameters<typeof mockFetch>[0] = {},
  env: Record<string, string> = {},
  stdoutTTY = false,
) {
  const m = mockFetch(routes);
  const done = main(argv, {
    env: { XDG_CONFIG_HOME: configHome, ...env },
    stdinTTY: false,
    stdoutTTY,
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
      site: { name: "report", url: "https://report.acme.dev", visibility: "private", deploy: "d3" },
      outcome: "created",
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
    expect(out).toEqual(["https://report.acme.dev"]);
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
    const json = JSON.parse(err[0]!);
    expect(json.code).toBe("site_exists");
    expect(json.error).toContain("last put from ~/work/x on mbp");
    expect(json.next[0]).toContain("--replace");
    expect(json.next[1]).toContain("--site <OTHER>");
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
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "invalid_usage", param: "--site" });
  });

  test("several files: one site, each file at /<name>, plus a generated list", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.png"), "a");
    writeFileSync(join(dir, "b.png"), "b");
    const { done, calls } = run(
      ["put", join(dir, "a.png"), join(dir, "b.png"), "-s", "x", "--json"],
      {
        "GET /v1/sites/x": () => notFound(),
        "POST /v1/blobs/check": () => ({ missing: [] }),
        "POST /v1/sites/x/deploys": () => Response.json(deployBody("d6"), { status: 201 }),
      },
    );
    expect(await done).toBe(0);
    const deploy = calls.find((c) => c.path === "/v1/sites/x/deploys")!;
    expect(Object.keys(deploy.body.files).sort()).toEqual(["/a.png", "/b.png", "/index.html"]);
    expect(deploy.body.source.path).toBe(dir);
    expect(JSON.parse(out[0]!).files).toBe(3); // counts the generated index
    expect(err).toEqual([]); // --json: stderr stays clean
  });

  test("several files without -s, non-interactive: exit 2 before any request", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.png"), "a");
    writeFileSync(join(dir, "b.png"), "b");
    const { done, calls } = run(["put", join(dir, "a.png"), join(dir, "b.png"), "--json"]);
    expect(await done).toBe(2);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "missing_input", param: "--site" });
    expect(calls.length).toBe(0);
  });

  test("one PDF: named after the file, and the link opens it directly", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "Q3 Report.pdf"), "%PDF");
    const { done, calls } = run(["put", join(dir, "Q3 Report.pdf")], {
      "GET /v1/sites/q3-report": () => notFound(),
      "POST /v1/blobs/check": () => ({ missing: [] }),
      "POST /v1/sites/q3-report/deploys": () => Response.json(deployBody("d7"), { status: 201 }),
    });
    expect(await done).toBe(0);
    const deploy = calls.find((c) => c.path === "/v1/sites/q3-report/deploys")!;
    expect(Object.keys(deploy.body.files).sort()).toEqual(["/Q3 Report.pdf", "/index.html"]);
    expect(deploy.body.files["/Q3 Report.pdf"].type).toBe("application/pdf");
    // Non-interactive progress: one plain line per phase, on stderr.
    expect(err).toEqual([
      "Collected 2 files · 2.9 KB",
      "The link opens Q3 Report.pdf directly.",
      "No changed files",
    ]);
  });

  test("over the size limit exits 1 before any request", async () => {
    const dir = siteDir();
    writeFileSync(join(dir, "big.bin"), new Uint8Array(101 * 1024 * 1024));
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
      "Error: Not logged in to acme.dev.\n\nLog in, or set TRAY_API_KEY:\n    tray login acme.dev",
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
    expect(out).toEqual([]); // failure: stdout empty, one JSON line on stderr
    expect(JSON.parse(err[0]!).code).toBe("unauthenticated");
  });

  const removable = {
    "GET /v1/sites/report": () => siteBody({ domains: ["docs.acme.com"] }),
    "GET /v1/sites/report/deploys": () => ({ data: [], hasMore: false }),
    "DELETE /v1/sites/report": () => new Response(null, { status: 204 }),
  };

  test("remove: looks the site up first; without a TTY it needs --yes, and says the retry", async () => {
    expect(await run(["remove", "nope"], { "GET /v1/sites/nope": () => notFound() }).done).toBe(1);
    err = [];
    const { done, calls } = run(["remove", "report"], removable);
    expect(await done).toBe(2);
    expect(err.join("\n")).toEndWith("Confirm with --yes:\n    tray remove report --yes");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("remove --yes deletes and prints just the name", async () => {
    const { done, calls } = run(["rm", "report", "-y"], removable);
    expect(await done).toBe(0);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(out).toEqual(["report"]);
    expect(err).toEqual(["✓ Removed report"]);
  });

  test("logout revokes the current key and forgets it", async () => {
    const { done, calls } = run(["logout"], {
      "DELETE /v1/keys/current": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[0]!.path).toBe("/v1/keys/current");
    expect(keys.data["acme.dev"]).toBeUndefined();
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

  test("login --json: the approve link as one JSON line on stderr, the result alone on stdout", async () => {
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
    expect(JSON.parse(err[0]!).pending).toMatchObject({
      approveUrl: "https://tray.new.dev/approve?code=AAAA-BBBB",
      userCode: "AAAA-BBBB",
    });
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { account: { domain: "new.dev", email: "sid@acme.com", name: "ci" }, outcome: "logged_in" },
    ]);
    expect(keys.data["new.dev"]).toBe("tray_k_new");
    expect(loadAccounts(join(configHome, "tray")).current).toBe("new.dev");
  });
});

describe("other commands", () => {
  test("rollback never guesses: without --to it fails naming the previous deploy; with it, it sends it", async () => {
    const routes = {
      "GET /v1/sites/report": () => siteBody({ currentDeploy: "mh7q2k1c-0003" }),
      "GET /v1/sites/report/deploys": () => ({
        data: ["mh7q2k1c-0003", "mh7q2k1c-0002", "mh7q2k1c-0001"].map((id) => ({
          id,
          files: 1,
          bytes: 1,
          spa: false,
          createdAt: "2026-10-26T09:12:03Z",
          createdBy: "sid@acme.com",
        })),
        hasMore: false,
      }),
      "POST /v1/sites/report/rollback": () => siteBody({ currentDeploy: "mh7q2k1c-0002" }),
    };
    expect(await run(["rollback", "report"], routes).done).toBe(2);
    expect(err.join("\n")).toEndWith("    tray rollback report --to mh7q2k1c-0002");
    const { done, calls } = run(["rollback", "report", "--to", "mh7q2k1c-0002"], routes);
    expect(await done).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ to: "mh7q2k1c-0002" });
    expect(out).toEqual(["https://report.acme.dev"]);
  });

  test("unshare deletes each entry, then lists", async () => {
    const { done, calls } = run(["unshare", "report", "bob@acme.com", "@acme.com", "--yes"], {
      "DELETE /v1/sites/report/shares/:entry": () => new Response(null, { status: 204 }),
      "GET /v1/sites/report/shares": () => ({ data: [{ entry: "sid@acme.com", owner: true }] }),
    });
    expect(await done).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/sites/report/shares/bob%40acme.com",
      "DELETE /v1/sites/report/shares/%40acme.com",
      "GET /v1/sites/report/shares",
    ]);
    expect(out).toEqual(["WHO\tROLE\nsid@acme.com\towner"]); // piped: TSV
  });

  test("share rejects things that aren't emails or @domains (exit 2), naming each", async () => {
    const { done, calls } = run(["share", "report", "bob", "x@"]);
    expect(await done).toBe(2);
    expect(calls.length).toBe(0);
    expect(err.join("\n")).toContain(
      "2 entries are invalid.\n  bob: not an email or @domain\n  x@:",
    );
  });

  test("key revoke maps the name to an id", async () => {
    const key = (id: string, name: string) => ({
      id,
      name,
      email: "sid@acme.com",
      createdAt: "2026-10-26T09:12:03Z",
      lastUsedAt: null,
    });
    const { done, calls } = run(["key", "revoke", "ci", "--yes"], {
      "GET /v1/keys": () => ({ data: [key("aaaaaaaaaaaa", "mbp"), key("bbbbbbbbbbbb", "ci")] }),
      "DELETE /v1/keys/:id": () => new Response(null, { status: 204 }),
    });
    expect(await done).toBe(0);
    expect(calls[1]!.path).toBe("/v1/keys/bbbbbbbbbbbb");
  });

  test("setup without --domain exits 2 naming the flag (full flow: setup.test.ts)", async () => {
    expect(await run(["setup", "--json"]).done).toBe(2);
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "missing_input", param: "--domain" });
  });
});

describe("whoami and skill", () => {
  test("whoami --json: domain, email, key name, source", async () => {
    expect(await run(["whoami", "--json"]).done).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      account: { domain: "acme.dev", email: "sid@acme.com", key: "mbp", source: "keychain" },
    });
  });

  test("whoami reports TRAY_API_KEY as source env", async () => {
    keys = memoryKeyStore();
    expect(await run(["whoami", "--json"], {}, { TRAY_API_KEY: "tray_k_x" }).done).toBe(0);
    expect(JSON.parse(out[0]!).account).toMatchObject({ domain: "acme.dev", source: "env" });
  });

  test("whoami: a saved key without a local login record says so", async () => {
    saveAccounts(join(configHome, "tray"), { accounts: {} });
    expect(await run(["whoami", "--json", "--domain", "acme.dev"]).done).toBe(0);
    const me = JSON.parse(out[0]!);
    expect(me.account).toMatchObject({ domain: "acme.dev", email: null, key: null });
    expect(me.warnings[0].message).toContain("no local login record");
    expect(me.warnings[0].message).toContain("tray login acme.dev");
  });

  test("whoami exits 4 when not logged in, with no network calls", async () => {
    keys = memoryKeyStore();
    const { done, calls } = run(["whoami"]);
    expect(await done).toBe(4);
    expect(calls.length).toBe(0);
    expect(err.join("\n")).toContain("tray login acme.dev");
  });

  test("tray skill prints the guide", async () => {
    expect(await run(["skill"]).done).toBe(0);
    expect(out[0]).toContain("# Tray agent guide");
  });

  test("tray skill install --json lists the files", async () => {
    const home = tmp();
    expect(await run(["skill", "install", "--json"], {}, { HOME: home }).done).toBe(0);
    const res = JSON.parse(out[0]!);
    expect(res.skill.written).toEqual([
      join(home, ".agents/skills/tray/SKILL.md"),
      join(home, ".claude/skills/tray/SKILL.md"),
    ]);
  });
});

describe("inputs parsed with the shared schemas", () => {
  test("--domain accepts URLs and uppercase; tray.sh stays tray.sh", async () => {
    const { done, calls } = run(
      ["list", "--domain", "https://TRAY.SH/"],
      { "GET /v1/sites": () => ({ data: [] }) },
      { TRAY_API_KEY: "tray_k_x" },
    );
    expect(await done).toBe(0);
    expect(calls[0]!.url).toBe("https://tray.tray.sh/v1/sites");
  });

  test("an invalid TRAY_DOMAIN is exit 2", async () => {
    const { done, calls } = run(["list", "--json"], {}, { TRAY_DOMAIN: "co.uk" });
    expect(await done).toBe(2);
    expect(calls.length).toBe(0);
    expect(JSON.parse(err[0]!).error).toStartWith("TRAY_DOMAIN:");
  });

  test("an invalid --domain is a usage error naming the flag", async () => {
    expect(await run(["list", "--json", "--domain", "localhost"]).done).toBe(2);
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "invalid_usage", param: "--domain" });
  });

  test("domain add normalizes the host", async () => {
    const { done, calls } = run(["domain", "add", "https://Docs.Acme.com/", "-s", "report"], {
      "POST /v1/domains": ({ body }) => ({
        host: body.host,
        site: body.site,
        createdAt: "2026-10-26T09:12:03Z",
      }),
    });
    expect(await done).toBe(0);
    expect(calls[0]!.body).toEqual({ host: "docs.acme.com", site: "report" });
  });

  test("domain add rejects a bare public suffix", async () => {
    expect(await run(["domain", "add", "co.uk", "-s", "report", "--json"]).done).toBe(2);
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "invalid_usage", param: "host" });
  });

  test("--to must be a deploy id", async () => {
    const { done, calls } = run(["rollback", "report", "--to", "../../keys/x"]);
    expect(await done).toBe(2);
    expect(calls.length).toBe(0);
  });
});

describe("--json output", () => {
  test("one compact line when piped", async () => {
    expect(await run(["list", "--json"], { "GET /v1/sites": () => ({ data: [] }) }).done).toBe(0);
    expect(out).toEqual(['{"sites":[]}']);
  });

  test("results indented on a terminal; errors always one line on stderr, stdout empty", async () => {
    expect(
      await run(["list", "--json"], { "GET /v1/sites": () => ({ data: [] }) }, {}, true).done,
    ).toBe(0);
    expect(out).toEqual(['{\n  "sites": []\n}']);
    expect(await run(["put", "--json"], {}, {}, true).done).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(err[0]!)).toMatchObject({ code: "invalid_usage", next: ["tray put --help"] });
  });

  test("deploys: the live one marked, a cursor when there's more; --debug logs each call", async () => {
    const d = (id: string) => ({
      id,
      files: 1,
      bytes: 1,
      spa: false,
      createdAt: "2026-10-26T09:12:03Z",
      createdBy: "sid@acme.com",
    });
    const routes = {
      "GET /v1/sites/report": () => siteBody({ currentDeploy: "mh7q2k1c-0002" }),
      "GET /v1/sites/report/deploys": () => ({
        data: [d("mh7q2k1c-0002"), d("mh7q2k1c-0001")],
        hasMore: true,
      }),
    };
    expect(await run(["deploys", "report", "--json", "--limit", "2"], routes).done).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.deploys.map((x: any) => x.current)).toEqual([true, false]);
    expect(json.next).toBe("mh7q2k1c-0001");
    out = [];
    const { done, calls } = run(
      ["deploys", "report", "--next", "mh7q2k1c-0001", "--debug"],
      routes,
    );
    expect(await done).toBe(0);
    expect(calls.at(-1)!.url).toContain("before=mh7q2k1c-0001");
    expect(out[0]).toStartWith("\tDEPLOY\tCREATED\tFILES\tBY\n*\tmh7q2k1c-0002");
    expect(err[0]).toMatch(/^GET https:\/\/tray\.acme\.dev\/v1\/sites\/report 200 \d+ms$/);
  });

  test("human tables: TSV with ISO times when piped; empty results go to stderr", async () => {
    const sites = { "GET /v1/sites": () => ({ data: [siteBody()] }) };
    expect(await run(["list"], sites).done).toBe(0);
    expect(out[0]).toBe(
      "SITE\tURL\tVISIBILITY\tDOMAINS\tUPDATED\nreport\thttps://report.acme.dev\tpublic\t\t2026-10-26T09:12:03Z",
    );
    out = [];
    expect(await run(["list"], { "GET /v1/sites": () => ({ data: [] }) }).done).toBe(0);
    expect(out).toEqual(["SITE\tURL\tVISIBILITY\tDOMAINS\tUPDATED"]); // just the header
    expect(err).toEqual(["No sites on acme.dev.\n    tray put <PATH>"]);
  });
});

describe("parsing", () => {
  test("usage errors: the first unknown token, a suggestion, and where to look (exit 2)", async () => {
    const cases: [string[], string][] = [
      [
        ["pt"],
        "Error: Unknown command pt for tray. Did you mean put?\n\nSee all commands:\n    tray --help",
      ],
      [
        ["put", "--prvate", "x"],
        "Error: Unknown option --prvate for tray put. Did you mean --private?",
      ],
      [["foo", "--json"], "Unknown command foo for tray."], // --json isn't reported too
      [["list", "extra"], "Unexpected argument extra for tray list."],
      [["put", "x", "-s", "Bad Name"], 'Invalid --site "Bad Name": invalid site name.'],
    ];
    expect(normalizeArgv(["key", "list", "--yes", "-y", "--json", "--json"])).toEqual([
      "key",
      "list",
      "--yes",
      "--json",
    ]);
    for (const [argv, message] of cases) {
      err = [];
      expect(await run(argv).done).toBe(2);
      expect(err.join("\n")).toContain(message);
    }
  });

  test("--help and --version exit 0 on stdout", async () => {
    expect(await run(["put", "--help"]).done).toBe(0);
    expect(out[0]).toContain("Usage:\n  tray put");
    expect(await run(["--version"]).done).toBe(0);
    expect(out[1]).toMatch(/^tray \d+\.\d+\.\d+/);
  });

  test("bare `tray`, a bare group, and `tray help <cmd>` print help on stdout (exit 0)", async () => {
    for (const argv of [[], ["key"], ["help", "put"]]) expect(await run(argv).done).toBe(0);
    expect(out[1]).toContain("tray key");
    expect(out[2]).toContain("Usage:\n  tray put");
    expect(await run(["--version", "--json"]).done).toBe(0);
    expect(JSON.parse(out[3]!)).toHaveProperty("version");
  });

  test("every help example parses", () => {
    for (const [path, examples] of Object.entries(EXAMPLES))
      for (const ex of examples) {
        const argv = ex
          .replace(/ < .*$/, "")
          .split(" ")
          .slice(1);
        const r = parse(app, { argv: rewriteAliases(argv) });
        expect({ ex, ok: r.ok, path: r.ok ? r.route : path }).toMatchObject({ ex, ok: true });
      }
  });

  test("after --, arguments are values: put -- -weird.html publishes the file", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "-weird.html"), "<p>");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { done, calls } = run(["put", "-s", "w", "--", "-weird.html"], {
        "GET /v1/sites/w": () => notFound(),
        "POST /v1/blobs/check": () => ({ missing: [] }),
        "POST /v1/sites/w/deploys": () => Response.json(deployBody("d1"), { status: 201 }),
      });
      expect(await done).toBe(0);
      expect(calls.some((c) => c.path === "/v1/sites/w/deploys")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
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
    ).toMatchObject({ json: true, nonInteractive: false, yes: true, domain: "b.app" });
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

  test("pollForKey keeps polling through network errors and 5xx", async () => {
    const replies = ["network", "503", "authorization_pending", "ok"];
    const fetchImpl = (async () => {
      const r = replies.shift()!;
      if (r === "network") throw new Error("ECONNRESET");
      if (r === "503") return new Response("upstream", { status: 503 });
      if (r === "ok") return Response.json({ key: "tray_k_x", email: "e", name: "n" });
      return Response.json({ error: r, code: r }, { status: 400 });
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: "https://tray.t.app", fetch: fetchImpl });
    const token = await pollForKey(api, "dc", 1, { sleep: async () => {} });
    expect(token.key).toBe("tray_k_x");
    expect(replies).toEqual([]);
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
    expect(() => keyIdFor(keys, "nope")).toThrow("No key named nope");
    try {
      keyIdFor(keys, "ci");
      throw new Error("expected ambiguity");
    } catch (e: any) {
      expect(e.code).toBe("ambiguous_key");
      expect(e.exit).toBe(2);
      expect(e.details.join(" ")).toContain("bbb");
      expect(e.details.join(" ")).toContain("ccc");
    }
    // A planted key named like another key's id can't redirect the revoke.
    const planted = [k("0123456789ab", "ci"), k("ddd", "0123456789ab")];
    expect(() => keyIdFor(planted, "0123456789ab")).toThrow("2 keys match 0123456789ab");
  });
});
