import { getCollection, type CollectionEntry } from "astro:content";
import { ALL_PAGES, MOTTO, SITE_URL, TAGLINE, markdownHref } from "./site";

type Doc = CollectionEntry<"docs">;

/**
 * The Markdown we serve to agents: the page source, with our fence meta
 * (tabs, response, title) turned back into plain Markdown and links made
 * absolute.
 */
export function cleanBody(body: string): string {
  return body
    .replace(/^```(\w+)([^\n]*)$/gm, (_all, lang: string, meta: string) => {
      const title = /title="([^"]*)"/.exec(meta)?.[1];
      return title ? `${title}:\n\n\`\`\`${lang}` : `\`\`\`${lang}`;
    })
    .replace(/\]\(\//g, `](${SITE_URL}/`)
    .trim();
}

export function pageMarkdown(doc: Doc): string {
  const page = ALL_PAGES.find((p) => p.id === doc.id);
  // The Overview's h1 is the tagline; in Markdown it is titled "Tray".
  const overview = doc.id === "index";
  const heading = overview ? "Tray" : doc.data.title;
  const quote = overview ? `${TAGLINE} ${MOTTO}` : doc.data.description;
  const lines = [`# ${heading}`, "", `> ${quote}`, ""];
  if (doc.data.note) lines.push(doc.data.note, "");
  if (page)
    lines.push(
      `Source: ${SITE_URL}${page.href} · Markdown: ${SITE_URL}${markdownHref(doc.id)}`,
      "",
    );
  lines.push(cleanBody(doc.body ?? ""), "");
  return lines.join("\n");
}

/** All docs pages, in sidebar order. */
export async function orderedDocs(): Promise<Doc[]> {
  const docs = await getCollection("docs");
  return ALL_PAGES.map((p) => {
    const doc = docs.find((d) => d.id === p.id);
    if (!doc) throw new Error(`missing src/content/docs/${p.id}.md`);
    return doc;
  });
}

export const markdownResponse = (text: string) =>
  new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
