import type { APIRoute } from "astro";
import { ALL_PAGES, SITE_URL } from "../lib/site";

export const prerender = true;

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = ALL_PAGES.map(
    (p) => `  <url><loc>${SITE_URL}${p.href}</loc><lastmod>${lastmod}</lastmod></url>`,
  ).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
