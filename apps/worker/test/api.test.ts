import { describe, expect, test } from "bun:test";
import { MAX_DEPLOY_BYTES } from "@tray-sh/schema";
import { newDeployId } from "../src/routes/sites.ts";
import { sha256, setup } from "./helpers.ts";

describe("auth", () => {
  test("missing key → 401 unauthenticated with hint", async () => {
    const { api } = await setup();
    const res = await api("/sites", { key: null });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ code: "unauthenticated", error: "missing API key" });
    expect(body.hint).toContain("tray login thts.app");
  });

  test("wrong key, malformed key and revoked key are rejected", async () => {
    const { api, bucket, key } = await setup();
    expect((await api("/sites", { key: "tray_k_" + "0".repeat(48) })).status).toBe(401);
    expect((await api("/sites", { key: "nope" })).status).toBe(401);

    // Same id prefix, different full hash: the stored hash comparison catches it.
    const id = (await sha256(key)).slice(0, 12);
    const record = (await bucket.json<{ hash: string }>(`keys/${id}.json`))!;
    await bucket.put(`keys/${id}.json`, JSON.stringify({ ...record, hash: "f".repeat(64) }));
    expect((await api("/sites")).status).toBe(401);
  });

  test("valid key works and records lastUsedAt", async () => {
    const { api, bucket, key } = await setup();
    const res = await api("/sites");
    expect(res.status).toBe(200);
    const id = (await sha256(key)).slice(0, 12);
    expect(
      (await bucket.json<{ lastUsedAt: string | null }>(`keys/${id}.json`))!.lastUsedAt,
    ).not.toBeNull();
  });

  test("the TRAY_SETUP_KEY secret is accepted once, then lives in R2; revoking it sticks", async () => {
    const setupKey = "tray_k_" + "a".repeat(48);
    const hash = await sha256(setupKey);
    const record = {
      id: hash.slice(0, 12),
      hash,
      name: "mbp",
      email: "sid@acme.com",
      createdAt: "2026-10-26T00:00:00Z",
      lastUsedAt: null,
    };
    const { api, bucket } = await setup({ TRAY_SETUP_KEY: JSON.stringify(record) });

    expect((await api("/keys", { key: setupKey })).status).toBe(200);
    expect(await bucket.json(`keys/${record.id}.json`)).toMatchObject({
      id: record.id,
      name: "mbp",
    });

    // A key with the same id prefix but a different secret is still refused.
    expect((await api("/sites", { key: "tray_k_" + "b".repeat(48) })).status).toBe(401);

    expect((await api("/keys/current", { method: "DELETE", key: setupKey })).status).toBe(204);
    expect((await api("/sites", { key: setupKey })).status).toBe(401);
  });

  test("every response carries tray-version", async () => {
    const { api, visit } = await setup();
    expect((await api("/sites")).headers.get("tray-version")).toMatch(/^\d+\.\d+\.\d+/);
    expect((await api("/sites", { key: null })).headers.get("tray-version")).toMatch(
      /^\d+\.\d+\.\d+/,
    );
    expect((await visit("https://nope.thts.app/")).headers.get("tray-version")).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });
});

describe("errors", () => {
  test("validation failures → 400 invalid_request with param", async () => {
    const { api } = await setup();
    let res = await api("/sites/Bad_Name");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request", param: "site" });

    res = await api("/sites/tray");
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("site");

    res = await api("/blobs/check", { method: "POST", json: { hashes: ["xyz"] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request", param: "hashes.0" });

    res = await api("/sites/a/deploys", { method: "POST", json: { files: {}, spa: false } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("source");
  });

  test("malformed JSON → 400 invalid_request", async () => {
    const { api } = await setup();
    const res = await api("/blobs/check", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  test("unknown routes → 404 json", async () => {
    const { api } = await setup();
    const res = await api("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("site_not_found", async () => {
    const { api } = await setup();
    const res = await api("/sites/ghost");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "site_not_found",
      param: "site",
      error: "site ghost not found",
    });
  });
});

describe("blobs", () => {
  test("PUT stores a new blob (201), then 200 for an existing one", async () => {
    const { api, bucket } = await setup();
    const body = "hello world";
    const hash = await sha256(body);
    const put = () =>
      api(`/blobs/${hash}`, {
        method: "PUT",
        body,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        },
      });
    let res = await put();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ hash, size: 11 });
    expect(bucket.objects.has(`blobs/${hash}`)).toBe(true);

    res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash, size: 11 });
  });

  test("digest mismatch → 400 digest_mismatch, nothing stored", async () => {
    const { api, bucket } = await setup();
    const hash = await sha256("expected");
    const res = await api(`/blobs/${hash}`, {
      method: "PUT",
      body: "different",
      headers: { "content-length": "9" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "digest_mismatch", param: "sha256" });
    expect(bucket.objects.has(`blobs/${hash}`)).toBe(false);
  });

  test("411 without content-length, 413 over 50 MB", async () => {
    const { app, env, key } = await setup();
    const hash = await sha256("x");
    // A streamed body with no length.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x"));
        c.close();
      },
    });
    let res = await app.request(
      `https://tray.thts.app/v1/blobs/${hash}`,
      {
        method: "PUT",
        body: stream,
        headers: { authorization: `Bearer ${key}` },
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(res.status).toBe(411);
    expect(((await res.json()) as { code: string }).code).toBe("length_required");

    res = await app.request(
      `https://tray.thts.app/v1/blobs/${hash}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${key}`, "content-length": String(MAX_DEPLOY_BYTES + 1) },
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too_large");
  });

  test("bad hash in path → 400", async () => {
    const { api } = await setup();
    const res = await api(`/blobs/NOTAHASH`, {
      method: "PUT",
      body: "x",
      headers: { "content-length": "1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("sha256");
  });

  test("check returns missing hashes, deduped; max 512", async () => {
    const { api, upload } = await setup();
    const manifest = await upload({ "/a": "a" });
    const present = manifest["/a"]!.hash;
    const absent = await sha256("nope");
    let res = await api("/blobs/check", {
      method: "POST",
      json: { hashes: [present, absent, absent] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ missing: [absent] });

    const many = Array.from({ length: 513 }, (_, i) => i.toString(16).padStart(64, "0"));
    res = await api("/blobs/check", { method: "POST", json: { hashes: many } });
    expect(res.status).toBe(400);
    res = await api("/blobs/check", { method: "POST", json: { hashes: many.slice(0, 512) } });
    expect(res.status).toBe(200);
    expect((await res.json()).missing).toHaveLength(512);
  });
});

describe("deploys", () => {
  test("first deploy creates the site (201) with Site + Deploy", async () => {
    const { deploy } = await setup();
    const res = await deploy("report", { "/index.html": "<h1>hi</h1>" }, { visibility: "private" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.site).toMatchObject({
      name: "report",
      url: "https://report.thts.app",
      visibility: "private",
      domains: [],
      shareCount: 1,
    });
    expect(body.site.currentDeploy).toBe(body.deploy.id);
    expect(body.deploy).toMatchObject({
      files: 1,
      bytes: 11,
      spa: false,
      createdBy: "sid@acme.com",
    });
    expect(body.deploy.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  test("same manifest → 200 with the existing deploy (idempotent)", async () => {
    const { deploy, bucket } = await setup();
    const first = await (await deploy("report", { "/index.html": "a" })).json();
    const res = await deploy("report", { "/index.html": "a" });
    expect(res.status).toBe(200);
    const again = await res.json();
    expect(again.deploy.id).toBe(first.deploy.id);
    expect(
      [...bucket.objects.keys()].filter((k) => k.startsWith("sites/report/deploys/")),
    ).toHaveLength(1);

    // spa change is a new deploy
    const spa = await deploy("report", { "/index.html": "a" }, { spa: true });
    expect(spa.status).toBe(201);
  });

  test("site_exists for a different source unless replace", async () => {
    const { deploy } = await setup();
    await deploy("report", { "/index.html": "a" });
    let res = await deploy(
      "report",
      { "/index.html": "b" },
      { source: { path: "/elsewhere", machine: "pc" } },
    );
    expect(res.status).toBe(409);
    const err = await res.json();
    expect(err).toMatchObject({ code: "site_exists", param: "site" });
    expect(err.error).toBe("report already exists (last put from /work/report on mbp)");
    expect(err.hint).toContain("replace");

    // Same manifest from elsewhere is still a conflict.
    res = await deploy(
      "report",
      { "/index.html": "a" },
      { source: { path: "/elsewhere", machine: "pc" } },
    );
    expect(res.status).toBe(409);

    res = await deploy(
      "report",
      { "/index.html": "b" },
      { source: { path: "/elsewhere", machine: "pc" }, replace: true, visibility: "private" },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).site.visibility).toBe("private");

    // The new source owns it now.
    res = await deploy(
      "report",
      { "/index.html": "c" },
      { source: { path: "/elsewhere", machine: "pc" } },
    );
    expect(res.status).toBe(201);
  });

  test("visibility only applies on create or replace", async () => {
    const { deploy } = await setup();
    await deploy("report", { "/index.html": "a" });
    const res = await deploy("report", { "/index.html": "b" }, { visibility: "private" });
    expect((await res.json()).site.visibility).toBe("public");
  });

  test("missing_blobs lists blobs not uploaded and not in the current deploy", async () => {
    const { api, deploy, upload } = await setup();
    await deploy("report", { "/index.html": "a" });
    const kept = await upload({ "/index.html": "a" });
    const ghost = await sha256("never uploaded");
    const res = await api("/sites/report/deploys", {
      method: "POST",
      json: {
        files: { ...kept, "/x.js": { hash: ghost, size: 3, type: "text/javascript" } },
        spa: false,
        source: { path: "/work/report", machine: "mbp" },
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "missing_blobs", missing: [ghost] });
  });

  test("blobs already in the current deploy aren't re-checked", async () => {
    const { deploy, bucket } = await setup();
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/f${i}`, `file ${i}`]));
    await deploy("big", files);
    bucket.calls.head = 0;
    await deploy("big", { ...files, "/new": "new" });
    expect(bucket.calls.head).toBe(1);
  });

  test("50 MB total → 413 too_large", async () => {
    const { api } = await setup();
    const hash = await sha256("x");
    const res = await api("/sites/huge/deploys", {
      method: "POST",
      json: {
        files: {
          "/a": { hash, size: MAX_DEPLOY_BYTES, type: "x" },
          "/b": { hash, size: 1, type: "x" },
        },
        spa: false,
        source: { path: "/p", machine: "m" },
      },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("too_large");
  });

  test("deploy ids sort by time", () => {
    const a = newDeployId(Date.UTC(2026, 0, 1));
    const b = newDeployId(Date.UTC(2026, 0, 1, 0, 0, 1));
    const c = newDeployId(Date.UTC(2030, 5, 1));
    expect([c, a, b].sort()).toEqual([a, b, c]);
    expect(a).toMatch(/^[a-z0-9]{8}-[a-f0-9]{4}$/);
  });

  test("listing is newest first and paginates with limit/before", async () => {
    const { api, deploy } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await (await deploy("report", { "/index.html": `v${i}` })).json()).deploy.id);
      await Bun.sleep(2);
    }
    const newest = [...ids].reverse();

    let res = await api("/sites/report/deploys?limit=2");
    let page = await res.json();
    expect(page.data.map((d: { id: string }) => d.id)).toEqual(newest.slice(0, 2));
    expect(page.hasMore).toBe(true);
    expect(page.data[0]).toMatchObject({
      files: 1,
      bytes: 2,
      spa: false,
      createdBy: "sid@acme.com",
    });

    res = await api(`/sites/report/deploys?limit=2&before=${newest[1]}`);
    page = await res.json();
    expect(page.data.map((d: { id: string }) => d.id)).toEqual(newest.slice(2, 4));
    expect(page.hasMore).toBe(true);

    res = await api(`/sites/report/deploys?limit=2&before=${newest[3]}`);
    page = await res.json();
    expect(page.data.map((d: { id: string }) => d.id)).toEqual(newest.slice(4));
    expect(page.hasMore).toBe(false);

    // default limit 20
    page = await (await api("/sites/report/deploys")).json();
    expect(page.data).toHaveLength(5);

    expect((await api("/sites/report/deploys?limit=0")).status).toBe(400);
    expect((await api("/sites/report/deploys?limit=101")).status).toBe(400);
    expect((await api("/sites/ghost/deploys")).status).toBe(404);
  });
});

describe("rollback", () => {
  test("requires to; points current at it; deploy_not_found otherwise", async () => {
    const { api, deploy, visit } = await setup();
    const v1 = (await (await deploy("report", { "/index.html": "v1" })).json()).deploy.id;
    await deploy("report", { "/index.html": "v2" });

    let res = await api("/sites/report/rollback", { method: "POST", json: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("to");

    res = await api("/sites/report/rollback", { method: "POST", json: { to: "nope-0000" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "deploy_not_found", param: "to" });

    res = await api("/sites/report/rollback", { method: "POST", json: { to: "../../keys/x" } });
    expect(res.status).toBe(404);

    res = await api("/sites/report/rollback", { method: "POST", json: { to: v1 } });
    expect(res.status).toBe(200);
    expect((await res.json()).currentDeploy).toBe(v1);
    expect(await (await visit("https://report.thts.app/")).text()).toBe("v1");

    // retry-safe
    res = await api("/sites/report/rollback", { method: "POST", json: { to: v1 } });
    expect(res.status).toBe(200);
  });
});

describe("sites", () => {
  test("list, get, patch visibility, delete", async () => {
    const { api, deploy, bucket } = await setup();
    await deploy("alpha", { "/index.html": "a" });
    await Bun.sleep(2);
    await deploy("beta", { "/index.html": "b" }, { visibility: "private" });

    let res = await api("/sites");
    const list = await res.json();
    expect(list.data.map((s: { name: string }) => s.name)).toEqual(["beta", "alpha"]);

    res = await api("/sites/alpha", { method: "PATCH", json: { visibility: "private" } });
    expect(res.status).toBe(200);
    expect((await res.json()).visibility).toBe("private");
    expect((await (await api("/sites/alpha")).json()).visibility).toBe("private");

    res = await api("/sites/alpha", { method: "PATCH", json: { visibility: "secret" } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("visibility");

    res = await api("/sites/alpha", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect([...bucket.objects.keys()].some((k) => k.startsWith("sites/alpha/"))).toBe(false);
    expect((await api("/sites/alpha")).status).toBe(404);
    expect((await api("/sites/alpha", { method: "DELETE" })).status).toBe(404);
  });

  test("delete also removes its custom domains", async () => {
    const { api, deploy, cf, bucket } = await setup();
    await deploy("docs", { "/index.html": "d" });
    await api("/domains", { method: "POST", json: { host: "docs.acme.com", site: "docs" } });
    expect((await api("/sites/docs")).status).toBe(200);
    await api("/sites/docs", { method: "DELETE" });
    expect(cf.calls).toContain("detach docs.acme.com");
    expect(cf.calls).toContain("signin- docs.acme.com");
    expect(bucket.objects.has("hosts/docs.acme.com")).toBe(false);
  });
});
