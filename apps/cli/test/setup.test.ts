// `tray setup` against a stateful fake of the Cloudflare API. No real calls.
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setup } from "../src/commands/setup.ts";
import { loadAccounts } from "../src/config.ts";
import type { Ctx } from "../src/ctx.ts";
import { TrayError } from "../src/errors.ts";
import { main } from "../src/main.ts";
import { loadSetups, resourceName } from "../src/setup/state.ts";
import { memoryKeyStore, tmp } from "./helpers.ts";

const ACCOUNT = "acct123";
const ZONE = "zone123";

interface Call {
  method: string;
  path: string;
  body: any;
}

/** In-memory Cloudflare: zones, Zero Trust, R2, IdPs, policies, apps, scripts, domains, routes, DNS. */
function fakeCloudflare(opts: { zeroTrust?: boolean; zones?: string[]; token?: string } = {}) {
  const state = {
    buckets: new Set<string>(),
    idps: [] as { id: string; type: string; name: string }[],
    policies: [] as { id: string; name: string; decision: string; include: unknown[] }[],
    apps: [] as any[],
    scripts: new Map<string, { metadata: any; source: string }>(),
    customDomains: new Map<string, { hostname: string; service: string; zone_id: string }>(),
    routes: [] as { id: string; pattern: string; script: string }[],
    dns: [] as { id: string; name: string; type: string; content: string; proxied: boolean }[],
    trayKeys: new Set<string>(),
  };
  const calls: Call[] = [];
  let zeroTrustOff = opts.zeroTrust === false;
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const ok = (result: unknown, info?: unknown) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(info ? { result_info: info } : {}),
    });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    // The new tray's API (setup's liveness check / key claim).
    if (url.host === "tray.acme.dev") {
      const key = headers.get("authorization")?.replace("Bearer ", "") ?? "";
      if (method === "GET" && url.pathname === "/v1/keys") {
        const setupKey = JSON.parse(
          state.scripts
            .get(resourceName("acme.dev"))
            ?.metadata.bindings.find((b: any) => b.name === "TRAY_SETUP_KEY")?.text ?? "{}",
        );
        const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
        if (hash === setupKey.hash || state.trayKeys.has(key)) {
          state.trayKeys.add(key);
          return Response.json({ data: [] });
        }
        return Response.json({ error: "no", code: "unauthenticated" }, { status: 401 });
      }
      if (method === "DELETE" && url.pathname === "/v1/keys/current") {
        state.trayKeys.delete(key);
        return new Response(null, { status: 204 });
      }
    }

    let body: any = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (body instanceof FormData) {
      const meta = JSON.parse(await (body.get("metadata") as Blob).text());
      const file = body.get(meta.main_module) as File | null;
      body = { metadata: meta, source: file ? await file.text() : null, moduleType: file?.type };
    }
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path: path + url.search, body });
    if (headers.get("authorization") !== `Bearer ${opts.token ?? "cf_token"}`)
      return fail(403, 10000, "Authentication error");

    const a = `/accounts/${ACCOUNT}`;
    const route = `${method} ${path}`;
    if (route === "GET /zones") {
      const name = url.searchParams.get("name");
      const zones = (opts.zones ?? ["acme.dev"])
        .filter((z) => z === name)
        .map((z) => ({ id: ZONE, name: z, account: { id: ACCOUNT, name: "Sid" } }));
      return ok(zones, { page: 1, total_pages: 1 });
    }
    if (route === `GET ${a}/access/organizations`) {
      return zeroTrustOff
        ? fail(404, 9999, "access.api.error.not_enabled")
        : ok({ auth_domain: "acme.cloudflareaccess.com", name: "acme" });
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(new RegExp(`^${a}/r2/buckets/([^/]+)$`))) && method === "GET") {
      return state.buckets.has(m[1]!)
        ? ok({ name: m[1] })
        : fail(404, 10006, "The specified bucket does not exist.");
    }
    if (route === `POST ${a}/r2/buckets`) {
      state.buckets.add(body.name);
      return ok({ name: body.name });
    }
    if (route === `GET ${a}/access/identity_providers`) return ok(state.idps, { total_pages: 1 });
    if (route === `POST ${a}/access/identity_providers`) {
      const idp = { id: id("idp"), ...body };
      state.idps.push(idp);
      return ok(idp);
    }
    if (route === `GET ${a}/access/policies`) return ok(state.policies, { total_pages: 1 });
    if (route === `POST ${a}/access/policies`) {
      const policy = { id: id("pol"), ...body };
      state.policies.push(policy);
      return ok(policy);
    }
    if ((m = path.match(new RegExp(`^${a}/access/policies/([^/]+)$`))) && method === "PUT") {
      const policy = state.policies.find((p) => p.id === m![1])!;
      Object.assign(policy, body);
      return ok(policy);
    }
    if (route === `GET ${a}/access/apps`) return ok(state.apps, { total_pages: 1 });
    if (route === `POST ${a}/access/apps`) {
      const app = { id: id("app"), aud: id("aud"), ...body };
      state.apps.push(app);
      return ok(app);
    }
    if ((m = path.match(new RegExp(`^${a}/access/apps/([^/]+)$`))) && method === "PUT") {
      const app = state.apps.find((x) => x.id === m![1]);
      Object.assign(app, body);
      return ok(app);
    }
    if ((m = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)$`))) && method === "PUT") {
      state.scripts.set(m[1]!, body);
      return ok({ id: m[1] });
    }
    if (
      (m = path.match(new RegExp(`^${a}/workers/scripts/([^/]+)/content$`))) &&
      method === "PUT"
    ) {
      const script = state.scripts.get(m[1]!)!;
      script.source = body.source;
      return ok({ id: m[1] });
    }
    if (route === `PUT ${a}/workers/domains`) {
      state.customDomains.set(body.hostname, body);
      return ok({ id: id("dom"), ...body });
    }
    if (route === `GET /zones/${ZONE}/workers/routes`) return ok(state.routes);
    if (route === `POST /zones/${ZONE}/workers/routes`) {
      const r = { id: id("route"), ...body };
      state.routes.push(r);
      return ok(r);
    }
    if (
      (m = path.match(new RegExp(`^/zones/${ZONE}/workers/routes/([^/]+)$`))) &&
      method === "PUT"
    ) {
      Object.assign(
        state.routes.find((r) => r.id === m![1])!,
        body,
      );
      return ok({});
    }
    if (route === `GET /zones/${ZONE}/dns_records`) {
      const name = url.searchParams.get("name");
      const proxied = url.searchParams.get("proxied");
      return ok(
        state.dns.filter(
          (r) => (!name || r.name === name) && (!proxied || String(r.proxied) === proxied),
        ),
        { total_pages: 1 },
      );
    }
    if (route === `POST /zones/${ZONE}/dns_records`) {
      const r = { id: id("dns"), ...body };
      state.dns.push(r);
      return ok(r);
    }
    return fail(404, 7003, `no fake for ${route}`);
  };
  return {
    fetch: fetchImpl as typeof fetch,
    state,
    calls,
    enableZeroTrust: () => {
      zeroTrustOff = false;
    },
  };
}

let configDir: string;
let out: string[];
let err: string[];
let keys: ReturnType<typeof memoryKeyStore>;

beforeEach(() => {
  configDir = join(tmp(), "tray");
  out = [];
  err = [];
  keys = memoryKeyStore();
});

function ctxFor(
  fetchImpl: typeof fetch,
  env: Record<string, string> = { CLOUDFLARE_API_TOKEN: "cf_token" },
  domain = "acme.dev",
): Ctx {
  return {
    mode: { interactive: false, json: true, prettyJson: false },
    yes: false,
    domainFlag: domain,
    env: { HOME: tmp(), ...env },
    configDir,
    keyStore: keys,
    fetch: fetchImpl,
    sleep: async () => {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
}

const WORKER = "export default { fetch() { return new Response('tray') } }";

describe("tray setup", () => {
  test("provisions everything, logs this machine in, and prints the summary", async () => {
    const cf = fakeCloudflare();
    await setup(ctxFor(cf.fetch), "Sid@Acme.com", { workerSource: WORKER });
    const s = cf.state;

    expect([...s.buckets]).toEqual(["tray-acme-dev"]);
    expect(s.idps).toMatchObject([{ type: "onetimepin" }]);
    expect(s.policies).toEqual([
      {
        id: expect.any(String),
        name: "tray owner (acme.dev)",
        decision: "allow",
        include: [{ email: { email: "sid@acme.com" } }],
      },
      {
        id: expect.any(String),
        name: "tray sign-in (acme.dev)",
        decision: "allow",
        include: [{ everyone: {} }],
      },
    ]);
    const [approve, signin] = s.apps;
    expect(approve).toMatchObject({
      name: "tray approve (acme.dev)",
      type: "self_hosted",
      domain: "tray.acme.dev/approve",
      destinations: [{ type: "public", uri: "tray.acme.dev/approve" }],
      policies: [{ id: s.policies[0]!.id, precedence: 1 }],
      allowed_idps: [s.idps[0]!.id],
    });
    expect(signin).toMatchObject({
      name: "tray sign-in (acme.dev)",
      destinations: [{ type: "public", uri: "*.acme.dev/.tray/signin" }],
      policies: [{ id: s.policies[1]!.id, precedence: 1 }],
    });

    const script = s.scripts.get("tray-acme-dev")!;
    expect(script.source).toBe(WORKER);
    expect((script as any).moduleType).toBe("application/javascript+module");
    expect(script.metadata.main_module).toBe("worker.js");
    expect(script.metadata.compatibility_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    const bindings = Object.fromEntries(script.metadata.bindings.map((b: any) => [b.name, b]));
    expect(bindings.BUCKET).toEqual({
      type: "r2_bucket",
      name: "BUCKET",
      bucket_name: "tray-acme-dev",
    });
    expect(bindings.DOMAIN.text).toBe("acme.dev");
    expect(bindings.OWNER_EMAIL.text).toBe("sid@acme.com");
    expect(bindings.WORKER_NAME.text).toBe("tray-acme-dev");
    expect(bindings.ACCESS_TEAM_DOMAIN.text).toBe("acme.cloudflareaccess.com");
    expect(bindings.ACCESS_APPROVE_AUD.text).toBe(approve.aud);
    expect(bindings.ACCESS_SIGNIN_AUD.text).toBe(signin.aud);
    expect(bindings.ACCESS_SIGNIN_APP_ID.text).toBe(signin.id);
    expect(bindings.CF_ACCOUNT_ID.text).toBe(ACCOUNT);
    expect(bindings.CF_API_TOKEN).toEqual({
      type: "secret_text",
      name: "CF_API_TOKEN",
      text: "cf_token",
    });
    expect(bindings.TRAY_SETUP_KEY.type).toBe("secret_text");

    expect([...s.customDomains.values()]).toEqual([
      { hostname: "tray.acme.dev", service: "tray-acme-dev", zone_id: ZONE },
    ]);
    expect(s.routes).toMatchObject([{ pattern: "*.acme.dev/*", script: "tray-acme-dev" }]);
    expect(s.dns).toMatchObject([
      { type: "AAAA", name: "*.acme.dev", content: "100::", proxied: true },
    ]);

    // The key the Worker got (as a hash) is the key this machine saved.
    const key = keys.data["acme.dev"]!;
    expect(key).toMatch(/^tray_k_[a-f0-9]{48}$/);
    const record = JSON.parse(bindings.TRAY_SETUP_KEY.text);
    expect(record.hash).toBe(new Bun.CryptoHasher("sha256").update(key).digest("hex"));
    expect(record.id).toBe(record.hash.slice(0, 12));
    expect(record).toMatchObject({ email: "sid@acme.com", lastUsedAt: null });
    expect(JSON.stringify(script.metadata)).not.toContain(key);
    expect(s.trayKeys.has(key)).toBe(true); // claimed via the liveness check

    expect(keys.data["cloudflare:acme.dev"]).toBe("cf_token");
    expect(loadAccounts(configDir)).toMatchObject({
      current: "acme.dev",
      accounts: { "acme.dev": { email: "sid@acme.com" } },
    });
    expect(loadSetups(configDir)["acme.dev"]).toEqual({
      accountId: ACCOUNT,
      zoneId: ZONE,
      worker: "tray-acme-dev",
      bucket: "tray-acme-dev",
      email: "sid@acme.com",
    });

    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      domain: "acme.dev",
      api: "https://tray.acme.dev/v1",
      live: true,
    });
    expect(err.join("\n")).toContain("R2 bucket: tray-acme-dev");
    expect(err.join("\n")).toContain("Sign-in: *.acme.dev/.tray/signin (email code)");
  });

  test("is idempotent: a re-run updates in place and issues a fresh key", async () => {
    const cf = fakeCloudflare();
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    const firstKey = keys.data["acme.dev"]!;
    // A custom host the Worker added to the sign-in app since.
    cf.state.apps[1].destinations.push({ type: "public", uri: "docs.acme.com/.tray/signin" });

    await setup(ctxFor(cf.fetch), undefined, { workerSource: WORKER + "//v2" });
    const s = cf.state;
    expect(s.buckets.size).toBe(1);
    expect(s.idps).toHaveLength(1);
    expect(s.policies).toHaveLength(2);
    expect(s.apps).toHaveLength(2);
    expect(s.routes).toHaveLength(1);
    expect(s.dns).toHaveLength(1);
    expect(s.scripts.get("tray-acme-dev")!.source).toBe(WORKER + "//v2");
    expect(s.apps[1].destinations).toEqual([
      { type: "public", uri: "*.acme.dev/.tray/signin" },
      { type: "public", uri: "docs.acme.com/.tray/signin" },
    ]);
    // Email remembered from the first run; a new key, and the old one retired.
    expect(s.policies[0]!.include).toEqual([{ email: { email: "sid@acme.com" } }]);
    expect(keys.data["acme.dev"]).not.toBe(firstKey);
    expect(s.trayKeys.has(firstKey)).toBe(false);
    expect(
      cf.calls.filter((c) => c.method === "POST" && c.path.endsWith("/r2/buckets")),
    ).toHaveLength(1);
  });

  test("changing the owner email updates the owner policy", async () => {
    const cf = fakeCloudflare();
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    await setup(ctxFor(cf.fetch), "new@acme.com", { workerSource: WORKER });
    expect(cf.state.policies[0]!.include).toEqual([{ email: { email: "new@acme.com" } }]);
    expect(cf.state.policies).toHaveLength(2);
  });

  test("fixes a route pointing at another Worker, keeps an existing proxied wildcard", async () => {
    const cf = fakeCloudflare();
    cf.state.routes.push({ id: "r0", pattern: "*.acme.dev/*", script: "old" });
    cf.state.dns.push({
      id: "d0",
      name: "*.acme.dev",
      type: "A",
      content: "192.0.2.1",
      proxied: true,
    });
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    expect(cf.state.routes).toEqual([
      { id: "r0", pattern: "*.acme.dev/*", script: "tray-acme-dev" },
    ]);
    expect(cf.state.dns).toHaveLength(1);
  });

  test("warns when the wildcard record isn't proxied", async () => {
    const cf = fakeCloudflare();
    cf.state.dns.push({
      id: "d0",
      name: "*.acme.dev",
      type: "A",
      content: "192.0.2.1",
      proxied: false,
    });
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    expect(err.join("\n")).toContain("isn't proxied");
  });

  test("warns about existing subdomains the wildcard route takes over", async () => {
    const cf = fakeCloudflare();
    for (const [name, proxied] of [
      ["www.acme.dev", true],
      ["blog.acme.dev", true],
      ["mail.acme.dev", false], // DNS only: the route never sees it
      ["acme.dev", true],
    ] as const) {
      cf.state.dns.push({ id: name, name, type: "A", content: "192.0.2.1", proxied });
    }
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    const warning = err.find((l) => l.includes("now sends"))!;
    expect(warning).toContain("blog.acme.dev, www.acme.dev to Tray");
    expect(warning).not.toContain("mail.acme.dev");
    expect(warning).not.toContain("*.acme.dev,");
  });

  test("no takeover warning on a domain with no other subdomains", async () => {
    const cf = fakeCloudflare();
    await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER });
    expect(err.join("\n")).not.toContain("now sends");
  });

  test("Zero Trust off → exit 1 with the enable link, before creating anything", async () => {
    const cf = fakeCloudflare({ zeroTrust: false });
    const e = await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(TrayError);
    expect(e.code).toBe("zero_trust_disabled");
    expect(e.exit).toBe(1);
    expect(e.hint).toContain("https://one.dash.cloudflare.com/");
    expect(e.hint).toContain("team name");
    expect(e.hint).toContain("Free plan");
    expect(e.hint).toContain("payment details");
    expect(e.hint).toContain("tray setup");
    expect(cf.state.buckets.size).toBe(0);
    expect(err.join("\n")).toContain("Zero Trust: not enabled");
  });

  test("Zero Trust is checked right after the token, before asking for --email", async () => {
    const cf = fakeCloudflare({ zeroTrust: false });
    const e = await setup(ctxFor(cf.fetch), undefined, { workerSource: WORKER }).catch((x) => x);
    expect(e.code).toBe("zero_trust_disabled");
  });

  test("interactive: waits for Enter, re-checks, and carries on", async () => {
    const { requireZeroTrust } = await import("../src/setup/zero-trust.ts");
    const { cloudflare } = await import("../src/setup/cloudflare.ts");
    const cf = fakeCloudflare({ zeroTrust: false });
    const ctx = {
      ...ctxFor(cf.fetch),
      mode: { interactive: true, json: false, prettyJson: false },
    };
    const opened: string[] = [];
    let presses = 0;
    const team = await requireZeroTrust(ctx, cloudflare("cf_token", cf.fetch), ACCOUNT, {
      open: (url) => opened.push(url),
      waitForEnter: async () => {
        presses++;
        if (presses === 2) cf.enableZeroTrust(); // enabled before the second Enter
      },
    });
    expect(team).toBe("acme.cloudflareaccess.com");
    expect(opened).toEqual(["https://one.dash.cloudflare.com/"]);
    expect(presses).toBe(2);
  });

  test("interactive: Esc / Ctrl-C at the wait exits 130", async () => {
    const { requireZeroTrust } = await import("../src/setup/zero-trust.ts");
    const { cloudflare } = await import("../src/setup/cloudflare.ts");
    const { cancelled } = await import("../src/errors.ts");
    const cf = fakeCloudflare({ zeroTrust: false });
    const ctx = {
      ...ctxFor(cf.fetch),
      mode: { interactive: true, json: false, prettyJson: false },
    };
    const e = await requireZeroTrust(ctx, cloudflare("cf_token", cf.fetch), ACCOUNT, {
      open: () => {},
      waitForEnter: async () => {
        throw cancelled();
      },
    }).catch((x) => x);
    expect(e.exit).toBe(130);
  });

  test("domain not on the account → zone_not_found naming --domain", async () => {
    const cf = fakeCloudflare({ zones: ["other.com"] });
    const e = await setup(ctxFor(cf.fetch), "sid@acme.com", { workerSource: WORKER }).catch(
      (x) => x,
    );
    expect(e.code).toBe("zone_not_found");
    expect(e.param).toBe("--domain");
  });

  test("bad token → exit 4 with the permissions it needs", async () => {
    const cf = fakeCloudflare();
    const e = await setup(ctxFor(cf.fetch, { CLOUDFLARE_API_TOKEN: "wrong" }), "sid@acme.com", {
      workerSource: WORKER,
    }).catch((x) => x);
    expect(e.code).toBe("cloudflare_forbidden");
    expect(e.exit).toBe(4);
    expect(e.hint).toContain("Workers Scripts Edit");
  });

  test("uses the token saved by an earlier setup when CLOUDFLARE_API_TOKEN is unset", async () => {
    const cf = fakeCloudflare();
    await keys.set("cloudflare:acme.dev", "cf_token");
    await setup(ctxFor(cf.fetch, {}), "sid@acme.com", { workerSource: WORKER });
    expect(cf.state.scripts.size).toBe(1);
  });

  test("not live yet → still saved, with a warning", async () => {
    const cf = fakeCloudflare();
    const offline = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://tray.acme.dev")
        ? Promise.reject(new Error("ENOTFOUND"))
        : cf.fetch(input, init)) as typeof fetch;
    await setup(ctxFor(offline), "sid@acme.com", { workerSource: WORKER });
    expect(JSON.parse(out.at(-1)!).live).toBe(false);
    expect(keys.data["acme.dev"]).toMatch(/^tray_k_/);
    expect(err.join("\n")).toContain("can take a few minutes");
  });
});

describe("tray setup flags (non-interactive)", () => {
  // Never the real API: a fake Cloudflare that knows acme.dev and accepts token "x".
  const cf = fakeCloudflare({ zones: ["acme.dev"], token: "x" });
  const run = (argv: string[], env: Record<string, string> = {}) =>
    main(argv, {
      fetch: cf.fetch,
      env: { XDG_CONFIG_HOME: tmp(), ...env },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      keyStore: memoryKeyStore(),
      stdinTTY: false,
      stdoutTTY: false,
    });

  test("missing --domain exits 2 naming the flag", async () => {
    expect(await run(["setup", "--json"])).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: "missing_input", param: "--domain" });
  });

  test("missing token exits 2 naming CLOUDFLARE_API_TOKEN", async () => {
    expect(await run(["setup", "--domain", "acme.dev", "--json"])).toBe(2);
    expect(JSON.parse(out[0]!).hint).toContain(
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=",
    );
    expect(JSON.parse(out[0]!)).toMatchObject({
      code: "missing_input",
      param: "CLOUDFLARE_API_TOKEN",
    });
  });

  test("missing --email exits 2 naming the flag", async () => {
    expect(
      await run(["setup", "--domain", "acme.dev", "--json"], { CLOUDFLARE_API_TOKEN: "x" }),
    ).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ code: "missing_input", param: "--email" });
    // Only lookups happened before it asked: nothing was created.
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
