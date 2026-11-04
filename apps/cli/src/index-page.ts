// The index pages Tray adds when a put has no /index.html: one file opens
// directly; several get a file list at the root and in every folder without
// its own index.html (folders first, with breadcrumbs back up).
import { markSvg } from "@tray-sh/worker/mark";
import { FONT_PATH } from "@tray-sh/worker/pages";
import type { SiteFile } from "./collect.ts";
import { ICONS, type IconName } from "./file-icons.ts";
import { formatBytes, plural } from "./format.ts";

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

const ICON_BY_EXT: Record<string, IconName> = {
  html: "file-type-html",
  htm: "file-type-html",
  pdf: "file-type-pdf",
  png: "file-type-png",
  jpg: "file-type-jpg",
  jpeg: "file-type-jpg",
  svg: "file-type-svg",
  gif: "photo",
  webp: "photo",
  avif: "photo",
  ico: "photo",
  md: "markdown",
  markdown: "markdown",
  txt: "file-type-txt",
  log: "file-type-txt",
  json: "json",
  csv: "file-type-csv",
  tsv: "file-type-csv",
  xls: "file-type-xls",
  xlsx: "file-type-xls",
  css: "file-type-css",
  js: "file-type-js",
  mjs: "file-type-js",
  cjs: "file-type-js",
  ts: "file-type-ts",
  jsx: "file-type-jsx",
  tsx: "file-type-tsx",
  zip: "file-zip",
  gz: "file-zip",
  tgz: "file-zip",
  tar: "file-zip",
  mp4: "movie",
  mov: "movie",
  webm: "movie",
  mp3: "file-music",
  wav: "file-music",
  ogg: "file-music",
  m4a: "file-music",
  flac: "file-music",
  woff: "typography",
  woff2: "typography",
  ttf: "typography",
  otf: "typography",
  ppt: "presentation",
  pptx: "presentation",
  key: "presentation",
  doc: "file-type-doc",
  docx: "file-type-doc",
};

function iconFor(name: string): IconName {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && ICON_BY_EXT[name.slice(dot + 1).toLowerCase()]) || "file";
}

const icon = (name: IconName) =>
  `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

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
:root{color-scheme:light dark;--paper:#faf9f0;--ink:#242424;--gray:#5a5a5a;--line:#dddbd0;--blue:#356be5}
@media (prefers-color-scheme:dark){:root{--paper:#1b1b1b;--ink:#e8e8e2;--gray:#a3a39b;--line:#34342f;--blue:#7b9bff}}
*{box-sizing:border-box}
body{margin:0;padding:64px 16px;background:var(--paper);color:var(--ink);font:14px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.03em}
main{max-width:640px;margin:0 auto}
.mark{display:block;color:var(--ink);width:62px}
.mark svg{display:block}
header{padding:32px 0 24px;display:flex;flex-direction:column;gap:6px}
h1{margin:0;font-size:15px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
h1 a{color:var(--blue);font-weight:400}
h1 .sep{color:var(--gray);font-weight:400}
.meta{font-size:13px;color:var(--gray)}
ul{list-style:none;margin:0;padding:0}
li+li{border-top:1px solid var(--line)}
li a{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 0;color:inherit;text-decoration:none}
.icon{flex-shrink:0;color:var(--gray)}
.dir .icon{color:var(--ink)}
.name{flex:1;min-width:0;overflow-wrap:anywhere}
.dir .name{font-weight:600}
.size{flex-shrink:0;font-size:13px;color:var(--gray);text-align:right}
li a:hover .name,li a:focus-visible .name{color:var(--blue);text-decoration:underline}
a:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
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

interface Folder {
  folders: Map<string, { files: number; bytes: number }>;
  files: SiteFile[];
  bytes: number;
}

/** What sits directly in each folder (`/`, `/a/`, `/a/b/`), with totals for subfolders. */
function folders(files: SiteFile[]): Map<string, Folder> {
  const out = new Map<string, Folder>();
  const at = (dir: string) => {
    let f = out.get(dir);
    if (!f) out.set(dir, (f = { folders: new Map(), files: [], bytes: 0 }));
    return f;
  };
  for (const file of files) {
    const parts = file.path.split("/").slice(1, -1);
    let dir = "/";
    at(dir).bytes += file.data.length;
    for (const part of parts) {
      const sub = at(dir).folders.get(part) ?? { files: 0, bytes: 0 };
      sub.files++;
      sub.bytes += file.data.length;
      at(dir).folders.set(part, sub);
      dir += part + "/";
      at(dir).bytes += file.data.length;
    }
    at(dir).files.push(file);
  }
  return out;
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function listPage(dir: string, folder: Folder, title: string): Uint8Array {
  const parts = dir.split("/").filter(Boolean);
  const name = parts.at(-1) ?? title;
  // In a folder, the heading is the path back up: each ancestor links, the folder itself doesn't.
  const sep = `<span class="sep"> / </span>`;
  const heading = parts.length
    ? [
        `<a href="/">${esc(title)}</a>`,
        ...parts
          .slice(0, -1)
          .map(
            (p, i) =>
              `<a href="${esc(href("/" + parts.slice(0, i + 1).join("/") + "/"))}">${esc(p)}</a>`,
          ),
        esc(name),
      ].join(sep)
    : esc(name);

  const rows = [
    ...[...folder.folders]
      .sort(([a], [b]) => byName(a, b))
      .map(
        ([sub, { files }]) =>
          `<li class="dir"><a href="${esc(href(dir + sub + "/"))}">${icon("folder")}<span class="name">${esc(sub)}/</span><span class="size">${plural(files, "file")}</span></a></li>`,
      ),
    ...[...folder.files]
      .sort((a, b) => byName(a.path, b.path))
      .map((f) => {
        const base = f.path.slice(dir.length);
        return `<li><a href="${esc(href(f.path))}">${icon(iconFor(base))}<span class="name">${esc(base)}</span><span class="size">${formatBytes(f.data.length)}</span></a></li>`;
      }),
  ];

  const counts = [
    folder.folders.size ? plural(folder.folders.size, "folder") : "",
    folder.files.length ? plural(folder.files.length, "file") : "",
    formatBytes(folder.bytes),
  ].filter(Boolean);

  return page(
    `<title>${esc(parts.length ? `${name} · ${title}` : title)}</title>`,
    `<main>
<a class="mark" href="/" aria-label="${esc(title)}">${markSvg()}</a>
<header>
<h1>${heading}</h1>
<div class="meta">${counts.join(" · ")}</div>
</header>
<ul>
${rows.join("\n")}
</ul>
</main>`,
  );
}

/**
 * The files plus generated index pages when there's no `/index.html`, so the
 * site root never 404s: a redirect for one file, otherwise a list at `/` and
 * in each folder that has no `index.html` of its own. `title` heads the root
 * list (the site's default name).
 */
export function withIndex(files: SiteFile[], title = "Files"): SiteFile[] {
  if (files.length === 0 || files.some((f) => f.path === "/index.html")) return files;
  const type = "text/html;charset=utf-8";
  if (files.length === 1)
    return [...files, { path: "/index.html", data: redirectPage(files[0]!), type }];
  const have = new Set(files.map((f) => f.path));
  const pages: SiteFile[] = [];
  for (const [dir, folder] of folders(files)) {
    if (have.has(dir + "index.html")) continue;
    pages.push({ path: dir + "index.html", data: listPage(dir, folder, title), type });
  }
  return [...files, ...pages];
}
