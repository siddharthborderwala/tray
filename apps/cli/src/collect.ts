// Turn a folder, .zip, .tar.gz, single .html file, or stdin into a flat list of
// files keyed by their path inside the site.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { RESERVED_SITE_NAMES, SITE_NAME_RE } from "@tray-sh/schema";
import { usageError } from "./errors.ts";

export interface SiteFile {
  /** Path inside the site, always starting with `/`. */
  path: string;
  data: Uint8Array;
  type: string;
}

export interface Collected {
  files: SiteFile[];
  /** Slug suggested by the input name, if it makes a valid site name. */
  defaultSite?: string;
  /** Absolute path of the input (or `-` for stdin). Used for name-conflict detection. */
  source: string;
}

const SKIP_NAMES = new Set([".git", ".DS_Store", "node_modules", "__MACOSX"]);

/** Skip `.git`, `.DS_Store`, `node_modules`, `__MACOSX`, and dotfiles except `.well-known`. */
export function shouldSkip(segment: string): boolean {
  if (SKIP_NAMES.has(segment)) return true;
  return segment.startsWith(".") && segment !== ".well-known";
}

/** True if any segment of a relative path should be skipped. */
export function shouldSkipPath(relPath: string): boolean {
  return relPath.split("/").some((s) => s !== "" && shouldSkip(s));
}

export function contentType(path: string): string {
  return Bun.file(path).type || "application/octet-stream";
}

export type InputKind = "stdin" | "folder" | "zip" | "tar.gz" | "html";

export function inputKind(path: string, isDirectory: boolean): InputKind | undefined {
  if (path === "-") return "stdin";
  if (isDirectory) return "folder";
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return undefined;
}

/** `My Report.html` → `my-report`; `site.tar.gz` → `site`. Undefined when no valid name results. */
export function slugify(name: string): string | undefined {
  const stem = name.replace(/\.(tar\.gz|tgz|zip|html?)$/i, "");
  const slug = stem
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (!SITE_NAME_RE.test(slug) || RESERVED_SITE_NAMES.includes(slug)) return undefined;
  return slug;
}

/** Build-output folder names that say nothing about the site. */
export const GENERIC_FOLDER_NAMES = new Set([
  "dist",
  "out",
  "build",
  "public",
  "site",
  "_site",
  "www",
]);

/** `~/work/q3-review/dist` → `q3-review`; `~/work/report.html` → `report`. */
export function defaultSiteName(absPath: string, isDirectory: boolean): string | undefined {
  const name = basename(absPath);
  if (isDirectory && GENERIC_FOLDER_NAMES.has(name.toLowerCase()))
    return slugify(basename(dirname(absPath)));
  return slugify(name);
}

/** If every file lives under one shared top-level folder, drop that folder. */
export function stripSingleTopFolder(files: SiteFile[]): SiteFile[] {
  if (files.length === 0) return files;
  const firstSegments = new Set(files.map((f) => f.path.split("/")[1]));
  const allNested = files.every((f) => f.path.split("/").length > 2);
  if (firstSegments.size !== 1 || !allNested) return files;
  const prefix = "/" + [...firstSegments][0];
  return files.map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

/** Normalize an archive entry name to a site path, or undefined if it must be skipped. */
function archivePath(name: string): string | undefined {
  const unix = name.replaceAll("\\", "/");
  if (unix.endsWith("/")) return undefined; // directory entry
  const rel = posix.normalize(unix);
  if (rel === ".." || rel.startsWith("../")) return undefined; // never escape the site root
  const path = posix.join("/", rel); // `./a`, `/a`, `a` → `/a`
  if (path === "/" || shouldSkipPath(path.slice(1))) return undefined;
  return path;
}

export function filesFromZip(data: Uint8Array): SiteFile[] {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch (err) {
    throw usageError(`could not read zip: ${(err as Error).message}`);
  }
  const files: SiteFile[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    const path = archivePath(name);
    if (path) files.push({ path, data: bytes, type: contentType(path) });
  }
  return stripSingleTopFolder(files);
}

export async function filesFromTarGz(data: Uint8Array): Promise<SiteFile[]> {
  let entries: Map<string, File>;
  try {
    entries = await new Bun.Archive(data).files();
  } catch (err) {
    throw usageError(`could not read tar.gz: ${(err as Error).message}`);
  }
  const files: SiteFile[] = [];
  for (const [name, file] of entries) {
    const path = archivePath(name);
    if (path)
      files.push({ path, data: new Uint8Array(await file.arrayBuffer()), type: contentType(path) });
  }
  return stripSingleTopFolder(files);
}

export async function filesFromFolder(root: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  const realRoot = realpathSync(root);
  /** A file link counts only if it points inside the folder at a file we'd publish anyway. */
  const linkTargetOk = (abs: string): boolean => {
    let target: string;
    try {
      target = realpathSync(abs);
    } catch {
      return false;
    }
    const rel = relative(realRoot, target);
    if (rel === "" || rel.startsWith("..") || resolve(realRoot, rel) !== target) return false;
    return !shouldSkipPath(rel.split(sep).join("/"));
  };
  const walk = async (dir: string, rel: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const abs = join(dir, entry.name);
      const relPath = `${rel}/${entry.name}`;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken link
        }
        if (isDir) continue; // don't follow directory links (avoids cycles)
        // Never publish what a link points to outside the folder (`config.txt -> ~/.env`).
        if (!linkTargetOk(abs)) continue;
      }
      if (isDir) await walk(abs, relPath);
      else if (isFile)
        files.push({ path: relPath, data: await Bun.file(abs).bytes(), type: contentType(abs) });
    }
  };
  await walk(root, "");
  return files;
}

export function htmlFile(data: Uint8Array): SiteFile[] {
  return [{ path: "/index.html", data, type: contentType("index.html") }];
}

export interface CollectOptions {
  cwd?: string;
  readStdin?: () => Promise<Uint8Array>;
}

export async function collect(input: string, opts: CollectOptions = {}): Promise<Collected> {
  if (input === "-") {
    const read = opts.readStdin ?? (() => Bun.stdin.bytes());
    return { files: htmlFile(await read()), source: "-" };
  }
  const abs = resolve(opts.cwd ?? process.cwd(), input);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(abs).isDirectory();
  } catch {
    throw usageError(`no such file or folder: ${input}`);
  }
  const kind = inputKind(abs, isDirectory);
  const defaultSite = defaultSiteName(abs, isDirectory);
  switch (kind) {
    case "folder":
      return { files: await filesFromFolder(abs), defaultSite, source: abs };
    case "zip":
      return { files: filesFromZip(await Bun.file(abs).bytes()), defaultSite, source: abs };
    case "tar.gz":
      return { files: await filesFromTarGz(await Bun.file(abs).bytes()), defaultSite, source: abs };
    case "html":
      return { files: htmlFile(await Bun.file(abs).bytes()), defaultSite, source: abs };
    default:
      throw usageError(
        `can't put ${basename(abs)}`,
        "Pass a folder, .zip, .tar.gz, .html file, or - for HTML on stdin.",
      );
  }
}
