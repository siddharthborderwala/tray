import { describe, expect, test } from "bun:test";
import { createAccessVerifier } from "../src/access.ts";
import { resolvePath, safeNext } from "../src/serve.ts";
import { accessJwt, APPROVE_AUD, certsFetch, OWNER, setup, SIGNIN_AUD } from "./helpers.ts";

const cookie = async (email: string, aud = SIGNIN_AUD) => ({
  cookie: `CF_Authorization=${await accessJwt(email, aud)}`,
});

describe("path resolution", () => {
  const entry = (hash: string) => ({ hash: hash.padEnd(64, "0"), size: 1, type: "text/html" });
  const files = {
    "/index.html": entry("1"),
    "/about.html": entry("2"),
    "/docs/index.html": entry("3"),
    "/app.js": entry("4"),
    "/404.html": entry("5"),
  };

  test("order: /x → /x.html → /x/ redirect → /x/index.html → SPA → /404.html → null", () => {
    expect(resolvePath(files, "/", false)).toEqual({ entry: files["/index.html"], status: 200 });
    expect(resolvePath(files, "/app.js", false)).toEqual({ entry: files["/app.js"], status: 200 });
    expect(resolvePath(files, "/about", false)).toEqual({
      entry: files["/about.html"],
      status: 200,
    });
    expect(resolvePath(files, "/docs", false)).toEqual({ redirect: "/docs/" });
    expect(resolvePath(files, "/docs/", false)).toEqual({
      entry: files["/docs/index.html"],
      status: 200,
    });
    expect(resolvePath(files, "/missing", false)).toEqual({
      entry: files["/404.html"],
      status: 404,
    });
    expect(resolvePath(files, "/missing", true)).toEqual({
      entry: files["/index.html"],
      status: 200,
    });
    const { "/404.html": _, ...no404 } = files;
    expect(resolvePath(no404, "/missing", false)).toBeNull();
    expect(resolvePath(no404, "/about/", false)).toBeNull();
  });

  test("safeNext only allows same-host relative paths", () => {
    expect(safeNext("/a/b?c=1#d")).toBe("/a/b?c=1#d");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/\tevil")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("/.tray/signin?next=/x")).toBe("/");
    // Dot segments that normalise to a protocol-relative `//host`.
    for (const n of [
      "/.//evil.com",
      "/..//evil.com",
      "/a/..//evil.com",
      "/%2e//evil.com",
      "/%2e%2e//evil.com",
    ])
      expect(safeNext(n)).toBe("/");
    expect(safeNext("/docs/../deck")).toBe("/deck");
  });
});

describe("serving public sites", () => {
  test("serves files with content type, etag, cache headers; 304 on If-None-Match", async () => {
    const { deploy, visit } = await setup();
    await deploy("report", {
      "/index.html": "<h1>home</h1>",
      "/style.css": { body: "body{}", type: "text/css;charset=utf-8" },
      "/docs/index.html": "docs",
    });

    let res = await visit("https://report.acme.dev/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/); // weak, so Cloudflare's edge keeps it
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("content-length")).toBe("13");

    res = await visit("https://report.acme.dev/", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    const strong = etag.slice(2);
    res = await visit("https://report.acme.dev/", { headers: { "if-none-match": strong } });
    expect(res.status).toBe(304);
    res = await visit("https://report.acme.dev/", {
      headers: { "if-none-match": `"other", ${etag}` },
    });
    expect(res.status).toBe(304);
    res = await visit("https://report.acme.dev/", { headers: { "if-none-match": '"other"' } });
    expect(res.status).toBe(200);

    res = await visit("https://report.acme.dev/style.css");
    expect(res.headers.get("content-type")).toBe("text/css;charset=utf-8");

    res = await visit("https://report.acme.dev/docs?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs/?x=1");

    res = await visit("https://report.acme.dev/docs/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("");

    res = await visit("https://report.acme.dev/", { method: "POST" });
    expect(res.status).toBe(405);
  });

  test("site 404.html, SPA fallback, Tray 404", async () => {
    const { deploy, visit } = await setup();
    await deploy("a", { "/index.html": "home", "/404.html": "custom 404" });
    await deploy("b", { "/index.html": "spa shell" }, { spa: true });
    await deploy("c", { "/index.html": "plain" });

    let res = await visit("https://a.acme.dev/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom 404");

    res = await visit("https://b.acme.dev/some/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("spa shell");

    res = await visit("https://c.acme.dev/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Sign in to view");
    expect(html).toContain('href="/.tray/signin?next=%2Fnope"');
  });

  test("custom domains resolve through hosts/<host>", async () => {
    const { api, deploy, visit } = await setup();
    await deploy("docs", { "/index.html": "the docs" });
    await api("/domains", { method: "POST", json: { host: "docs.acme.com", site: "docs" } });
    const res = await visit("https://docs.acme.com/");
    expect(await res.text()).toBe("the docs");
    expect((await visit("https://unknown.acme.com/")).status).toBe(404);
  });

  test("rollback changes what is served", async () => {
    const { api, deploy, visit } = await setup();
    const v1 = (await (await deploy("r", { "/index.html": "one" })).json()).deploy.id;
    await deploy("r", { "/index.html": "two" });
    expect(await (await visit("https://r.acme.dev/")).text()).toBe("two");
    await api("/sites/r/rollback", { method: "POST", json: { to: v1 } });
    expect(await (await visit("https://r.acme.dev/")).text()).toBe("one");
  });

  test("the API host is not a site", async () => {
    const { visit } = await setup();
    const res = await visit("https://tray.acme.dev/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This is the API for the tray on acme.dev");
    const missing = await visit("https://tray.acme.dev/index.html");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toStartWith("text/html");
  });
});

describe("private sites", () => {
  test("owner, exact email and @domain entries can view; others can't", async () => {
    const { api, deploy, visit } = await setup();
    await deploy("secret", { "/index.html": "classified" }, { visibility: "private" });
    await api("/sites/secret/shares", {
      method: "POST",
      json: { entries: ["bob@partner.io", "@acme.com"] },
    });

    for (const email of [OWNER, "bob@partner.io", "anyone@acme.com", "Bob@Partner.io"]) {
      const res = await visit("https://secret.acme.dev/", { headers: await cookie(email) });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("classified");
      expect(res.headers.get("cache-control")).toBeNull();
    }
    for (const email of ["eve@partner.io", "eve@acme.com.evil.io", "eve@notacme.com"]) {
      expect(
        (await visit("https://secret.acme.dev/", { headers: await cookie(email) })).status,
      ).toBe(404);
    }
  });

  test("after `tray setup --email` changes the owner, sites move to the new owner", async () => {
    // Sites were put by OWNER; the tray's owner is now someone else.
    const { deploy, visit } = await setup({ OWNER_EMAIL: "new@acme.io" });
    await deploy("secret", { "/index.html": "classified" }, { visibility: "private" });
    const as = async (email: string) =>
      (await visit("https://secret.acme.dev/", { headers: await cookie(email) })).status;
    expect(await as("new@acme.io")).toBe(200);
    expect(await as(OWNER)).toBe(404);
  });

  test("tokens with the wrong aud, wrong issuer, or expired are ignored", async () => {
    const { deploy, visit } = await setup();
    await deploy("secret", { "/index.html": "classified" }, { visibility: "private" });
    const bad = [
      await accessJwt(OWNER, APPROVE_AUD),
      await accessJwt(OWNER, SIGNIN_AUD, { iss: "https://evil.cloudflareaccess.com" }),
      await accessJwt(OWNER, SIGNIN_AUD, { exp: Math.floor(Date.now() / 1000) - 10 }),
      "garbage",
    ];
    for (const token of bad) {
      const res = await visit("https://secret.acme.dev/", {
        headers: { cookie: `CF_Authorization=${token}` },
      });
      expect(res.status).toBe(404);
    }
  });

  test("missing site, private without sign-in, signed in but not shared: byte-identical 404s", async () => {
    const { deploy, visit } = await setup();
    await deploy("secret", { "/index.html": "classified" }, { visibility: "private" });

    const snapshot = async (res: Response) => ({
      status: res.status,
      headers: [...res.headers.entries()].sort(),
      body: await res.text(),
    });

    // Not signed in: missing site vs private site.
    const missing = await snapshot(await visit("https://ghost.acme.dev/page"));
    const unsigned = await snapshot(await visit("https://secret.acme.dev/page"));
    expect(unsigned).toEqual(missing);
    expect(missing.status).toBe(404);
    expect(Object.fromEntries(missing.headers)["cache-control"]).toBeUndefined();
    expect(missing.body).toContain("Sign in to view");
    expect(Object.fromEntries(missing.headers)["x-frame-options"]).toBe("DENY");
    expect(missing.body).not.toContain("Signed in as");

    // Signed in as someone not on the list: missing site vs private site.
    const eve = await cookie("eve@elsewhere.org");
    const missingSigned = await snapshot(
      await visit("https://ghost.acme.dev/page", { headers: eve }),
    );
    const notShared = await snapshot(await visit("https://secret.acme.dev/page", { headers: eve }));
    expect(notShared).toEqual(missingSigned);
    expect(missingSigned.body).toContain("Signed in as eve@elsewhere.org");
    expect(missingSigned.body).toContain('href="/cdn-cgi/access/logout"');

    // A private custom host behaves the same as an unmapped one.
    expect(await snapshot(await visit("https://nothing.acme.com/page"))).toEqual(missing);
  });

  test("the same lookups happen for missing and private sites", async () => {
    const { deploy, visit, bucket } = await setup();
    await deploy("secret", { "/index.html": "classified" }, { visibility: "private" });
    const count = async (url: string) => {
      bucket.calls = { head: 0, get: 0, put: 0, list: 0, delete: 0 };
      await visit(url, { headers: await cookie("eve@elsewhere.org") });
      return { ...bucket.calls };
    };
    expect(await count("https://secret.acme.dev/")).toEqual(await count("https://ghost.acme.dev/"));
  });

  test("/.tray/signin verifies Access and redirects to next on the same host", async () => {
    const { visit } = await setup();
    const headers = { "cf-access-jwt-assertion": await accessJwt("bob@acme.com", SIGNIN_AUD) };
    let res = await visit("https://secret.acme.dev/.tray/signin?next=%2Fdeck%3Fp%3D2", { headers });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/deck?p=2");

    res = await visit("https://secret.acme.dev/.tray/signin?next=https://evil.example", {
      headers,
    });
    expect(res.headers.get("location")).toBe("/");

    res = await visit("https://secret.acme.dev/.tray/signin?next=/.//evil.example", { headers });
    expect(res.headers.get("location")).toBe("/");

    res = await visit("https://secret.acme.dev/.tray/signin?next=/x");
    expect(res.status).toBe(403);
  });

  test("public sites ignore Access entirely", async () => {
    const { deploy, visit } = await setup();
    await deploy("open", { "/index.html": "hello" });
    const res = await visit("https://open.acme.dev/", {
      headers: { cookie: "CF_Authorization=garbage" },
    });
    expect(res.status).toBe(200);
  });
});

describe("Access certs", () => {
  test("tokens with an unknown kid don't refetch the certs on every request", async () => {
    let fetches = 0;
    const verify = createAccessVerifier(async (input) => {
      fetches++;
      return certsFetch(input);
    });
    const opts = { teamDomain: "acme", aud: SIGNIN_AUD };
    expect(await verify(await accessJwt(OWNER, SIGNIN_AUD), opts)).toEqual({ email: OWNER });
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "rotated?" }));
    const forged = `${header.replace(/=+$/, "")}.e30.c2ln`;
    for (let i = 0; i < 5; i++) expect(await verify(forged, opts)).toBeNull();
    expect(fetches).toBe(1);
  });
});
