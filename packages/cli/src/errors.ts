export const EXIT = {
  ok: 0,
  failed: 1, // network, server, conflict
  usage: 2, // bad usage or missing input
  auth: 4, // not authenticated / not authorized (same as gh)
  cancelled: 130, // Ctrl-C, Escape, or "no" at a prompt (interactive only)
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Every failure the CLI reports goes through this. Same shape as API errors
 * (`{ error, code, hint, param }`, snake_case codes).
 */
export class TrayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exit: ExitCode = EXIT.failed,
    readonly hint?: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

export const usageError = (message: string, hint?: string, param?: string) => new TrayError(message, "invalid_usage", EXIT.usage, hint, param);

/** A value that would have been prompted for is missing in non-interactive mode. */
export const missingFlag = (flag: string, what = flag) =>
  new TrayError(`missing ${what}`, "missing_input", EXIT.usage, `Pass ${flag}.`, flag.split(" ")[0]);

export const cancelled = () => new TrayError("cancelled", "cancelled", EXIT.cancelled);

export const notLoggedIn = (domain: string) =>
  new TrayError(`not logged in to ${domain}`, "not_logged_in", EXIT.auth, `Run \`tray login ${domain}\` or set TRAY_API_KEY.`);

export const noDomain = () =>
  new TrayError("no tray selected", "no_domain", EXIT.auth, "Run `tray login <domain>`, pass --domain, or set TRAY_DOMAIN.");
