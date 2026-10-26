import type { APIRoute } from "astro";
import { markdownResponse } from "../lib/agent-md";
import { SITE_URL } from "../lib/site";

/** A short agent skill. Details live in /llms.txt. */
const SKILL = `---
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

Full docs: ${SITE_URL}/llms.txt
`;

export const GET: APIRoute = () => markdownResponse(SKILL);
