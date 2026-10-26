import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  apiBaseUrl,
  apiUrl,
  defaultKeyStore,
  fileKeyStore,
  normalizeDomain,
  resolveDomain,
  resolveKey,
} from "../src/credentials.ts";
import { TrayError } from "../src/errors.ts";
import { memoryKeyStore, tmp } from "./helpers.ts";

const accounts = (current?: string) => ({ current, accounts: {} });

describe("resolveDomain: --domain / TRAY_DOMAIN → current account → error", () => {
  test("flag wins", () => {
    expect(resolveDomain("flag.app", { TRAY_DOMAIN: "env.app" }, accounts("saved.app"))).toBe(
      "flag.app",
    );
  });
  test("then TRAY_DOMAIN", () => {
    expect(resolveDomain(undefined, { TRAY_DOMAIN: "env.app" }, accounts("saved.app"))).toBe(
      "env.app",
    );
  });
  test("then the saved current account", () => {
    expect(resolveDomain(undefined, {}, accounts("saved.app"))).toBe("saved.app");
  });
  test("else exit 4", () => {
    const err = (() => {
      try {
        resolveDomain(undefined, {}, accounts());
      } catch (e) {
        return e as TrayError;
      }
    })()!;
    expect(err.exit).toBe(4);
    expect(err.code).toBe("no_domain");
  });
});

describe("resolveKey: TRAY_API_KEY → saved key → error", () => {
  test("env key overrides a saved login", async () => {
    expect(
      await resolveKey(
        "acme.dev",
        { TRAY_API_KEY: "tray_k_env" },
        memoryKeyStore({ "acme.dev": "tray_k_saved" }),
      ),
    ).toBe("tray_k_env");
  });
  test("saved key for that domain", async () => {
    expect(
      await resolveKey(
        "acme.dev",
        {},
        memoryKeyStore({ "acme.dev": "tray_k_saved", "x.app": "nope" }),
      ),
    ).toBe("tray_k_saved");
  });
  test("not logged in: exit 4 with the spec's message", async () => {
    const err = await resolveKey("acme.dev", {}, memoryKeyStore()).catch((e) => e);
    expect(err).toBeInstanceOf(TrayError);
    expect(err.exit).toBe(4);
    expect(err.message).toBe("not logged in to acme.dev");
    expect(err.hint).toBe("Run `tray login acme.dev` or set TRAY_API_KEY.");
  });
});

describe("key stores", () => {
  test("file store writes auth.json with mode 600", async () => {
    const dir = tmp();
    const store = fileKeyStore(dir);
    await store.set("acme.dev", "tray_k_1");
    await store.set("b.app", "tray_k_2");
    expect(await store.get("acme.dev")).toBe("tray_k_1");
    expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
    await store.delete("acme.dev");
    expect(await store.get("acme.dev")).toBeNull();
    expect(await store.get("b.app")).toBe("tray_k_2");
  });

  test("keychain store falls back to auth.json when Bun.secrets fails", async () => {
    const dir = tmp();
    const broken = {
      get: async () => {
        throw new Error("no keychain");
      },
      set: async () => {
        throw new Error("no keychain");
      },
      delete: async () => {
        throw new Error("no keychain");
      },
    } as unknown as typeof Bun.secrets;
    const store = defaultKeyStore(dir, broken);
    await store.set("acme.dev", "tray_k_1");
    expect(await fileKeyStore(dir).get("acme.dev")).toBe("tray_k_1");
    expect(await store.get("acme.dev")).toBe("tray_k_1");
  });

  test("keychain store prefers the keychain and leaves no plaintext copy", async () => {
    const dir = tmp();
    await fileKeyStore(dir).set("acme.dev", "tray_k_old");
    const mem = new Map<string, string>();
    const secrets = {
      get: async ({ name }: { name: string }) => mem.get(name) ?? null,
      set: async ({ name, value }: { name: string; value: string }) => void mem.set(name, value),
      delete: async ({ name }: { name: string }) => mem.delete(name),
    } as unknown as typeof Bun.secrets;
    const store = defaultKeyStore(dir, secrets);
    await store.set("acme.dev", "tray_k_new");
    expect(mem.get("acme.dev")).toBe("tray_k_new");
    expect(await fileKeyStore(dir).get("acme.dev")).toBeNull();
  });
});

describe("domains", () => {
  test("normalizeDomain", () => {
    expect(normalizeDomain("acme.dev")).toBe("acme.dev");
    expect(normalizeDomain("https://tray.ACME.dev/approve")).toBe("acme.dev");
    // A domain that starts with "tray." is still a domain.
    expect(normalizeDomain("tray.sh")).toBe("tray.sh");
    expect(normalizeDomain("tray.tray.sh")).toBe("tray.sh");
    expect(normalizeDomain("https://tray.sh/")).toBe("tray.sh");
    expect(normalizeDomain("ACME.co.uk/")).toBe("acme.co.uk");
    expect(normalizeDomain("tray.acme.co.uk")).toBe("acme.co.uk");
  });
  test("normalizeDomain rejects non-domains with exit 2", () => {
    for (const bad of ["sh", "co.uk", "localhost", "not a domain", "acme.dev:8080"]) {
      expect(() => normalizeDomain(bad)).toThrow(TrayError);
      try {
        normalizeDomain(bad, "TRAY_DOMAIN");
      } catch (e: any) {
        expect(e.exit).toBe(2);
        expect(e.message).toStartWith("TRAY_DOMAIN:");
      }
    }
  });
  test("resolveDomain normalizes every source", () => {
    expect(resolveDomain("https://tray.ACME.dev/", {}, accounts())).toBe("acme.dev");
    expect(resolveDomain(undefined, { TRAY_DOMAIN: "TRAY.SH" }, accounts())).toBe("tray.sh");
    expect(resolveDomain(undefined, {}, accounts("tray.tray.sh"))).toBe("tray.sh");
  });
  test("apiUrl joins paths with URL", () => {
    expect(apiUrl("tray.sh", {}, "v1/keys")).toBe("https://tray.tray.sh/v1/keys");
    expect(apiUrl("acme.dev", { TRAY_API_URL: "http://localhost:8787/base" }, "v1/keys")).toBe(
      "http://localhost:8787/base/v1/keys",
    );
  });
  test("apiBaseUrl uses tray.<domain>, TRAY_API_URL overrides", () => {
    expect(apiBaseUrl("acme.dev", {})).toBe("https://tray.acme.dev/");
    expect(apiBaseUrl("acme.dev", { TRAY_API_URL: "http://localhost:8787" })).toBe(
      "http://localhost:8787/",
    );
  });
});
