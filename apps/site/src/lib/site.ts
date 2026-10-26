/** Site-wide constants. One place to change links and names. */

export const SITE_URL = "https://tray.sh";
export const SITE_NAME = "Tray";
export const TAGLINE = "Artifacts for every agent.";
export const MOTTO = "Put it on a tray. Pass it around.";
export const VERSION = "v0.1.0";
export const GITHUB_URL = "https://github.com/siddharthborderwala/tray";

/** Footer "Made with ♥ by Sid ↗". */
export const AUTHOR_NAME = "Sid";
export const AUTHOR_URL = "https://x.com/sidborderwala";

/** Docs pages, in sidebar order. `id` is the content entry (src/content/docs/<id>.md). */
export const PAGES = [
  { id: "index", label: "Overview", href: "/" },
  { id: "cli", label: "CLI", href: "/cli" },
  { id: "api", label: "API", href: "/api" },
  { id: "troubleshooting", label: "Troubleshooting", href: "/troubleshooting" },
] as const;

export type PageId = (typeof PAGES)[number]["id"];

/** `/` → `/index.md`, `/cli` → `/cli.md`. */
export const markdownHref = (id: string) => `/${id}.md`;
