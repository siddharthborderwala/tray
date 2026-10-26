// The /index.html Tray adds when a put has none: one file opens directly, several
// get a plain page that lists them (images shown inline).
import { FONT_PATH } from "@tray-sh/worker/pages";
import type { SiteFile } from "./collect.ts";

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * `/My Photos/a b.png` → `/My%20Photos/a%20b.png`. Root-absolute so links hold under --spa
 * (any path serves this page); `'` is encoded too, since a leading quote would end a meta refresh URL.
 */
const href = (path: string) =>
  path
    .split("/")
    .map((s) => encodeURIComponent(s).replaceAll("'", "%27"))
    .join("/");

const enc = new TextEncoder();
const page = (head: string, body: string): Uint8Array =>
  enc.encode(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
<style>
@font-face{font-family:"JetBrains Mono";src:url("${FONT_PATH}") format("woff2");font-weight:100 800;font-display:swap}
:root{color-scheme:light dark}
body{margin:0;padding:48px 24px;font:15px/1.5 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:#faf9f0;color:#242424}
main{max-width:960px;margin:0 auto}
h1{font-size:15px;font-weight:600;margin:0 0 24px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:24px}
ul.grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
a{color:#356be5;text-decoration:none;overflow-wrap:anywhere}
a:hover{text-decoration:underline}
img{display:block;width:100%;height:auto;margin-bottom:8px;background:#ecebe3}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#e8e8e2}a{color:#7b9bff}img{background:#2a2a2a}}
</style>
</head>
<body>
${body}
</body>
</html>
`);

/** One file: send the root straight to it, so the browser's own viewer opens a PDF or image. */
function redirectPage(file: SiteFile): Uint8Array {
  const url = esc(href(file.path));
  const name = esc(file.path.slice(1));
  return page(
    `<title>${name}</title>\n<meta http-equiv="refresh" content="0; url=${url}">`,
    `<main><a href="${url}">${name}</a></main>`,
  );
}

/** Several files: a list, with images shown inline. */
function listPage(files: SiteFile[], title: string): Uint8Array {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const images = new Set(sorted.filter((f) => IMAGE.test(f.type.split(";")[0]!)));
  const items = sorted.map((f) => {
    const url = esc(href(f.path));
    const name = esc(f.path.slice(1));
    const img = images.has(f) ? `<img src="${url}" alt="" loading="lazy">` : "";
    return `<li><a href="${url}">${img}${name}</a></li>`;
  });
  const grid = images.size > sorted.length / 2 ? ' class="grid"' : "";
  return page(
    `<title>${esc(title)}</title>`,
    `<main>\n<h1>${esc(title)}</h1>\n<ul${grid}>\n${items.join("\n")}\n</ul>\n</main>`,
  );
}

/**
 * The files plus a generated `/index.html` when they have none, so the site
 * root never 404s. `title` heads the list page (the site's default name).
 */
export function withIndex(files: SiteFile[], title = "Files"): SiteFile[] {
  if (files.length === 0 || files.some((f) => f.path === "/index.html")) return files;
  const data = files.length === 1 ? redirectPage(files[0]!) : listPage(files, title);
  return [...files, { path: "/index.html", data, type: "text/html;charset=utf-8" }];
}
