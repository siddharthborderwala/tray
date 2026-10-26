import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/**
 * The docs pages. Each Markdown file is rendered as a page and also served
 * as-is (lightly cleaned) at /<id>.md and inside /llms.txt.
 */
const docs = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/docs" }),
  schema: z.object({
    /** Page heading (h1). */
    title: z.string(),
    /** Line under the heading; also the meta description. */
    description: z.string(),
    /** Optional extra line under the description (API page). */
    note: z.string().optional(),
  }),
});

export const collections = { docs };
