import type { APIRoute } from "astro";
import { SITE_URL } from "../lib/site";

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
