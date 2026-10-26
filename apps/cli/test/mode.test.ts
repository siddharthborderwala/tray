import { describe, expect, test } from "bun:test";
import { detectMode, isCI } from "../src/mode.ts";

const tty = { json: false, nonInteractive: false, stdinTTY: true, stdoutTTY: true, env: {} };

describe("detectMode", () => {
  test("interactive only with both TTYs, no CI, no --json / --non-interactive", () => {
    expect(detectMode(tty).interactive).toBe(true);
  });
  test.each([
    ["stdin not a TTY", { stdinTTY: false }],
    ["stdout not a TTY", { stdoutTTY: false }],
    ["CI set", { env: { CI: "true" } }],
    ["--json", { json: true }],
    ["--non-interactive", { nonInteractive: true }],
  ])("%s → non-interactive", (_, patch) => {
    expect(detectMode({ ...tty, ...patch }).interactive).toBe(false);
  });
  test("--json is reported", () => {
    expect(detectMode({ ...tty, json: true })).toEqual({ interactive: false, json: true });
  });
  test("CI=false / CI=0 / empty don't count", () => {
    expect(isCI({ CI: "false" })).toBe(false);
    expect(isCI({ CI: "0" })).toBe(false);
    expect(isCI({ CI: "" })).toBe(false);
    expect(isCI({ CI: "1" })).toBe(true);
  });
});
