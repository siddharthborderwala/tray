// The index pages Tray adds when a put has no /index.html: one file opens
// directly; several get a file list at the root and in every folder without
// its own index.html (folders first, with breadcrumbs back up). Rendered with
// hono/jsx, which escapes every value; only our own constants are raw.
import { themeColors, themeCss } from "@tray-sh/theme";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { markSvg } from "@tray-sh/worker/mark";
import { FONT_PATH } from "@tray-sh/worker/pages";
import type { SiteFile } from "./collect.ts";
import { ICONS, type IconName } from "./file-icons.ts";
import { formatBytes, plural } from "./format.ts";

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

const Icon = ({ name }: { name: IconName }) => (
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {raw(ICONS[name])}
  </svg>
);

const CSS = `
@font-face{font-family:"JetBrains Mono";src:url("${FONT_PATH}") format("woff2");font-weight:100 800;font-display:swap}
${themeCss()}
*{box-sizing:border-box}
body{margin:0;padding:64px 16px;background:var(--tray-background);color:var(--tray-foreground);font:14px/20px "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.03em}
main{max-width:640px;margin:0 auto}
.mark{display:block;color:var(--tray-foreground);width:62px}
.mark svg{display:block}
header{padding:32px 0 24px;display:flex;flex-direction:column;gap:6px}
h1{margin:0;font-size:15px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
h1 a{color:var(--tray-accent);font-weight:400}
h1 .sep{color:var(--tray-muted-foreground);font-weight:400}
.meta{font-size:13px;color:var(--tray-muted-foreground)}
ul{list-style:none;margin:0;padding:0}
li+li{border-top:1px solid var(--tray-border)}
li a{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 0;color:inherit;text-decoration:none}
.icon{flex-shrink:0;color:var(--tray-muted-foreground)}
.dir .icon{color:var(--tray-foreground)}
.name{flex:1;min-width:0;overflow-wrap:anywhere}
.dir .name{font-weight:600}
.size{flex-shrink:0;font-size:13px;color:var(--tray-muted-foreground);text-align:right}
li a:hover .name,li a:focus-visible .name{color:var(--tray-accent);text-decoration:underline}
a:focus-visible{outline:2px solid var(--tray-accent);outline-offset:2px}
`;

function Page({ title, head, children }: { title: string; head?: Child; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {themeColors.map((t) => (
          <meta name="theme-color" content={t.content} media={t.media} />
        ))}
        <title>{title}</title>
        {head}
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const enc = new TextEncoder();
const render = (node: Child): Uint8Array => enc.encode(`<!doctype html>\n${String(node)}\n`);

/** One file: send the root straight to it, so the browser's own viewer opens a PDF or image. */
function redirectPage(file: SiteFile): Uint8Array {
  const url = href(file.path);
  const name = file.path.slice(1);
  return render(
    <Page title={name} head={<meta http-equiv="refresh" content={`0; url=${url}`} />}>
      <main>
        <a href={url}>{name}</a>
      </main>
    </Page>,
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

const Sep = () => <span class="sep"> / </span>;

function listPage(dir: string, folder: Folder, title: string): Uint8Array {
  const parts = dir.split("/").filter(Boolean);
  const name = parts.at(-1) ?? title;
  // In a folder, the heading is the path back up: each ancestor links, the folder itself doesn't.
  const heading = parts.length ? (
    <>
      <a href="/">{title}</a>
      {parts.slice(0, -1).map((p, i) => (
        <>
          <Sep />
          <a href={href("/" + parts.slice(0, i + 1).join("/") + "/")}>{p}</a>
        </>
      ))}
      <Sep />
      {name}
    </>
  ) : (
    name
  );

  const counts = [
    folder.folders.size ? plural(folder.folders.size, "folder") : "",
    folder.files.length ? plural(folder.files.length, "file") : "",
    formatBytes(folder.bytes),
  ].filter(Boolean);

  return render(
    <Page title={parts.length ? `${name} · ${title}` : title}>
      <main>
        <a
          class="mark"
          href="/"
          aria-label={title}
          dangerouslySetInnerHTML={{ __html: markSvg("var(--tray-accent)") }}
        />
        <header>
          <h1>{heading}</h1>
          <div class="meta">{counts.join(" · ")}</div>
        </header>
        <ul>
          {[...folder.folders]
            .sort(([a], [b]) => byName(a, b))
            .map(([sub, { files }]) => (
              <li class="dir">
                <a href={href(dir + sub + "/")}>
                  <Icon name="folder" />
                  <span class="name">{sub}/</span>
                  <span class="size">{plural(files, "file")}</span>
                </a>
              </li>
            ))}
          {[...folder.files]
            .sort((a, b) => byName(a.path, b.path))
            .map((f) => {
              const base = f.path.slice(dir.length);
              return (
                <li>
                  <a href={href(f.path)}>
                    <Icon name={iconFor(base)} />
                    <span class="name">{base}</span>
                    <span class="size">{formatBytes(f.data.length)}</span>
                  </a>
                </li>
              );
            })}
        </ul>
      </main>
    </Page>,
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
