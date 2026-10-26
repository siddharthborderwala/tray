// Device-code login, end to end.
import { describe, expect, setSystemTime, test } from "bun:test";
import { accessJwt, APPROVE_AUD, OWNER, setup, SIGNIN_AUD } from "./helpers.ts";

async function start(api: Awaited<ReturnType<typeof setup>>["api"], name = "laptop") {
  const res = await api("/auth/device", {
    method: "POST",
    key: null,
    json: { name },
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }>;
}

const poll = (api: Awaited<ReturnType<typeof setup>>["api"], deviceCode: string) =>
  api("/auth/token", { method: "POST", key: null, json: { deviceCode } });

describe("device flow", () => {
  test("start → pending → approve via API key → token (single use) → key works", async () => {
    const { api, bucket } = await setup();
    const dc = await start(api);
    expect(dc.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(dc.verificationUri).toBe("https://tray.thts.app/approve");
    expect(dc.verificationUriComplete).toBe(`https://tray.thts.app/approve?code=${dc.userCode}`);
    expect(dc.expiresIn).toBe(600);
    expect(dc.interval).toBe(5);
    expect(await bucket.json(`auth/pending/${dc.deviceCode}.json`)).toMatchObject({
      userCode: dc.userCode,
      name: "laptop",
      ip: "203.0.113.7",
    });
    expect(await (await bucket.get(`auth/codes/${dc.userCode}`))!.text()).toBe(dc.deviceCode);

    let res = await poll(api, dc.deviceCode);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("authorization_pending");

    // Polling again immediately is too fast.
    res = await poll(api, dc.deviceCode);
    expect((await res.json()).code).toBe("slow_down");

    // `tray approve` looks it up first (lowercase, no dash works).
    res = await api(`/auth/device/${dc.userCode.replace("-", "").toLowerCase()}`);
    expect(res.status).toBe(200);
    const pending = await res.json();
    expect(pending).toEqual({ name: "laptop", ip: "203.0.113.7", expiresAt: pending.expiresAt });

    res = await api("/auth/approve", {
      method: "POST",
      json: { userCode: dc.userCode, approve: true },
    });
    expect(res.status).toBe(204);
    // Retry-safe
    expect(
      (await api("/auth/approve", { method: "POST", json: { userCode: dc.userCode } })).status,
    ).toBe(204);

    res = await poll(api, dc.deviceCode);
    expect(res.status).toBe(200);
    const token = await res.json();
    expect(token).toMatchObject({ email: OWNER, name: "laptop" });
    expect(token.key).toMatch(/^tray_k_/);

    // Single use: the code is gone.
    res = await poll(api, dc.deviceCode);
    expect((await res.json()).code).toBe("expired_token");
    expect(bucket.objects.has(`auth/codes/${dc.userCode}`)).toBe(false);

    // The key is bound to the approver's email and the device name.
    const keys = (await (await api("/keys", { key: token.key })).json()).data;
    expect(keys.find((k: { name: string }) => k.name === "laptop")).toMatchObject({ email: OWNER });
  });

  test("deny → access_denied", async () => {
    const { api } = await setup();
    const dc = await start(api);
    expect(
      (
        await api("/auth/approve", {
          method: "POST",
          json: { userCode: dc.userCode, approve: false },
        })
      ).status,
    ).toBe(204);
    const res = await poll(api, dc.deviceCode);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("access_denied");
    // Approving after a denial isn't allowed.
    expect(
      (await api("/auth/approve", { method: "POST", json: { userCode: dc.userCode } })).status,
    ).toBe(400);
  });

  test("codes expire after 10 minutes", async () => {
    const { api } = await setup();
    const dc = await start(api);
    try {
      setSystemTime(new Date(Date.now() + 601_000));
      let res = await api(`/auth/device/${dc.userCode}`);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("expired_token");
      res = await poll(api, dc.deviceCode);
      expect((await res.json()).code).toBe("expired_token");
    } finally {
      setSystemTime();
    }
  });

  test("unknown codes → expired_token; /auth/device/{code} and /auth/approve need auth", async () => {
    const { api } = await setup();
    expect((await (await poll(api, "f".repeat(64))).json()).code).toBe("expired_token");
    expect((await (await poll(api, "../keys")).json()).code).toBe("expired_token");
    expect((await api("/auth/device/BCDF-GHJK")).status).toBe(400);
    expect((await api("/auth/device/BCDF-GHJK", { key: null })).status).toBe(401);
    expect(
      (await api("/auth/approve", { method: "POST", key: null, json: { userCode: "BCDF-GHJK" } }))
        .status,
    ).toBe(401);
  });

  test("POST /auth/approve accepts the owner's Access identity", async () => {
    const { api } = await setup();
    const dc = await start(api);
    // An identity from the sign-in app (wrong aud) isn't enough.
    let res = await api("/auth/approve", {
      method: "POST",
      key: null,
      json: { userCode: dc.userCode },
      headers: { "cf-access-jwt-assertion": await accessJwt(OWNER, SIGNIN_AUD) },
    });
    expect(res.status).toBe(401);
    // Nor someone who isn't the owner.
    res = await api("/auth/approve", {
      method: "POST",
      key: null,
      json: { userCode: dc.userCode },
      headers: { "cf-access-jwt-assertion": await accessJwt("eve@acme.com", APPROVE_AUD) },
    });
    expect(res.status).toBe(401);

    res = await api("/auth/approve", {
      method: "POST",
      key: null,
      json: { userCode: dc.userCode },
      headers: { "cf-access-jwt-assertion": await accessJwt(OWNER, APPROVE_AUD) },
    });
    expect(res.status).toBe(204);
    expect((await poll(api, dc.deviceCode)).status).toBe(200);
  });
});

describe("/approve page", () => {
  test("needs the owner's Access identity", async () => {
    const { visit } = await setup();
    expect((await visit("https://tray.thts.app/approve")).status).toBe(403);
    const res = await visit("https://tray.thts.app/approve", {
      headers: { "cf-access-jwt-assertion": await accessJwt("eve@acme.com", APPROVE_AUD) },
    });
    expect(res.status).toBe(403);
  });

  test("shows the code form, then device details, then approves", async () => {
    const { api, visit } = await setup();
    const dc = await start(api, "build-box");
    const headers = { "cf-access-jwt-assertion": await accessJwt(OWNER, APPROVE_AUD) };

    let res = await visit("https://tray.thts.app/approve", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('name="code"');

    res = await visit(dc.verificationUriComplete, { headers });
    const html = await res.text();
    expect(html).toContain("build-box");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain(dc.userCode);
    expect(html).toContain("#FAF9F0");

    // Cross-site posts are refused.
    res = await visit("https://tray.thts.app/approve", {
      method: "POST",
      headers: {
        ...headers,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `code=${dc.userCode}&action=approve`,
    });
    expect(res.status).toBe(403);

    res = await visit("https://tray.thts.app/approve", {
      method: "POST",
      headers: {
        ...headers,
        origin: "https://tray.thts.app",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `code=${dc.userCode}&action=approve`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Approved");
    expect((await poll(api, dc.deviceCode)).status).toBe(200);

    // Code is used up now.
    res = await visit(dc.verificationUriComplete, { headers });
    expect(res.status).toBe(400);
  });

  test("deny from the page", async () => {
    const { api, visit } = await setup();
    const dc = await start(api);
    const res = await visit("https://tray.thts.app/approve", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessJwt(OWNER, APPROVE_AUD),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `code=${dc.userCode}&action=deny`,
    });
    expect(await res.text()).toContain("Denied");
    expect((await (await poll(api, dc.deviceCode)).json()).code).toBe("access_denied");
  });
});
