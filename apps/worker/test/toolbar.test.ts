// The toolbar on hosted pages: when it's added, what /.tray/me tells whom,
// and that everything else is served exactly as before.
import { describe, expect, test } from "bun:test";
import { bundleToolbar, generated, OUT } from "../scripts/toolbar.ts";
import { ME_PATH, TOOLBAR_JS, TOOLBAR_PATH } from "../src/toolbar.ts";
import { accessJwt, OWNER, setup, SIGNIN_AUD } from "./helpers.ts";

const cookie = async (email: string) => ({
  cookie: `__Host-tray_signin=${await accessJwt(email, SIGNIN_AUD)}`,
});
const TAG = `<script src="https://deck.acme.dev${TOOLBAR_PATH}" defer></script>`;
const PAGE = "<!doctype html><html><head><title>Deck</title></head><body><h1>Q3</h1></body></html>";
const WITH_TOOLBAR = PAGE.replace("</head>", TAG + "</head>");

async function site(visibility: "public" | "private" = "private") {
  const t = await setup();
  await t.deploy(
    "deck",
    {
      "/index.html": PAGE,
      "/app.js": "console.log('</head>')",
      "/style.css": "body{}",
      "/404.html": "<!doctype html><title>Gone</title><p>missing</p>",
      "/broken.html": "<!doctype html><!-- unclosed comment <p>",
      "/data.html": { body: "<p>x</p>", type: "text/html; charset=utf-16" },
    },
    { visibility },
  );
  await t.api("/sites/deck/shares", {
    method: "POST",
    json: { entries: ["bob@partner.io", "@acme.com"] },
  });
  return t;
}

describe("when the toolbar is added", () => {
  test("anonymous visit to a public site: byte-identical, nothing added", async () => {
    const { visit } = await site("public");
    const res = await visit("https://deck.acme.dev/");
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get("content-length")).toBe(String(PAGE.length));
    expect(res.headers.get("etag")).not.toContain("-");
  });

  test("signed-in visitors get it on HTML pages, with the right length and its own ETag", async () => {
    for (const visibility of ["public", "private"] as const) {
      const { visit } = await site(visibility);
      const res = await visit("https://deck.acme.dev/", { headers: await cookie(OWNER) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe(WITH_TOOLBAR);
      expect(res.headers.get("content-length")).toBe(
        String(new TextEncoder().encode(body).byteLength),
      );
      expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{64}-[0-9a-f]{8}"$/);
      expect(res.headers.get("cache-control")).toBeNull();
    }
  });

  test("also on the site's own 404.html, and on SPA-style 200s", async () => {
    const { visit } = await site();
    const res = await visit("https://deck.acme.dev/nope", { headers: await cookie(OWNER) });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(TAG);
  });

  test("never on JS, CSS, UTF-16 HTML, or a page it can't place safely", async () => {
    const { visit } = await site();
    const headers = await cookie(OWNER);
    expect(await (await visit("https://deck.acme.dev/app.js", { headers })).text()).toBe(
      "console.log('</head>')",
    );
    expect(await (await visit("https://deck.acme.dev/style.css", { headers })).text()).toBe(
      "body{}",
    );
    expect(await (await visit("https://deck.acme.dev/data.html", { headers })).text()).toBe(
      "<p>x</p>",
    );
    const broken = await visit("https://deck.acme.dev/broken.html", { headers });
    expect(await broken.text()).toBe("<!doctype html><!-- unclosed comment <p>");
    expect(broken.headers.get("content-length")).toBe("40");
  });

  test("an invalid or expired sign-in adds nothing", async () => {
    const { visit } = await site("public");
    const res = await visit("https://deck.acme.dev/", {
      headers: { cookie: "__Host-tray_signin=garbage" },
    });
    expect(await res.text()).toBe(PAGE);
  });

  test("the plain ETag doesn't match a signed-in page, so the toolbar appears after signing in", async () => {
    const { visit } = await site("public");
    const plain = (await visit("https://deck.acme.dev/")).headers.get("etag")!;
    const headers = await cookie(OWNER);
    const res = await visit("https://deck.acme.dev/", {
      headers: { ...headers, "if-none-match": plain },
    });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    const again = await visit("https://deck.acme.dev/", {
      headers: { ...headers, "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  test("HEAD: no content-length when the toolbar may be added", async () => {
    const { visit } = await site();
    const res = await visit("https://deck.acme.dev/", {
      method: "HEAD",
      headers: await cookie(OWNER),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    const js = await visit("https://deck.acme.dev/app.js", {
      method: "HEAD",
      headers: await cookie(OWNER),
    });
    expect(js.headers.get("content-length")).toBe("22");
  });
});

describe("/.tray/me", () => {
  test("the owner sees who has access", async () => {
    const { visit } = await site();
    const res = await visit(`https://deck.acme.dev${ME_PATH}`, { headers: await cookie(OWNER) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: OWNER,
      role: "owner",
      site: "deck",
      host: "deck.acme.dev",
      visibility: "private",
      owner: OWNER,
      sharedWith: ["bob@partner.io", "@acme.com"],
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a viewer sees only themselves and the owner, never the share list", async () => {
    const { visit } = await site();
    const res = await visit(`https://deck.acme.dev${ME_PATH}`, {
      headers: await cookie("Bob@Partner.io"),
    });
    const me = await res.json();
    expect(me).toEqual({
      email: "bob@partner.io",
      role: "viewer",
      site: "deck",
      host: "deck.acme.dev",
      visibility: "private",
      owner: OWNER,
    });
    expect(me).not.toHaveProperty("sharedWith");
  });

  test("not signed in, not shared, missing site, or a cross-site request: the same 404", async () => {
    const { visit } = await site();
    const snapshot = async (res: Response) => ({ status: res.status, body: await res.text() });
    const cases = [
      await visit(`https://deck.acme.dev${ME_PATH}`),
      await visit(`https://deck.acme.dev${ME_PATH}`, { headers: await cookie("eve@evil.io") }),
      await visit(`https://nope.acme.dev${ME_PATH}`, { headers: await cookie(OWNER) }),
      await visit(`https://deck.acme.dev${ME_PATH}`, {
        headers: { ...(await cookie(OWNER)), "sec-fetch-site": "same-site" },
      }),
    ];
    const shots = await Promise.all(cases.map(snapshot));
    expect(shots[0]).toEqual({ status: 404, body: '{"error":"not found"}' });
    for (const s of shots) expect(s).toEqual(shots[0]!);
  });

  test("a public site: signed-in visitors see themselves; the owner sees no list", async () => {
    const { visit } = await site("public");
    const res = await visit(`https://deck.acme.dev${ME_PATH}`, {
      headers: await cookie("eve@evil.io"),
    });
    expect((await res.json()).role).toBe("viewer");
    expect((await visit(`https://deck.acme.dev${ME_PATH}`)).status).toBe(404);
  });
});

describe("the script", () => {
  test("served at its versioned path as immutable JS, same-origin only", async () => {
    const { visit } = await site();
    const res = await visit(`https://deck.acme.dev${TOOLBAR_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(TOOLBAR_JS);
    expect((await visit("https://deck.acme.dev/.tray/toolbar-00000000.js")).status).toBe(404);
  });

  test("is valid JavaScript", () => {
    expect(() => new Function(TOOLBAR_JS)).not.toThrow();
  });

  test("the generated bundle is up to date with toolbar-client.ts", async () => {
    expect(await Bun.file(OUT).text()).toBe(generated(await bundleToolbar()));
  });
});

describe("favicon", () => {
  const ico = async (res: Response) => new Uint8Array(await res.arrayBuffer());
  test("artifacts without their own get Tray's, even under --spa or with a 404.html", async () => {
    const { deploy, visit } = await setup();
    await deploy("app", { "/index.html": "<p>app</p>", "/404.html": "gone" }, { spa: true });
    const res = await visit("https://app.acme.dev/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    const bytes = await ico(res);
    expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 1, 0]); // ICO header
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  test("their own favicon.ico wins", async () => {
    const { deploy, visit } = await setup();
    await deploy("app", { "/index.html": "x", "/favicon.ico": "MINE" });
    expect(await (await visit("https://app.acme.dev/favicon.ico")).text()).toBe("MINE");
  });

  test("missing, private and unshared sites all get the same default (nothing leaks)", async () => {
    const { deploy, visit } = await setup();
    await deploy(
      "secret",
      { "/index.html": "x", "/favicon.ico": "SECRET" },
      { visibility: "private" },
    );
    const a = await ico(await visit("https://secret.acme.dev/favicon.ico"));
    const b = await ico(await visit("https://nope.acme.dev/favicon.ico"));
    const c = await ico(
      await visit("https://secret.acme.dev/favicon.ico", { headers: await cookie("eve@evil.io") }),
    );
    expect(a).toEqual(b);
    expect(c).toEqual(b);
    const owner = await visit("https://secret.acme.dev/favicon.ico", {
      headers: await cookie(OWNER),
    });
    expect(await owner.text()).toBe("SECRET");
  });

  test("the API host has it too", async () => {
    const { visit } = await setup();
    const res = await visit("https://tray.acme.dev/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
  });
});
