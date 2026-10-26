/** Site-wide constants. One place to change links and names. */
import cli from "../../../cli/package.json";

export const SITE_URL = "https://tray.sh";
export const SITE_NAME = "Tray";
export const TAGLINE = "Artifacts for every agent.";
export const MOTTO = "Put it on a tray. Pass it around.";
/** The project version (SPEC §6: one version, set in apps/cli/package.json). */
export const VERSION = `v${cli.version}`;
export const GITHUB_URL = "https://github.com/siddharthborderwala/tray";
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const SECURITY_URL = `${GITHUB_URL}/security/advisories/new`;
export const DESCRIPTION =
  "Tray turns a folder, a file or a few files into a link you can share. Open source and self-hosted on your own Cloudflare account. For you, your agents and your friends.";

/** Footer "Made with ♥ by Sid ↗". */
export const AUTHOR_NAME = "Sid";
export const AUTHOR_URL = "https://x.com/sidborderwala";

/** Docs pages, in sidebar order. `id` is the content entry (src/content/docs/<id>.md). */
export const PAGES = [
  { id: "index", label: "Home", href: "/" },
  { id: "agents", label: "Agents", href: "/agents" },
  { id: "cli", label: "CLI", href: "/cli" },
  { id: "api", label: "API", href: "/api" },
  { id: "troubleshooting", label: "Troubleshooting", href: "/troubleshooting" },
] as const;

/** Linked from the footer only. */
export const FOOTER_PAGES = [
  { id: "about", label: "About", href: "/about" },
  { id: "contact", label: "Contact", href: "/contact" },
  { id: "privacy", label: "Privacy", href: "/privacy" },
] as const;

export const ALL_PAGES = [...PAGES, ...FOOTER_PAGES];

/** `/` → `/index.md`, `/cli` → `/cli.md`. */
export const markdownHref = (id: string) => `/${id}.md`;
