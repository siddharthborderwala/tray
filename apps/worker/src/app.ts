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
import { apiHost, trayDomain } from "./domain.ts";
import { fontBytes } from "./assets/font.ts";
import { apiHomePage, FONT_PATH, messagePage, PAGE_HEADERS } from "./pages.ts";

export const VERSION: string = pkg.version;

/** The `/v1` API. Its type is what the CLI's `hc` client is typed from. */
export const api = newRouter();
api.use(requireAuth);

api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
  type: "http",
  scheme: "bearer",
  description: "An API key, `tray_k_…`",
});
/**
 * OpenAPI config. `servers` stays templated (`https://tray.{domain}/v1`); a
 * running Worker fills in its own domain as the default.
 */
export function openApiConfig(domain = "example.com") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tray",
      version: VERSION,
      description:
        "Self-hosted Tray API: publish folders as sites on your own domain. Authenticate with `authorization: Bearer tray_k_…`. Errors are `{ error, code, hint?, param? }` with snake_case codes.",
    },
    servers: [
      {
        url: "https://tray.{domain}/v1",
        description: "Your tray",
        variables: {
          domain: { default: domain, description: "The domain the tray was set up on" },
        },
      },
    ],
  };
}

api.doc31("/openapi.json", (c) => openApiConfig(trayDomain(c.env)));

const routes = api
  .route("/", blobs)
  .route("/", sites)
  .route("/", shares)
  .route("/", domains)
  .route("/", keys)
  .route("/", auth);

export type AppType = typeof routes;

/** The OpenAPI document, as served at `/v1/openapi.json` (written to dist/openapi.json at build). */
export function openApiDocument(domain?: string) {
  return api.getOpenAPI31Document(openApiConfig(domain));
}

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

  // The pages' font, on every host (sites included: their 404 and sign-in pages use it).
  app.get(FONT_PATH, (c) =>
    c.body(fontBytes() as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );

  // Every host except tray.<domain> is a site.
  app.use(async (c, next) => {
    if (hostOf(c) !== apiHost(c.env)) return serveSite(c);
    await next();
  });

  app.route("/v1", api);
  app.route("/approve", approvePage);

  app.get("/", (c) => c.html(apiHomePage(trayDomain(c.env)), 200, PAGE_HEADERS));

  app.notFound((c) => {
    const body = { error: `no route for ${c.req.method} ${c.req.path}`, code: "not_found" };
    return c.req.path.startsWith("/v1/")
      ? c.json(body, 404)
      : c.html(messagePage("Nothing here", "This page doesn't exist."), 404, PAGE_HEADERS);
  });

  app.onError((err, c) => {
    if (err instanceof TrayError) return c.json(err.toJSON(), err.status);
    if (err instanceof HTTPException && err.status < 500) {
      // Malformed JSON (400) or a body that isn't application/json (415, from the route's media-type gate).
      const unsupported = err.status === 415;
      return c.json(
        {
          error: unsupported
            ? "content-type must be application/json"
            : err.message || "invalid request body",
          code: "invalid_request",
          param: unsupported ? "content-type" : "body",
        },
        400,
      );
    }
    console.error(err);
    const res = {
      error: "internal error",
      code: "internal",
      hint: "Check the Worker logs (wrangler tail).",
    };
    return c.req.path.startsWith("/v1/") || hostOf(c) === apiHost(c.env)
      ? c.json(res, 500)
      : c.text("Internal Server Error", 500);
  });

  return app;
}
