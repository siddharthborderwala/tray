export const EXIT = {
  ok: 0,
  failed: 1, // network, server, conflict
  usage: 2, // bad usage or missing input
  auth: 4, // not authenticated / not authorized (same as gh)
  cancelled: 130, // Ctrl-C, Escape, or "no" at a prompt (interactive only)
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface ErrorExtras {
  /** Lines under the headline: the cause, raw system text, per-value problems. */
  details?: string[];
  /** Exact commands that fix it (at most two), shown on their own lines and as JSON `next`. */
  next?: string[];
}

/**
 * Every failure the CLI reports goes through this. Same shape as API errors
 * (`{ error, code, hint, param }`, snake_case codes), plus `details` and `next`.
 * `hint` is prose; with `next`, it's the label above the commands.
 */
export class TrayError extends Error {
  details?: string[];
  next?: string[];
  constructor(
    message: string,
    readonly code: string,
    readonly exit: ExitCode = EXIT.failed,
    readonly hint?: string,
    readonly param?: string,
    extras: ErrorExtras = {},
  ) {
    super(message);
    if (extras.details?.length) this.details = extras.details;
    if (extras.next?.length) this.next = extras.next.slice(0, 2);
  }
}

export const usageError = (message: string, hint?: string, param?: string) =>
  new TrayError(message, "invalid_usage", EXIT.usage, hint, param);

/**
 * A value that would have been prompted for is missing in non-interactive
 * mode. `retry` is the command to run instead (the user's own arguments plus
 * the flag), when the caller knows it.
 */
export const missingFlag = (flag: string, what = flag, retry?: string) =>
  new TrayError(
    `${what} is required in non-interactive mode`,
    "missing_input",
    EXIT.usage,
    retry ? "Run:" : `Pass ${flag}.`,
    flag.split(" ")[0],
    { next: retry ? [retry] : undefined },
  );

/** Declined or interrupted. Printed as a notice, not an error. */
export const cancelled = () =>
  new TrayError("Canceled. Nothing was changed.", "canceled", EXIT.cancelled);

export const notLoggedIn = (domain: string) =>
  new TrayError(
    `Not logged in to ${domain}`,
    "not_logged_in",
    EXIT.auth,
    "Log in, or set TRAY_API_KEY:",
    undefined,
    {
      next: [`tray login ${domain}`],
    },
  );

export const noDomain = () =>
  new TrayError(
    "No tray selected",
    "no_domain",
    EXIT.auth,
    "Log in (or pass --domain, or set TRAY_DOMAIN):",
    undefined,
    { next: ["tray login <DOMAIN>"] },
  );
