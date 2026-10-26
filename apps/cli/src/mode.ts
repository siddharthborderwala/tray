export interface Mode {
  /** Prompts and Clack UI allowed. */
  interactive: boolean;
  /** Print exactly one JSON object to stdout. */
  json: boolean;
  /** Indent JSON output: stdout is a terminal. Piped or redirected output stays one compact line. */
  prettyJson: boolean;
}

export interface ModeInput {
  json: boolean;
  nonInteractive: boolean;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  env: Record<string, string | undefined>;
}

export function isCI(env: Record<string, string | undefined>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/**
 * Interactive only when stdin and stdout are TTYs, CI is unset, and neither
 * --json nor --non-interactive is passed.
 */
export function detectMode(input: ModeInput): Mode {
  const interactive =
    input.stdinTTY && input.stdoutTTY && !isCI(input.env) && !input.json && !input.nonInteractive;
  return { interactive, json: input.json, prettyJson: input.json && input.stdoutTTY };
}
