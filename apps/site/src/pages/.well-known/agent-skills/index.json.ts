import type { APIRoute } from "astro";
import { skillsIndex } from "../../../lib/discovery";

export const prerender = true;

export const GET: APIRoute = () => skillsIndex();
