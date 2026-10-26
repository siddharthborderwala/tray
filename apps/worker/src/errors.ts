import type { ErrorCode } from "@traysh/schema";

export type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 411 | 413 | 422 | 500 | 502;

/** Thrown anywhere in the API; `app.onError` turns it into `{ error, code, hint?, param?, ...extra }`. */
export class TrayError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: ErrorCode,
    message: string,
    readonly options: { hint?: string; param?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
  }

  toJSON() {
    const { hint, param, extra } = this.options;
    return {
      error: this.message,
      code: this.code,
      ...(hint ? { hint } : {}),
      ...(param ? { param } : {}),
      ...extra,
    };
  }
}

export const siteNotFound = (site: string) =>
  new TrayError(404, "site_not_found", `site ${site} not found`, {
    param: "site",
    hint: "Run `tray list` to see your sites.",
  });
