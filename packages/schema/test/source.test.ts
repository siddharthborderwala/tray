import { expect, test } from "bun:test";
import { Source } from "../src/index.ts";

test("a deploy's source is bounded and printable (it's echoed back in site_exists)", () => {
  expect(Source.safeParse({ path: "/work/q3", machine: "mbp-1a2b" }).success).toBe(true);
  for (const bad of [
    { path: "/x\x1b]52;c;ZXZpbA==\x07", machine: "m" },
    { path: "/x", machine: "a\nError: fake" },
    { path: "/x".repeat(600), machine: "m" },
  ])
    expect(Source.safeParse(bad).success).toBe(false);
});
