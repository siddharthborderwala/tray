import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  apiBaseUrl,
  preferredKeyStore,
  apiUrl,
  defaultKeyStore,
  fileKeyStore,
  normalizeDomain,
  resolveDomain,
  resolveKey,
} from "../src/credentials.ts";
import { MACOS_SIGNED } from "../src/build.ts";
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
    const store = defaultKeyStore(dir, { secrets: broken, platform: "linux" });
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
    const store = defaultKeyStore(dir, { secrets, platform: "linux" });
    await store.set("acme.dev", "tray_k_new");
    expect(mem.get("acme.dev")).toBe("tray_k_new");
    expect(await fileKeyStore(dir).get("acme.dev")).toBeNull();
  });
});

/** An in-memory Bun.secrets stand-in that counts calls. */
function fakeSecrets(initial: Record<string, string> = {}, opts: { hang?: boolean } = {}) {
  const mem = new Map(Object.entries(initial));
  const calls: string[] = [];
  const wait = <T>(v: T) => (opts.hang ? new Promise<T>(() => {}) : Promise.resolve(v));
  const secrets = {
    get: ({ name }: { name: string }) => (calls.push(`get ${name}`), wait(mem.get(name) ?? null)),
    set: ({ name, value }: { name: string; value: string }) => (
      calls.push(`set ${name}`),
      opts.hang ? wait(undefined) : (mem.set(name, value), wait(undefined))
    ),
    delete: ({ name }: { name: string }) => (calls.push(`delete ${name}`), wait(mem.delete(name))),
  } as unknown as typeof Bun.secrets;
  return { secrets, mem, calls };
}

describe("keychain policy", () => {
  test("preferredKeyStore: signed macOS, Windows and Linux use the keychain; unsigned macOS uses auth.json", () => {
    expect(preferredKeyStore("darwin", true)).toBe("keychain");
    expect(preferredKeyStore("darwin", false)).toBe("file");
    expect(preferredKeyStore("win32", false)).toBe("keychain");
    expect(preferredKeyStore("linux", false)).toBe("keychain");
  });

  test("unsigned macOS writes auth.json and never touches the Keychain on save", async () => {
    const dir = tmp();
    const k = fakeSecrets();
    const store = defaultKeyStore(dir, {
      secrets: k.secrets,
      platform: "darwin",
      macosSigned: false,
    });
    await store.set("acme.dev", "tray_k_1");
    expect(await fileKeyStore(dir).get("acme.dev")).toBe("tray_k_1");
    expect(k.calls).toEqual([]);
    expect(await store.get("acme.dev")).toBe("tray_k_1");
    expect(await store.source!("acme.dev")).toBe("file");
    expect(k.calls).toEqual([]); // found in the file first, so no Keychain read either
  });

  test("unsigned macOS still finds a key an earlier signed build saved in the Keychain", async () => {
    const dir = tmp();
    const k = fakeSecrets({ "acme.dev": "tray_k_kc" });
    const store = defaultKeyStore(dir, {
      secrets: k.secrets,
      platform: "darwin",
      macosSigned: false,
    });
    expect(await store.get("acme.dev")).toBe("tray_k_kc");
    expect(await store.source!("acme.dev")).toBe("keychain");
  });

  test("signed macOS saves to the Keychain and reads it first", async () => {
    const dir = tmp();
    await fileKeyStore(dir).set("acme.dev", "tray_k_file");
    const k = fakeSecrets();
    const store = defaultKeyStore(dir, {
      secrets: k.secrets,
      platform: "darwin",
      macosSigned: true,
    });
    expect(await store.get("acme.dev")).toBe("tray_k_file"); // old file key still works
    await store.set("acme.dev", "tray_k_new");
    expect(k.mem.get("acme.dev")).toBe("tray_k_new");
    expect(await fileKeyStore(dir).get("acme.dev")).toBeNull();
    expect(await store.source!("acme.dev")).toBe("keychain");
  });

  test("a keychain that never answers times out and falls back to auth.json", async () => {
    const dir = tmp();
    await fileKeyStore(dir).set("acme.dev", "tray_k_file");
    const k = fakeSecrets({}, { hang: true });
    const store = defaultKeyStore(dir, { secrets: k.secrets, platform: "linux", timeoutMs: 20 });
    const started = Date.now();
    expect(await store.get("acme.dev")).toBe("tray_k_file");
    await store.set("other.dev", "tray_k_2"); // keychain write times out → file
    expect(await fileKeyStore(dir).get("other.dev")).toBe("tray_k_2");
    await store.delete("other.dev");
    expect(await fileKeyStore(dir).get("other.dev")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("no Bun.secrets at all: file only", async () => {
    const dir = tmp();
    const store = defaultKeyStore(dir, { secrets: undefined, platform: "linux" });
    await store.set("acme.dev", "tray_k_1");
    expect(await store.source!("acme.dev")).toBe("file");
  });

  test("delete removes both copies", async () => {
    const dir = tmp();
    await fileKeyStore(dir).set("acme.dev", "tray_k_file");
    const k = fakeSecrets({ "acme.dev": "tray_k_kc" });
    const store = defaultKeyStore(dir, { secrets: k.secrets, platform: "linux" });
    await store.delete("acme.dev");
    expect(await store.get("acme.dev")).toBeNull();
  });

  test("MACOS_SIGNED is false in unsigned builds", () => {
    expect(MACOS_SIGNED).toBe(false);
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
