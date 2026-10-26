import type { APIRoute } from "astro";
import { SITE_URL } from "../lib/site";

export const prerender = true;

/** Search and answer engines are welcome, by name, and so is everyone else. */
const AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "*",
];

export const GET: APIRoute = () => {
  const groups = AGENTS.map((a) => `User-agent: ${a}\nAllow: /`).join("\n\n");
  return new Response(`${groups}\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
