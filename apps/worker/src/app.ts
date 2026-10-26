// The Tray Worker: one Hono app.
//   tray.<domain>/v1/*     API (SPEC.md §5)
//   tray.<domain>/approve  device-login approval page (behind Access)
//   any other host         site serving
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import pkg from "../package.json" with { type: "json" };
import { createAccessVerifier } from "./access.ts";
import { approvePage } from "./approve.ts";
import { requireAuth } from "./auth.ts";
import { cloudflareApi } from "./cloudflare.ts";
import { TrayError } from "./errors.ts";
import { type Ctx, type Deps, newRouter } from "./router.ts";
import { blobs } from "./routes/blobs.ts";
import { auth } from "./routes/device.ts";
import { domains } from "./routes/domains.ts";
import { keys } from "./routes/keys.ts";
import { shares } from "./routes/shares.ts";
import { sites } from "./routes/sites.ts";
import { hostOf, serveSite } from "./serve.ts";

export const VERSION: string = pkg.version;

/** The `/v1` API. Its type is what the CLI's `hc` client is typed from. */
export const api = newRouter();
api.use(requireAuth);

api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
  type: "http",
  scheme: "bearer",
  description: "An API key, `tray_k_…`",
});
api.doc31("/openapi.json", (c) => ({
  openapi: "3.1.0",
  info: {
    title: "Tray",
    version: VERSION,
    description: "Tray Worker API. Errors are `{ error, code, hint?, param? }`.",
  },
  servers: [{ url: `https://tray.${c.env.DOMAIN}/v1` }],
}));

const routes = api
  .route("/", blobs)
  .route("/", sites)
  .route("/", shares)
  .route("/", domains)
  .route("/", keys)
  .route("/", auth);

export type AppType = typeof routes;

export function defaultDeps(): Deps {
  return { cloudflare: (env) => cloudflareApi(env), verifyAccess: createAccessVerifier() };
}

export function createApp(deps: Deps = defaultDeps()) {
  const app = new Hono<Ctx>();

  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
    c.res.headers.set("tray-version", VERSION);
  });

  // Every host except tray.<domain> is a site.
  app.use(async (c, next) => {
    if (hostOf(c) !== `tray.${c.env.DOMAIN.toLowerCase()}`) return serveSite(c);
    await next();
  });

  app.route("/v1", api);
  app.route("/approve", approvePage);

  app.notFound((c) => {
    const body = { error: `no route for ${c.req.method} ${c.req.path}`, code: "not_found" };
    return c.req.path.startsWith("/v1/") ? c.json(body, 404) : c.text("Not Found", 404);
  });

  app.onError((err, c) => {
    if (err instanceof TrayError) return c.json(err.toJSON(), err.status);
    if (err instanceof HTTPException && err.status === 400) {
      // e.g. malformed JSON from the body validator
      return c.json(
        { error: err.message || "invalid request body", code: "invalid_request", param: "body" },
        400,
      );
    }
    console.error(err);
    const res = {
      error: "internal error",
      code: "internal",
      hint: "Check the Worker logs (wrangler tail).",
    };
    return c.req.path.startsWith("/v1/") || hostOf(c) === `tray.${c.env.DOMAIN}`
      ? c.json(res, 500)
      : c.text("Internal Server Error", 500);
  });

  return app;
}
