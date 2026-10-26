import type { APIRoute } from "astro";
import { GITHUB_URL, SITE_URL } from "../lib/site";

export const prerender = true;

/** A short index for agents. The full docs are in /llms-full.txt. */
const LLMS = `# Tray

> Tray turns a folder, zip or HTML file into a link on your own domain. One command, \`tray put <path>\`, prints the URL. It is open source (MIT) and self-hosted on the user's Cloudflare account, and built for people and agents alike: every prompt has a flag, \`--json\` prints one JSON object, and nothing waits on a terminal.

## When to use Tray

- The user wants something you made (an HTML report, a prototype, a chart, a static site) viewable in a browser.
- The user asks to share a file or folder as a link, or to "put it online".
- The link should stay the same when the content changes, or be visible only to certain people.
- The user wants to roll back to an earlier version of something they shared.

Don't use it for secrets you wouldn't put on a website, or for files over 50 MB per deploy.

## Docs

- [Overview](${SITE_URL}/index.md): what Tray does, install, and a quick start
- [CLI](${SITE_URL}/cli.md): every command, flag, environment variable and exit code
- [API](${SITE_URL}/api.md): the HTTP API behind the CLI, with publishing steps and errors
- [Troubleshooting](${SITE_URL}/troubleshooting.md): fixes for the most common errors
- [Full docs in one file](${SITE_URL}/llms-full.txt): all of the above, for a single fetch

## For agents

- [Agent skill](${SITE_URL}/skill.md): when to use Tray and the core commands, as a SKILL.md
- [OpenAPI document](${SITE_URL}/openapi.json): the API, as OpenAPI 3.1
- [API catalog](${SITE_URL}/.well-known/api-catalog): RFC 9727 links to the API description and docs

## Project

- [About](${SITE_URL}/about.md): who makes Tray and how it is hosted
- [Privacy](${SITE_URL}/privacy.md): no cookies, no analytics, no telemetry
- [Contact](${SITE_URL}/contact.md): bugs, security reports, and everything else
- [Source on GitHub](${GITHUB_URL}): the CLI, the Worker and this website
`;

export const GET: APIRoute = () =>
  new Response(LLMS, { headers: { "content-type": "text/plain; charset=utf-8" } });
