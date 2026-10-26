import { describe, expect, test } from "bun:test";
import { deployFlags, machineLabel, onSiteExists } from "../src/conflict.ts";

describe("deployFlags: --private only applies to new sites or with --replace", () => {
  test("new site with --private sends visibility", () => {
    expect(deployFlags({ exists: false, replace: false, private: true })).toEqual({ replace: false, visibility: "private" });
  });
  test("new site without --private sends nothing (Worker default: public)", () => {
    expect(deployFlags({ exists: false, replace: false, private: false })).toEqual({ replace: false });
  });
  test("redeploy keeps visibility: --private is not sent", () => {
    expect(deployFlags({ exists: true, replace: false, private: true })).toEqual({ replace: false });
  });
  test("--replace applies --private", () => {
    expect(deployFlags({ exists: true, replace: true, private: true })).toEqual({ replace: true, visibility: "private" });
    expect(deployFlags({ exists: true, replace: true, private: false })).toEqual({ replace: true });
  });
});

describe("onSiteExists", () => {
  test("interactive prompts, non-interactive fails", () => {
    expect(onSiteExists({ interactive: true, replacing: false })).toBe("prompt");
    expect(onSiteExists({ interactive: false, replacing: false })).toBe("fail");
  });
  test("never prompts twice", () => {
    expect(onSiteExists({ interactive: true, replacing: true })).toBe("fail");
  });
});

test("machineLabel is hostname plus a short id", () => {
  expect(machineLabel("mbp", "3f9a12-aa")).toBe("mbp-3f9a");
});
