// `tray upgrade` with a mocked GitHub release and Cloudflare API.
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, zipSync } from "fflate";
import { olderThan } from "../src/api.ts";
import { upgrade } from "../src/commands/upgrade.ts";
import type { Ctx } from "../src/ctx.ts";
import { TrayError } from "../src/errors.ts";
import {
  assetName,
  detectTarget,
  fetchBinary,
  replaceableBinary,
  sha256Hex,
  fileFromTarGz,
} from "../src/setup/release.ts";
import { saveSetup } from "../src/setup/state.ts";
import { memoryKeyStore, tmp } from "./helpers.ts";

const NEW_BINARY = new TextEncoder().encode("#!/bin/sh\necho tray 0.2.0\n");

function tarGz(name: string, data: Uint8Array): Uint8Array {
  const dir = tmp();
  writeFileSync(join(dir, name), data);
  const out = join(tmp(), "a.tar.gz");
  spawnSync("tar", ["-czf", out, "-C", dir, name]);
  return readFileSync(out);
}

function release(opts: { version?: string; target?: string; corrupt?: boolean } = {}) {
  const version = opts.version ?? "0.2.0";
  const target = opts.target ?? "darwin-arm64";
  const asset = assetName(target);
  const archive = target.startsWith("windows")
    ? zipSync({ "tray.exe": NEW_BINARY })
    : tarGz("tray", NEW_BINARY);
  const sum = opts.corrupt ? "0".repeat(64) : sha256Hex(archive);
  const sums = `${"1".repeat(64)}  tray-linux-x64.tar.gz\n${sum}  ${asset}\n`;
  return { version, asset, archive, sums };
}

interface Seen {
  method: string;
  url: string;
  body?: any;
}

function world(opts: { release?: ReturnType<typeof release>; workerVersion?: string | null } = {}) {
  const rel = opts.release ?? release();
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: any = init?.body;
    if (body instanceof FormData) {
      const meta = JSON.parse(await (body.get("metadata") as Blob).text());
      body = { metadata: meta, source: await (body.get(meta.main_module) as File).text() };
    }
    seen.push({ method, url, body });
    if (url === "https://api.github.com/repos/siddharthborderwala/tray/releases/latest")
      return Response.json({ tag_name: `v${rel.version}` });
    const base = `https://github.com/siddharthborderwala/tray/releases/download/v${rel.version}/`;
    if (url === base + rel.asset) return new Response(rel.archive as Uint8Array<ArrayBuffer>);
    if (url === base + "SHA256SUMS") return new Response(rel.sums);
    if (url === "https://tray.acme.dev/v1/openapi.json") {
      if (opts.workerVersion === null) throw new Error("ENOTFOUND");
      return Response.json({}, { headers: { "tray-version": opts.workerVersion ?? "0.1.0" } });
    }
    if (
      url.startsWith(
        "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/tray-acme-dev/content",
      ) &&
      method === "PUT"
    ) {
      return Response.json({ success: true, errors: [], result: {} });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

let configDir: string;
let out: string[];
let err: string[];
let keys: ReturnType<typeof memoryKeyStore>;

beforeEach(() => {
  configDir = join(tmp(), "tray");
  out = [];
  err = [];
  keys = memoryKeyStore({ "cloudflare:acme.dev": "cf_token" });
  saveSetup(configDir, "acme.dev", {
    accountId: "acct",
    zoneId: "z",
    worker: "tray-acme-dev",
    bucket: "tray-acme-dev",
    email: "sid@acme.com",
  });
});

function ctxFor(fetchImpl: typeof fetch, env: Record<string, string> = {}): Ctx {
  return {
    mode: { interactive: false, json: true, prettyJson: false },
    yes: false,
    env: { HOME: tmp(), ...env },
    configDir,
    keyStore: keys,
    fetch: fetchImpl,
    sleep: async () => {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
}

function fakeInstall(): string {
  const dir = join(tmp(), "bin");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, "tray");
  writeFileSync(exe, "old binary");
  return exe;
}

describe("tray upgrade", () => {
  test("newer release: downloads, verifies, replaces the binary, and hands over to it", async () => {
    const w = world();
    const exe = fakeInstall();
    const handover: { args: string[]; env: Record<string, string> }[] = [];
    await upgrade(ctxFor(w.fetch), {
      execPath: exe,
      target: "darwin-arm64",
      version: "0.1.0",
      runNew: async (path, args, env) => {
        expect(path).toBe(exe);
        handover.push({ args, env });
        return 0;
      },
    });
    expect(readFileSync(exe)).toEqual(Buffer.from(NEW_BINARY));
    expect(handover).toEqual([
      { args: ["upgrade", "--json", "--non-interactive"], env: { TRAY_UPGRADED_FROM: "0.1.0" } },
    ]);
    // The old binary didn't touch any Worker; the new one does that.
    expect(w.seen.some((s) => s.url.includes("api.cloudflare.com"))).toBe(false);
  });

  test("checksum mismatch: fails closed and leaves the binary alone", async () => {
    const w = world({ release: release({ corrupt: true }) });
    const exe = fakeInstall();
    const e = await upgrade(ctxFor(w.fetch), {
      execPath: exe,
      target: "darwin-arm64",
      version: "0.1.0",
      runNew: async () => 0,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(TrayError);
    expect(e.code).toBe("checksum_mismatch");
    expect(readFileSync(exe, "utf8")).toBe("old binary");
  });

  test("not a standalone binary (bun run / npm): says how to upgrade instead", async () => {
    const w = world();
    let e = await upgrade(ctxFor(w.fetch), {
      execPath: "/usr/local/bin/bun",
      version: "0.1.0",
    }).catch((x) => x);
    expect(e.code).toBe("not_standalone");
    e = await upgrade(ctxFor(w.fetch), {
      execPath: "/x/node_modules/@tray-sh/cli-darwin-arm64/bin/tray",
      version: "0.1.0",
    }).catch((x) => x);
    expect(e.hint).toContain("npm i -g @tray-sh/cli@latest");
  });

  test("the new binary's exit code is passed through", async () => {
    const w = world();
    const e = await upgrade(ctxFor(w.fetch), {
      execPath: fakeInstall(),
      target: "darwin-arm64",
      version: "0.1.0",
      runNew: async () => 1,
    }).catch((x) => x);
    expect(e.code).toBe("upgrade_failed");
    expect(e.exit).toBe(1);
  });

  test("as the new binary: redeploys an older Worker's code only (bindings kept)", async () => {
    const w = world({ workerVersion: "0.1.0" });
    await upgrade(ctxFor(w.fetch, { TRAY_UPGRADED_FROM: "0.1.0" }), {
      version: "0.2.0",
      workerSource: "new worker",
    });
    const put = w.seen.find((s) => s.method === "PUT")!;
    expect(put.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/tray-acme-dev/content",
    );
    expect(put.body).toEqual({ metadata: { main_module: "worker.js" }, source: "new worker" });
    // No GitHub check the second time round.
    expect(w.seen.some((s) => s.url.includes("api.github.com"))).toBe(false);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      version: "0.2.0",
      upgradedFrom: "0.1.0",
      workers: [{ domain: "acme.dev", from: "0.1.0", to: "0.2.0", redeployed: true }],
    });
  });

  test("up to date: no download; a current Worker is left alone", async () => {
    const w = world({ release: release({ version: "0.1.0" }), workerVersion: "0.1.0" });
    await upgrade(ctxFor(w.fetch), {
      execPath: fakeInstall(),
      version: "0.1.0",
      workerSource: "x",
    });
    expect(w.seen.map((s) => s.url)).toEqual([
      "https://api.github.com/repos/siddharthborderwala/tray/releases/latest",
      "https://tray.acme.dev/v1/openapi.json",
    ]);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      upgradedFrom: null,
      workers: [{ redeployed: false }],
    });
  });

  test("older Worker without a token: warns instead of failing", async () => {
    keys = memoryKeyStore();
    const w = world({ release: release({ version: "0.2.0" }), workerVersion: "0.1.0" });
    await upgrade(ctxFor(w.fetch, { TRAY_UPGRADED_FROM: "0.1.0" }), {
      version: "0.2.0",
      workerSource: "x",
    });
    expect(err.join("\n")).toContain("CLOUDFLARE_API_TOKEN");
    expect(w.seen.some((s) => s.method === "PUT")).toBe(false);
  });
});

describe("release helpers", () => {
  test("windows zip assets", async () => {
    const rel = release({ target: "windows-x64" });
    const w = world({ release: rel });
    expect(rel.asset).toBe("tray-windows-x64.zip");
    expect(await fetchBinary(w.fetch, "0.2.0", "windows-x64")).toEqual(NEW_BINARY);
  });

  test("fileFromTarGz handles ./ prefixes, missing files and junk", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "tray"), "bin");
    const out = join(tmp(), "t.tar.gz");
    spawnSync("tar", ["-czf", out, "-C", dir, "./tray"]);
    const tgz = readFileSync(out);
    expect(new TextDecoder().decode(await fileFromTarGz(tgz, "tray"))).toBe("bin");
    expect(await fileFromTarGz(tgz, "nope")).toBeUndefined();
    expect(await fileFromTarGz(gzipSync(new Uint8Array(0)), "tray")).toBeUndefined();
  });

  test("detectTarget mirrors install.sh", () => {
    const no = () => false;
    const yes = () => true;
    expect(detectTarget("darwin", "arm64", { rosetta: no, musl: no })).toBe("darwin-arm64");
    expect(detectTarget("darwin", "x64", { rosetta: yes, musl: no })).toBe("darwin-arm64");
    expect(detectTarget("linux", "x64", { rosetta: no, musl: yes })).toBe("linux-x64-musl");
    expect(detectTarget("linux", "arm64", { rosetta: no, musl: no })).toBe("linux-arm64");
    expect(detectTarget("win32", "x64", { rosetta: no, musl: no })).toBe("windows-x64");
    expect(() => detectTarget("freebsd", "x64")).toThrow();
  });

  test("olderThan / replaceableBinary", () => {
    expect(olderThan("0.1.0", "0.2.0")).toBe(true);
    expect(olderThan("0.10.0", "0.9.0")).toBe(false);
    expect(olderThan("v1.0.0", "1.0.0")).toBe(false);
    expect(replaceableBinary("/Users/sid/.tray/bin/tray")).toBe(true);
    expect(replaceableBinary("C:\\tray\\bin\\tray.exe")).toBe(true);
    expect(replaceableBinary("/opt/homebrew/bin/bun")).toBe(false);
  });
});
