import { expect, test } from "bun:test";
import { tokenTemplateUrl } from "../src/setup/token.ts";

test("the token link opens the user token page with exactly setup's permissions", () => {
  const url = new URL(tokenTemplateUrl("acme.dev"));
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
  expect(url.searchParams.get("accountId")).toBe("*");
  expect(url.searchParams.get("zoneId")).toBe("all");
  expect(url.searchParams.get("name")).toBe("tray-acme.dev");
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([
    { key: "workers_scripts", type: "edit" },
    { key: "workers_r2", type: "edit" },
    { key: "access", type: "edit" },
    { key: "access_acct", type: "edit" },
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
    { key: "workers_routes", type: "edit" },
  ]);
  expect([...url.searchParams.keys()].sort()).toEqual([
    "accountId",
    "name",
    "permissionGroupKeys",
    "zoneId",
  ]);
});

test("encoded like Cloudflare's own examples", () => {
  const raw = tokenTemplateUrl("acme.dev");
  expect(raw).toStartWith(
    "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D",
  );
  expect(raw).toContain("&accountId=%2A&zoneId=all&name=tray-acme.dev");
});
