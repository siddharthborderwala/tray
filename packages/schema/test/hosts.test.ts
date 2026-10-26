import { describe, expect, test } from "bun:test";
import {
  DeployId,
  Hostname,
  HostnameInput,
  ShareEntry,
  TrayDomain,
  TrayDomainInput,
  hostFromInput,
  normalizeHostname,
  normalizeTrayDomain,
  registrableDomain,
} from "../src/index.ts";

describe("normalizeTrayDomain", () => {
  test.each([
    ["acme.dev", "acme.dev"],
    ["tray.acme.dev", "acme.dev"], // the API host
    ["tray.sh", "tray.sh"], // `sh` alone isn't a domain, so tray. stays
    ["tray.tray.sh", "tray.sh"],
    ["acme.co.uk", "acme.co.uk"],
    ["tray.acme.co.uk", "acme.co.uk"],
    ["tray.co.uk", "tray.co.uk"], // co.uk is a public suffix
    ["ACME.Dev", "acme.dev"],
    ["TRAY.SH", "tray.sh"],
    ["acme.dev/", "acme.dev"],
    ["acme.dev.", "acme.dev"],
    ["  acme.dev  ", "acme.dev"],
    ["https://tray.acme.dev/", "acme.dev"],
    ["https://tray.acme.dev/approve?code=X", "acme.dev"],
    ["http://ACME.dev", "acme.dev"],
    ["https://tray.sh/", "tray.sh"],
    ["pages.acme.dev", "pages.acme.dev"], // subdomain trays are allowed
    ["bücher.example.com", "xn--bcher-kva.example.com"],
  ])("%s → %s", (input, out) => {
    expect(normalizeTrayDomain(input)).toBe(out);
    expect(TrayDomainInput.parse(input)).toBe(out);
  });

  test.each([
    "",
    "sh",
    "co.uk",
    "localhost",
    "acme.local",
    "acme",
    "1.2.3.4",
    "acme.dev:8080",
    "user@acme.dev",
    "foo..bar.com",
    "-bad.com",
    "not a domain",
  ])("rejects %j", (input) => {
    expect(normalizeTrayDomain(input)).toBeNull();
    expect(TrayDomainInput.safeParse(input).success).toBe(false);
  });

  test("TrayDomain accepts only the canonical form", () => {
    expect(TrayDomain.safeParse("acme.dev").success).toBe(true);
    expect(TrayDomain.safeParse("tray.sh").success).toBe(true);
    expect(TrayDomain.safeParse("tray.acme.dev").success).toBe(false);
    expect(TrayDomain.safeParse("ACME.dev").success).toBe(false);
  });
});

describe("hostnames", () => {
  test("hostFromInput uses URL parsing", () => {
    expect(hostFromInput("https://Docs.Acme.com/x/y")).toBe("docs.acme.com");
    expect(hostFromInput("docs.acme.com/")).toBe("docs.acme.com");
    expect(hostFromInput("https://a:b@acme.com")).toBeNull();
    expect(hostFromInput("")).toBeNull();
  });

  test("normalizeHostname / HostnameInput", () => {
    for (const s of [
      "docs.acme.com",
      "DOCS.ACME.COM",
      "docs.acme.com/",
      "https://docs.acme.com/x",
    ]) {
      expect(normalizeHostname(s)).toBe("docs.acme.com");
      expect(HostnameInput.parse(s)).toBe("docs.acme.com");
    }
    expect(normalizeHostname("www.acme.co.uk")).toBe("www.acme.co.uk");
    for (const s of ["co.uk", "localhost", "10.0.0.1", "x.local"])
      expect(normalizeHostname(s)).toBeNull();
  });

  test("Hostname (API) wants a bare hostname, any case", () => {
    expect(Hostname.safeParse("docs.acme.com").success).toBe(true);
    expect(Hostname.safeParse("Docs.Acme.com").success).toBe(true);
    expect(Hostname.safeParse("docs.acme.co.uk").success).toBe(true);
    for (const s of [
      "https://docs.acme.com",
      "docs.acme.com/",
      "co.uk",
      "localhost",
      "a..b.com",
      "1.2.3.4",
    ]) {
      expect(Hostname.safeParse(s).success).toBe(false);
    }
  });

  test("registrableDomain uses the Public Suffix List", () => {
    expect(registrableDomain("docs.acme.dev")).toBe("acme.dev");
    expect(registrableDomain("a.b.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("tray.sh")).toBe("tray.sh");
    expect(registrableDomain("co.uk")).toBeNull();
  });
});

describe("share entries and ids", () => {
  test("ShareEntry: emails and @domains", () => {
    for (const s of ["bob@acme.com", "@acme.com", "@ACME.com", "@acme.co.uk", "@eng.acme.com"]) {
      expect(ShareEntry.safeParse(s).success).toBe(true);
    }
    for (const s of ["bob", "@", "@co.uk", "@localhost", "acme.com", "@acme.com/", "bob@"]) {
      expect(ShareEntry.safeParse(s).success).toBe(false);
    }
  });

  test("DeployId", () => {
    expect(DeployId.safeParse("mh7q2k1c-8f1a").success).toBe(true);
    for (const s of ["", "nope", "../../keys/x", "MH7Q-8F1A", "a-b-c"]) {
      expect(DeployId.safeParse(s).success).toBe(false);
    }
  });
});
