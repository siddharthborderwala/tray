// Shares, domains, keys.
import { describe, expect, test } from "bun:test";
import { setup } from "./helpers.ts";

describe("shares", () => {
  test("public site → 409 site_public", async () => {
    const { api, deploy } = await setup();
    await deploy("report", { "/index.html": "a" });
    for (const res of [
      await api("/sites/report/shares"),
      await api("/sites/report/shares", { method: "POST", json: { entries: ["bob@acme.com"] } }),
      await api("/sites/report/shares/bob@acme.com", { method: "DELETE" }),
    ]) {
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("site_public");
      expect(body.hint).toBe("Make it private first: tray edit report --visibility private");
    }
  });

  test("add, list (owner first), dedupe, remove; owner can't be removed", async () => {
    const { api, deploy } = await setup();
    await deploy("report", { "/index.html": "a" }, { visibility: "private" });

    let res = await api("/sites/report/shares");
    expect(await res.json()).toEqual({ data: [{ entry: "sid@acme.com", owner: true }] });

    res = await api("/sites/report/shares", {
      method: "POST",
      json: { entries: ["Bob@Acme.com", "@acme.com", "bob@acme.com", "sid@acme.com"] },
    });
    expect(res.status).toBe(200);
    const expected = {
      data: [
        { entry: "sid@acme.com", owner: true },
        { entry: "bob@acme.com", owner: false },
        { entry: "@acme.com", owner: false },
      ],
    };
    expect(await res.json()).toEqual(expected);

    // Adding again is a no-op.
    res = await api("/sites/report/shares", {
      method: "POST",
      json: { entries: ["bob@acme.com"] },
    });
    expect(await res.json()).toEqual(expected);

    expect((await (await api("/sites/report")).json()).shareCount).toBe(3);

    res = await api("/sites/report/shares/sid@acme.com", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("entry");

    res = await api(`/sites/report/shares/${encodeURIComponent("@acme.com")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    res = await api(`/sites/report/shares/${encodeURIComponent("@acme.com")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect((await (await api("/sites/report/shares")).json()).data).toHaveLength(2);

    res = await api("/sites/report/shares", {
      method: "POST",
      json: { entries: ["not an email"] },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("entries.0");
  });

  test("share list survives public → private", async () => {
    const { api, deploy } = await setup();
    await deploy("report", { "/index.html": "a" }, { visibility: "private" });
    await api("/sites/report/shares", { method: "POST", json: { entries: ["bob@acme.com"] } });
    await api("/sites/report", { method: "PATCH", json: { visibility: "public" } });
    await api("/sites/report", { method: "PATCH", json: { visibility: "private" } });
    expect((await (await api("/sites/report/shares")).json()).data).toHaveLength(2);
  });
});

describe("domains", () => {
  test("add (201), repeat (200), conflicting (409), list, remove", async () => {
    const { api, deploy, cf, bucket } = await setup();
    await deploy("docs", { "/index.html": "d" });
    await deploy("blog", { "/index.html": "b" });

    let res = await api("/domains", {
      method: "POST",
      json: { host: "Docs.Acme.com", site: "docs" },
    });
    expect(res.status).toBe(201);
    const domain = await res.json();
    expect(domain).toMatchObject({ host: "docs.acme.com", site: "docs" });
    expect(cf.calls).toEqual(["attach docs.acme.com", "signin+ docs.acme.com"]);
    expect(bucket.objects.has("hosts/docs.acme.com")).toBe(true);
    expect((await (await api("/sites/docs")).json()).domains).toEqual(["docs.acme.com"]);

    res = await api("/domains", { method: "POST", json: { host: "docs.acme.com", site: "docs" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(domain);
    expect(cf.calls).toHaveLength(2);

    res = await api("/domains", { method: "POST", json: { host: "docs.acme.com", site: "blog" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "domain_taken", param: "host" });

    await api("/domains", { method: "POST", json: { host: "blog.acme.com", site: "blog" } });
    expect(
      (await (await api("/domains")).json()).data.map((d: { host: string }) => d.host),
    ).toEqual(["blog.acme.com", "docs.acme.com"]);
    expect((await (await api("/domains?site=docs")).json()).data).toEqual([domain]);

    res = await api("/domains/docs.acme.com", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(cf.calls.slice(-2)).toEqual(["detach docs.acme.com", "signin- docs.acme.com"]);
    expect(bucket.objects.has("hosts/docs.acme.com")).toBe(false);
    expect((await (await api("/sites/docs")).json()).domains).toEqual([]);

    res = await api("/domains/docs.acme.com", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("domain_not_found");
  });

  test("zone not in account → 422; unknown site → 404; tray subdomain → 400", async () => {
    const { api, deploy, bucket } = await setup();
    await deploy("docs", { "/index.html": "d" });

    let res = await api("/domains", {
      method: "POST",
      json: { host: "docs.elsewhere.org", site: "docs" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("zone_not_in_account");
    expect(bucket.objects.has("hosts/docs.elsewhere.org")).toBe(false);

    res = await api("/domains", { method: "POST", json: { host: "x.acme.com", site: "ghost" } });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("site_not_found");

    res = await api("/domains", { method: "POST", json: { host: "docs.thts.app", site: "docs" } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("host");

    res = await api("/domains", { method: "POST", json: { host: "not a host", site: "docs" } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("host");
  });
});

describe("keys", () => {
  test("create (shown once), list, revoke by id, revoke current", async () => {
    const { api } = await setup();
    let res = await api("/keys", { method: "POST", json: { name: "ci" } });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.key).toMatch(/^tray_k_[a-f0-9]{48}$/);
    expect(created.id).toMatch(/^[a-f0-9]{12}$/);
    expect(created.name).toBe("ci");

    res = await api("/keys");
    const list = (await res.json()).data;
    expect(list.map((k: { name: string }) => k.name).sort()).toEqual(["ci", "test-machine"]);
    const ci = list.find((k: { name: string }) => k.name === "ci");
    expect(ci).toEqual({
      id: created.id,
      name: "ci",
      email: "sid@acme.com",
      createdAt: ci.createdAt,
      lastUsedAt: null,
    });
    expect(JSON.stringify(list)).not.toContain("tray_k_");
    expect(JSON.stringify(list)).not.toContain("hash");

    // The new key works…
    expect((await api("/sites", { key: created.key })).status).toBe(200);
    // …and logs itself out.
    expect((await api("/keys/current", { method: "DELETE", key: created.key })).status).toBe(204);
    expect((await api("/sites", { key: created.key })).status).toBe(401);

    const other = await (await api("/keys", { method: "POST", json: { name: "tmp" } })).json();
    expect((await api(`/keys/${other.id}`, { method: "DELETE" })).status).toBe(204);
    res = await api(`/keys/${other.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("key_not_found");
    expect((await api("/keys/zzz", { method: "DELETE" })).status).toBe(400);
  });

  test("empty name → 400", async () => {
    const { api } = await setup();
    const res = await api("/keys", { method: "POST", json: { name: "  " } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("name");
  });
});
