// The few HTML pages the Worker renders: the Tray 404 page and /approve.
// Plain: JetBrains Mono (served by the Worker at FONT_PATH), square corners,
// colors from @tray-sh/theme (light or dark, by the visitor's OS setting).
// hono/jsx escapes every value; only our own constants (CSS, the mark) are raw.
import { themeColors, themeCss } from "@tray-sh/theme";
import type { Child } from "hono/jsx";
import { markSvg } from "./mark.ts";

/** Where every host of the tray serves the pages' font. Named by content hash, so it can be cached forever. */
export const FONT_PATH = "/.tray/font-18be452724.woff2";

/**
 * Sent with every page the Worker renders. The approve page mints API keys
 * with one click, and every site shares the tray's registrable domain, so no
 * page of ours may be framed (clickjacking).
 */
export const PAGE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
} as const;

/** For the few strings still built by hand (the toolbar's script tag). */
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const CSS = `
@font-face { font-family: "JetBrains Mono"; src: url("${FONT_PATH}") format("woff2"); font-weight: 100 800; font-display: swap; }
${themeCss()}
* { box-sizing: border-box; border-radius: 0; }
body { margin: 0; min-height: 100vh; background: var(--tray-background); color: var(--tray-foreground);
  font: 15px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
main { width: 100%; max-width: 440px; }
.mark { display: block; margin: 0 0 32px; color: var(--tray-foreground); }
.mark svg { display: block; }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 16px; }
a { color: var(--tray-accent); }
::selection { background: var(--tray-selection); color: var(--tray-selection-foreground); }
:focus-visible { outline: 1.5px solid var(--tray-accent); outline-offset: 3px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 24px; }
dt { color: var(--tray-muted-foreground); } dd { margin: 0; overflow-wrap: anywhere; }
code { background: var(--tray-muted); padding: 1px 5px; }
form { display: flex; gap: 8px; flex-wrap: wrap; }
input, button { font: inherit; padding: 8px 14px; border: 1px solid var(--tray-border-strong); background: transparent; color: var(--tray-foreground); }
input { flex: 1; min-width: 0; text-transform: uppercase; }
button { cursor: pointer; }
button.primary { background: var(--tray-accent); border-color: var(--tray-accent); color: var(--tray-accent-foreground); }
.foot { margin-top: 32px; color: var(--tray-muted-foreground); }
`;

function Page({ title, children }: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        {themeColors.map((t) => (
          <meta name="theme-color" content={t.content} media={t.media} />
        ))}
        <link rel="preload" href={FONT_PATH} as="font" type="font/woff2" crossorigin="" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main>
          <p class="mark" dangerouslySetInnerHTML={{ __html: markSvg("var(--tray-accent)") }} />
          {children}
        </main>
      </body>
    </html>
  );
}

const render = (node: Child) => `<!doctype html>\n${String(node)}\n`;

/**
 * The Tray 404 page. Identical for a missing site, a private site without
 * sign-in, and a signed-in visitor who isn't on the share list.
 */
export function notFoundPage(next: string, email: string | null) {
  return render(
    <Page title="Not found">
      <h1>Nothing here</h1>
      <p>This page doesn't exist, or you don't have access to it.</p>
      <p>
        <a href={`/.tray/signin?next=${encodeURIComponent(next)}`}>Sign in to view</a>
      </p>
      {email && (
        <p class="foot">
          Signed in as {email} · <a href="/.tray/signout">Sign out</a>
        </p>
      )}
    </Page>,
  );
}

/** `tray.<domain>/`: the API host has no site, so say what it is. */
export function apiHomePage(domain: string) {
  return render(
    <Page title={`Tray on ${domain}`}>
      <h1>Tray on {domain}</h1>
      <p>
        This is the API for the tray on {domain}. Sites live at <code>{`<name>.${domain}`}</code>.
      </p>
      <p>
        <a href="/approve">Approve a login</a> · <a href="/v1/openapi.json">OpenAPI</a> ·{" "}
        <a href="https://tray.sh/api">API docs</a>
      </p>
    </Page>,
  );
}

export function messagePage(title: string, message: string) {
  return render(
    <Page title={title}>
      <h1>{title}</h1>
      <p>{message}</p>
    </Page>,
  );
}

export function approveCodeForm() {
  return render(
    <Page title="Approve a login">
      <h1>Approve a login</h1>
      <p>Enter the code shown in your terminal.</p>
      <form method="get" action="/approve">
        <input name="code" placeholder="QXFT-7K2M" autocomplete="off" autofocus required />
        <button class="primary" type="submit">
          Continue
        </button>
      </form>
    </Page>,
  );
}

export function approveDetails(opts: {
  userCode: string;
  name: string;
  ip: string;
  expiresAt: string;
  email: string;
}) {
  return render(
    <Page title="Approve a login">
      <h1>Approve this login?</h1>
      <dl>
        <dt>code</dt>
        <dd>{opts.userCode}</dd>
        <dt>device</dt>
        <dd>{opts.name}</dd>
        <dt>ip</dt>
        <dd>{opts.ip}</dd>
        <dt>as</dt>
        <dd>{opts.email}</dd>
      </dl>
      <p>
        Only approve if you just ran <code>tray login</code>.
      </p>
      <form method="post" action="/approve">
        <input type="hidden" name="code" value={opts.userCode} />
        <button class="primary" type="submit" name="action" value="approve">
          Approve
        </button>
        <button type="submit" name="action" value="deny">
          Deny
        </button>
      </form>
    </Page>,
  );
}
