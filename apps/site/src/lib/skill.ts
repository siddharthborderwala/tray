import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent skill served at /skill.md. The repo's skills/tray/SKILL.md is the
 * source of truth and is served verbatim; this fallback is only used until it
 * exists.
 */
const FALLBACK = `---
name: tray
description: Share an HTML artifact, report, prototype or folder as a link. Use when the user wants something you made viewable in a browser or passed to someone else, e.g. "share this", "give me a link", "put it online".
---

# Tray

Tray turns a folder, \`.zip\`, \`.tar.gz\` or single HTML file into a URL on the user's own domain.

## Use

\`\`\`sh
tray put ./out --json            # publish; prints {"site","url","visibility","deploy",...}
tray put ./out --private --json  # only the owner can see it
tray put ./out -s q3-review      # choose the site name (default: folder or file name)
tray share q3-review bob@acme.com @acme.com   # let people see a private site
\`\`\`

- Give the user the \`url\` from the JSON. Putting the same path again updates the same link.
- Never prompts without a TTY. Pass \`--yes\` for confirmations, \`--replace\` to take over a name put from elsewhere.
- Auth: a saved login, or \`TRAY_API_KEY\` (make one with \`tray key create\`). Pick a tray with \`--domain\` or \`TRAY_DOMAIN\`.
- Not installed? \`curl -fsSL tray.sh/install | sh\` or \`npm i -g @tray-sh/cli\`.

## Exit codes

- \`0\` done · \`1\` failed (network, server, conflict) · \`2\` bad usage or missing input
- \`4\` not logged in or not allowed · \`130\` cancelled
- With \`--json\`, errors are \`{"error","code","hint"}\`; follow the \`hint\`.

Full docs: https://tray.sh/llms.txt
`;

const SOURCE = join(process.cwd(), "../../skills/tray/SKILL.md");

export function skillText(): string {
  return existsSync(SOURCE) ? readFileSync(SOURCE, "utf8") : FALLBACK;
}

/** `description:` from the skill's frontmatter (plain, quoted, or a `>`/`|` block). */
export function skillDescription(text = skillText()): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const lines = front.split("\n");
  const i = lines.findIndex((l) => l.startsWith("description:"));
  if (i < 0) return "";
  const value = (lines[i] ?? "").slice("description:".length).trim();
  if (!/^[>|][+-]?$/.test(value)) return value.replace(/^["']|["']$/g, "");
  const block: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return (value.startsWith(">") ? block.join(" ") : block.join("\n")).trim();
}

/** sha256 of the exact bytes served at /skill.md. */
export function skillDigest(text = skillText()): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
