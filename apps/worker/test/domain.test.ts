import { describe, expect, test } from "bun:test";
import { teamIssuer } from "../src/access.ts";
import { apiHost, trayDomain } from "../src/domain.ts";

describe("the DOMAIN binding", () => {
  test.each([
    ["acme.dev", "acme.dev"],
    ["ACME.dev", "acme.dev"],
    ["tray.acme.dev", "acme.dev"],
    ["https://acme.dev/", "acme.dev"],
    ["tray.sh", "tray.sh"],
    ["tray.tray.sh", "tray.sh"],
    ["acme.co.uk", "acme.co.uk"],
  ])("%s → %s", (DOMAIN, out) => {
    expect(trayDomain({ DOMAIN })).toBe(out);
    expect(apiHost({ DOMAIN })).toBe(`tray.${out}`);
  });

  test("a binding that isn't a domain is a clear 500", () => {
    for (const DOMAIN of ["", "sh", "co.uk", "localhost"]) {
      expect(() => trayDomain({ DOMAIN })).toThrow("isn't a domain");
    }
  });
});

test("teamIssuer parses the team domain with URL", () => {
  expect(teamIssuer("acme")).toBe("https://acme.cloudflareaccess.com");
  expect(teamIssuer("acme.cloudflareaccess.com")).toBe("https://acme.cloudflareaccess.com");
  expect(teamIssuer("https://ACME.cloudflareaccess.com/")).toBe(
    "https://acme.cloudflareaccess.com",
  );
});

describe("POST /domains validates hosts with the Public Suffix List", () => {
  test("rejects public suffixes, IPs and URLs; normalizes case", async () => {
    const { setup } = await import("./helpers.ts");
    const { api, deploy } = await setup();
    await deploy("docs", { "/index.html": "d" });
    for (const host of ["co.uk", "10.0.0.1", "https://docs.acme.com", "localhost"]) {
      const res = await api("/domains", { method: "POST", json: { host, site: "docs" } });
      expect(res.status).toBe(400);
      expect((await res.json()).param).toBe("host");
    }
    const ok = await api("/domains", {
      method: "POST",
      json: { host: "Docs.Acme.COM", site: "docs" },
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).host).toBe("docs.acme.com");
  });
});
