// Shared bits for the API routers: context type, validation hook, error docs.
import { OpenAPIHono } from "@hono/zod-openapi";
import { ApiError } from "@traysh/schema";
import type { AccessVerifier } from "./access.ts";
import type { CloudflareApi } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { TrayError, type ErrorStatus } from "./errors.ts";

export interface Deps {
  cloudflare: (env: Env) => CloudflareApi;
  verifyAccess: AccessVerifier;
}

export interface Identity {
  email: string;
  /** Set when the caller used an API key (not an Access identity). */
  keyId?: string;
}

export type Ctx = {
  Bindings: Env;
  Variables: { deps: Deps; identity: Identity };
};

/** A router whose validation failures become `400 invalid_request` with `param`. */
export function newRouter() {
  return new OpenAPIHono<Ctx>({
    defaultHook: (result) => {
      if (result.success) return;
      const issue = result.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      const param = path || (result.target === "json" ? "body" : result.target);
      throw new TrayError(
        400,
        "invalid_request",
        `${param}: ${issue?.message ?? "invalid input"}`,
        { param },
      );
    },
  });
}

const ERROR_DESCRIPTIONS: Record<ErrorStatus, string> = {
  400: "Invalid request",
  401: "Missing or invalid API key (`unauthenticated`)",
  403: "Not allowed (`forbidden`)",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  411: "content-length required (`length_required`)",
  413: "Too large (`too_large`)",
  422: "Unprocessable (`zone_not_in_account`)",
  500: "Internal error",
  502: "Upstream (Cloudflare API) error",
};

/** OpenAPI `responses` entries for error statuses. 400 and 401 are added to every authed route. */
export function errors<S extends ErrorStatus>(...statuses: S[]) {
  return Object.fromEntries(
    [400, 401, ...statuses].map((s) => [s, json(ApiError, ERROR_DESCRIPTIONS[s as ErrorStatus])]),
  ) as {
    [K in S | 400 | 401]: {
      description: string;
      content: { "application/json": { schema: typeof ApiError } };
    };
  };
}

export const bearer = [{ bearer: [] }];

export function json<T>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } };
}

export function body<T>(schema: T) {
  return { required: true, content: { "application/json": { schema } } };
}
