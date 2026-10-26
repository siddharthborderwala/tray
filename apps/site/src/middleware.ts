import { getEntry } from "astro:content";
import { defineMiddleware } from "astro:middleware";
import { pageMarkdown } from "./lib/agent-md";
import { ALL_PAGES, SITE_URL } from "./lib/site";

const MARKDOWN = "text/markdown; charset=utf-8";

/** Advertised on the homepage, for crawlers and agents. */
const HOME_LINKS = [
  '</sitemap.xml>; rel="sitemap"',
  '</index.md>; rel="alternate"; type="text/markdown"',
  '</llms.txt>; rel="describedby"',
  '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
].join(", ");

const NOT_FOUND = `# Not found

Nothing on this tray at that path.

- [Docs index for agents](${SITE_URL}/llms.txt)
- [Full docs in one file](${SITE_URL}/llms-full.txt)
- [Sitemap](${SITE_URL}/sitemap.xml)
- [Overview](${SITE_URL}/index.md), [CLI](${SITE_URL}/cli.md), [API](${SITE_URL}/api.md), [Troubleshooting](${SITE_URL}/troubleshooting.md)
`;

const wantsMarkdown = (request: Request) =>
  (request.headers.get("accept") ?? "").toLowerCase().includes("text/markdown");

/**
 * Content negotiation for the pages: `Accept: text/markdown` gets the page's
 * Markdown (the same as /<page>.md), and an unknown path gets a Markdown 404.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered) return next();

  const path = context.url.pathname.replace(/\/+$/, "") || "/";
  const page = ALL_PAGES.find((p) => p.href === path);

  if (wantsMarkdown(context.request)) {
    const doc = page && (await getEntry("docs", page.id));
    const headers = { "content-type": MARKDOWN, vary: "accept" };
    if (doc) return new Response(pageMarkdown(doc), { headers });
    return new Response(NOT_FOUND, { status: 404, headers });
  }

  const response = await next();
  if (page) response.headers.append("vary", "accept");
  if (path === "/") response.headers.set("link", HOME_LINKS);
  return response;
});
