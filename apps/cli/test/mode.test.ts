import { describe, expect, test } from "bun:test";
import { AGENT_ENV_VARS, detectMode, isAgent, isCI } from "../src/mode.ts";

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
  test("--json is reported; pretty only when stdout is a TTY", () => {
    expect(detectMode({ ...tty, json: true })).toEqual({
      interactive: false,
      json: true,
      prettyJson: true,
    });
    expect(detectMode({ ...tty, json: true, stdoutTTY: false }).prettyJson).toBe(false);
    expect(detectMode(tty).prettyJson).toBe(false);
  });
  test("CI=false / CI=0 / empty don't count", () => {
    expect(isCI({ CI: "false" })).toBe(false);
    expect(isCI({ CI: "0" })).toBe(false);
    expect(isCI({ CI: "" })).toBe(false);
    expect(isCI({ CI: "1" })).toBe(true);
  });
});

describe("agent detection", () => {
  test("the variable list", () => {
    expect([...AGENT_ENV_VARS]).toEqual([
      "AGENT",
      "AI_AGENT",
      "CLAUDECODE",
      "CURSOR_AGENT",
      "GEMINI_CLI",
      "CODEX_THREAD_ID",
    ]);
  });

  test.each(AGENT_ENV_VARS.map((v) => [v]))("%s set → non-interactive, like CI", (name) => {
    expect(isAgent({ [name]: "1" })).toBe(true);
    expect(detectMode({ ...tty, env: { [name]: "1" } }).interactive).toBe(false);
  });

  test("empty values don't count", () => {
    expect(isAgent({ AGENT: "", CLAUDECODE: "" })).toBe(false);
    expect(detectMode({ ...tty, env: { AGENT: "" } }).interactive).toBe(true);
  });

  test("--json stays opt-in under an agent", () => {
    expect(detectMode({ ...tty, env: { CLAUDECODE: "1" } }).json).toBe(false);
  });

  test("TRAY_INTERACTIVE=1 forces interactive under an agent or CI", () => {
    expect(
      detectMode({ ...tty, env: { CLAUDECODE: "1", TRAY_INTERACTIVE: "1" } }).interactive,
    ).toBe(true);
    expect(detectMode({ ...tty, env: { CI: "true", TRAY_INTERACTIVE: "1" } }).interactive).toBe(
      true,
    );
    expect(detectMode({ ...tty, env: { AGENT: "1", TRAY_INTERACTIVE: "0" } }).interactive).toBe(
      false,
    );
  });

  test("TRAY_INTERACTIVE=1 still needs both TTYs", () => {
    const env = { TRAY_INTERACTIVE: "1" };
    expect(detectMode({ ...tty, env, stdinTTY: false }).interactive).toBe(false);
    expect(detectMode({ ...tty, env, stdoutTTY: false }).interactive).toBe(false);
  });

  test("--non-interactive and --json win over TRAY_INTERACTIVE=1", () => {
    const env = { TRAY_INTERACTIVE: "1" };
    expect(detectMode({ ...tty, env, nonInteractive: true }).interactive).toBe(false);
    expect(detectMode({ ...tty, env, json: true }).interactive).toBe(false);
  });
});
