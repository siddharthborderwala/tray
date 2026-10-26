import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

export const prerender = true;

/** A real tray run by the maintainers, so readers and agents can try the API. */
const SERVER = "https://tray.tray.sh/v1";

/** The Worker's OpenAPI document, from its build (apps/worker/dist/openapi.json). */
async function document(): Promise<Record<string, unknown>> {
  const built = join(process.cwd(), "../worker/dist/openapi.json");
  if (existsSync(built)) return JSON.parse(readFileSync(built, "utf8"));
  // Until the Worker's build writes it, ask the app for the same document.
  const { api, VERSION } = await import("@tray-sh/worker/app");
  return api.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Tray",
      version: VERSION,
      description: "Tray Worker API. Errors are `{ error, code, hint?, param? }`.",
    },
  }) as unknown as Record<string, unknown>;
}

export const GET: APIRoute = async () => {
  const doc = { ...(await document()), servers: [{ url: SERVER }] };
  return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
    headers: { "content-type": "application/json" },
  });
};
