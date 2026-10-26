import type { APIRoute } from "astro";
import { markdownResponse } from "../lib/agent-md";
import { skillText } from "../lib/skill";

export const prerender = true;

/** The agent skill, served verbatim. */
export const GET: APIRoute = () => markdownResponse(skillText());
