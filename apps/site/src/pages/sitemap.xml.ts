import type { APIRoute } from "astro";
import { PAGES, SITE_URL } from "../lib/site";

export const GET: APIRoute = () => {
  const urls = PAGES.map((p) => `  <url><loc>${SITE_URL}${p.href}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
