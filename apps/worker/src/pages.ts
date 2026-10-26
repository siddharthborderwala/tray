// The few HTML pages the Worker renders: the Tray 404 page and /approve.
// Plain: system mono, paper background, ink text, blue accents, square corners.

/**
 * Sent with every page the Worker renders. The approve page mints API keys
 * with one click, and every site shares the tray's registrable domain, so no
 * page of ours may be framed (clickjacking).
 */
export const PAGE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
} as const;

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function page(title: string, content: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { --paper: #FAF9F0; --ink: #242424; --blue: #356BE5; }
* { box-sizing: border-box; border-radius: 0; }
body { margin: 0; min-height: 100vh; background: var(--paper); color: var(--ink);
  font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
main { width: 100%; max-width: 440px; }
.mark { display: inline-flex; align-items: flex-end; gap: 3px; font-size: 28px; line-height: 24px; font-weight: 700; letter-spacing: -0.1em; margin: 0 0 32px; }
.mark i { width: 5px; height: 5px; border-radius: 1px; background: var(--blue); }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 16px; }
a { color: var(--blue); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 24px; }
dt { opacity: .6; } dd { margin: 0; overflow-wrap: anywhere; }
form { display: flex; gap: 8px; flex-wrap: wrap; }
input, button { font: inherit; padding: 8px 14px; border: 1px solid var(--ink); background: transparent; color: var(--ink); }
input { flex: 1; min-width: 0; text-transform: uppercase; }
button { cursor: pointer; }
button.primary { background: var(--blue); border-color: var(--blue); color: var(--paper); }
.foot { margin-top: 32px; opacity: .7; }
</style>
</head>
<body><main><p class="mark">tray<i aria-hidden="true"></i></p>
${content}
</main></body>
</html>
`;
}

/**
 * The Tray 404 page. Identical for a missing site, a private site without
 * sign-in, and a signed-in visitor who isn't on the share list.
 */
export function notFoundPage(next: string, email: string | null) {
  const signin = `/.tray/signin?next=${encodeURIComponent(next)}`;
  const who = email
    ? `<p class="foot">Signed in as ${escapeHtml(email)} · <a href="/cdn-cgi/access/logout">Sign out</a></p>`
    : "";
  return page(
    "Not found",
    `<h1>Nothing here</h1>
<p>This page doesn't exist, or you don't have access to it.</p>
<p><a href="${escapeHtml(signin)}">Sign in to view</a></p>
${who}`,
  );
}

/** `tray.<domain>/`: the API host has no site, so say what it is. */
export function apiHomePage(domain: string) {
  const d = escapeHtml(domain);
  return page(
    `Tray on ${d}`,
    `<h1>Tray on ${d}</h1>
<p>This is the API for the tray on ${d}. Sites live at <code>&lt;name&gt;.${d}</code>.</p>
<p><a href="/approve">Approve a login</a> · <a href="/v1/openapi.json">OpenAPI</a> · <a href="https://tray.sh/api">API docs</a></p>`,
  );
}

export function messagePage(title: string, message: string) {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}

export function approveCodeForm() {
  return page(
    "Approve a login",
    `<h1>Approve a login</h1>
<p>Enter the code shown in your terminal.</p>
<form method="get" action="/approve">
<input name="code" placeholder="QXFT-7K2M" autocomplete="off" autofocus required>
<button class="primary" type="submit">Continue</button>
</form>`,
  );
}

export function approveDetails(opts: {
  userCode: string;
  name: string;
  ip: string;
  expiresAt: string;
  email: string;
}) {
  const code = escapeHtml(opts.userCode);
  return page(
    "Approve a login",
    `<h1>Approve this login?</h1>
<dl>
<dt>code</dt><dd>${code}</dd>
<dt>device</dt><dd>${escapeHtml(opts.name)}</dd>
<dt>ip</dt><dd>${escapeHtml(opts.ip)}</dd>
<dt>as</dt><dd>${escapeHtml(opts.email)}</dd>
</dl>
<p>Only approve if you just ran <code>tray login</code>.</p>
<form method="post" action="/approve">
<input type="hidden" name="code" value="${code}">
<button class="primary" type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</form>`,
  );
}
