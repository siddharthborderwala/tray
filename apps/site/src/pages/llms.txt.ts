import type { APIRoute } from "astro";
import { cleanBody, orderedDocs } from "../lib/agent-md";
import { GITHUB_URL, MOTTO, PAGES, SITE_URL, TAGLINE } from "../lib/site";

/** Push every Markdown heading down one level (outside code fences). */
function demote(md: string): string {
  let fenced = false;
  return md
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      return !fenced && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

/** The full docs as one Markdown file, for agents. */
export const GET: APIRoute = async () => {
  const docs = await orderedDocs();
  const parts = [
    "# Tray",
    "",
    `> ${TAGLINE} ${MOTTO}`,
    "",
    "Tray turns a folder, zip or HTML file into a URL on your own domain. It is self-hosted on your Cloudflare account (one Worker, one R2 bucket) and built for people and agents alike.",
    "",
    `- Docs: ${SITE_URL}`,
    `- Agent skill: ${SITE_URL}/skill.md`,
    `- Source: ${GITHUB_URL}`,
    "",
  ];
  for (const doc of docs) {
    const page = PAGES.find((p) => p.id === doc.id);
    const title = doc.id === "index" ? "Overview" : doc.data.title;
    parts.push(`## ${title}`, "");
    if (doc.id !== "index") parts.push(doc.data.description, "");
    if (doc.data.note) parts.push(doc.data.note, "");
    if (page) parts.push(`Page: ${SITE_URL}${page.href}`, "");
    parts.push(demote(cleanBody(doc.body ?? "")), "");
  }
  return new Response(parts.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
