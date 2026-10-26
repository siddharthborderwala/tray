import type { APIRoute, GetStaticPaths } from "astro";
import { getEntry } from "astro:content";
import { markdownResponse, pageMarkdown } from "../lib/agent-md";
import { ALL_PAGES } from "../lib/site";

export const prerender = true;

/** /index.md, /cli.md, /api.md, /troubleshooting.md */
export const getStaticPaths = (() =>
  ALL_PAGES.map((p) => ({ params: { page: p.id } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const doc = await getEntry("docs", params.page ?? "");
  if (!doc) return new Response("Not found", { status: 404 });
  return markdownResponse(pageMarkdown(doc));
};
