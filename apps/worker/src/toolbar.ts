// The toolbar on hosted pages: who's signed in and, for the owner, who has
// access. Read-only. Served on every site host under /.tray/.
import { markSvg } from "./mark.ts";
import { escapeHtml, FONT_PATH } from "./pages.tsx";
import { toolbarBundle } from "../scripts/toolbar.ts" with { type: "macro" };
import type { ToolbarConfig } from "./toolbar-types.ts";

export const ME_PATH = "/.tray/me";

const config: ToolbarConfig = {
  me: ME_PATH,
  font: FONT_PATH,
  signout: "/.tray/signout",
  mark: markSvg("var(--tray-accent)"),
};

/** The browser bundle of toolbar-client.ts, built while compiling (a Bun macro). */
const TOOLBAR_BUNDLE: string = toolbarBundle();

/** The client, with its config bound in a scope of its own. */
export const TOOLBAR_JS = `(()=>{const TRAY_TOOLBAR_CONFIG=${JSON.stringify(config)};${TOOLBAR_BUNDLE}})();\n`;

/** FNV-1a of the script, so its URL changes whenever it does and can be cached forever. */
function version(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const TOOLBAR_VERSION = version(TOOLBAR_JS);
export const TOOLBAR_PATH = `/.tray/toolbar-${TOOLBAR_VERSION}.js`;

const encoder = new TextEncoder();

/**
 * The tag added to HTML pages for signed-in visitors. The URL is absolute
 * (the site's own origin), so a page's `<base href>` can't point it elsewhere.
 * `origin` comes from the request URL of a host that resolved to a site.
 */
export function toolbarTag(origin: string): Uint8Array {
  const src = escapeHtml(origin + TOOLBAR_PATH);
  return encoder.encode(`<script src="${src}" defer></script>`);
}
