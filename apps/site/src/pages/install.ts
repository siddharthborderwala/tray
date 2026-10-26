import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

export const prerender = true;

/** `curl -fsSL tray.sh/install | sh`: the repo's scripts/install.sh, as is. */
export const GET: APIRoute = () =>
  new Response(readFileSync(join(process.cwd(), "../../scripts/install.sh"), "utf8"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
