import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { APIRoute } from "astro";

export const prerender = true;

/** The 1200×630 social image, rasterized from src/assets/og.svg (text as outlines). */
export const GET: APIRoute = () => {
  const svg = readFileSync(join(process.cwd(), "src/assets/og.svg"), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
};
