import type { APIRoute } from "astro";
import { skillsIndex } from "../../../lib/discovery";

export const prerender = true;

/** Legacy location of the skills index. */
export const GET: APIRoute = () => skillsIndex();
