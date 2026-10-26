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

/**
 * Env vars that mean "running under an AI agent". Any non-empty value counts.
 * `AGENT` / `AI_AGENT` are the generic conventions; the rest are markers set
 * by specific agents.
 */
export const AGENT_ENV_VARS = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "CODEX_THREAD_ID",
] as const;

type Env = Record<string, string | undefined>;

export function isCI(env: Env): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

export function isAgent(env: Env): boolean {
  return AGENT_ENV_VARS.some((name) => !!env[name]);
}

/**
 * Interactive only when stdin and stdout are TTYs, neither CI nor an agent is
 * detected, and neither --json nor --non-interactive is passed.
 * `TRAY_INTERACTIVE=1` overrides CI / agent detection (TTYs still required);
 * --json and --non-interactive always win.
 */
export function detectMode(input: ModeInput): Mode {
  const { env } = input;
  const forced = env.TRAY_INTERACTIVE === "1";
  const automated = isCI(env) || isAgent(env);
  const interactive =
    input.stdinTTY &&
    input.stdoutTTY &&
    !input.json &&
    !input.nonInteractive &&
    (forced || !automated);
  return { interactive, json: input.json, prettyJson: input.json && input.stdoutTTY };
}
