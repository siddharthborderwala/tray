// Turn a folder, .zip, .tar.gz, .html file, any other file, several files, or
// stdin into a flat list of files keyed by their path inside the site.
import { readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { RESERVED_SITE_NAMES, SITE_NAME_RE } from "@tray-sh/schema";
import { usageError } from "./errors.ts";
import { withIndex } from "./index-page.ts";

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
  /** Set when Tray added `/index.html`: `redirect` to the only file, or a `list` of several. */
  generatedIndex?: "redirect" | "list";
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

export type InputKind = "stdin" | "folder" | "zip" | "tar.gz" | "html" | "file";

export function inputKind(path: string, isDirectory: boolean): InputKind {
  if (path === "-") return "stdin";
  if (isDirectory) return "folder";
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return "file";
}

/** `Q3 Report.pdf` → `q3-report`; `site.tar.gz` → `site`. Undefined when no valid name results. */
export function slugify(name: string): string | undefined {
  return toSlug(name.replace(/\.(tar\.gz|[a-z0-9]+)$/i, ""));
}

/** Like slugify, but keeps every dot-separated part (folders: `acme.dev` → `acme-dev`). */
function toSlug(stem: string): string | undefined {
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

/** `~/work/q3-review/dist` → `q3-review`; `~/work/Q3 Report.pdf` → `q3-report`. */
export function defaultSiteName(absPath: string, isDirectory: boolean): string | undefined {
  const name = basename(absPath);
  if (!isDirectory) return slugify(name);
  if (GENERIC_FOLDER_NAMES.has(name.toLowerCase())) return toSlug(basename(dirname(absPath)));
  return toSlug(name);
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

/**
 * Collect one input (folder, archive, file, or `-`) or several plain files.
 * Adds a generated `/index.html` when there is none (except for stdin).
 */
export async function collect(
  input: string | string[],
  opts: CollectOptions = {},
): Promise<Collected> {
  const inputs = typeof input === "string" ? [input] : input;
  if (inputs.length > 1) return indexed(await collectFiles(inputs, opts));
  const first = inputs[0]!;
  if (first === "-") {
    const read = opts.readStdin ?? (() => Bun.stdin.bytes());
    return { files: htmlFile(await read()), source: "-" };
  }
  return indexed(await collectOne(first, opts));
}

function indexed(c: Collected): Collected {
  const files = withIndex(c.files, c.defaultSite);
  if (files === c.files) return c;
  return { ...c, files, generatedIndex: c.files.length === 1 ? "redirect" : "list" };
}

/** `stat` an input path, as a usage error when it's missing. */
function statInput(input: string, abs: string): Stats {
  try {
    return statSync(abs);
  } catch {
    throw usageError(`no such file or folder: ${input}`);
  }
}

/** A plain file at `/<name>`. Dotfiles are refused so `.env` is never put by accident. */
async function plainFile(abs: string, st: Stats): Promise<SiteFile> {
  const name = basename(abs);
  if (!st.isFile()) throw usageError(`can't put ${name}`, "Pass a regular file or a folder.");
  if (shouldSkip(name))
    throw usageError(`won't put ${name}`, "Dotfiles are never published. Rename it to put it.");
  return { path: `/${name}`, data: await Bun.file(abs).bytes(), type: contentType(abs) };
}

async function collectOne(input: string, opts: CollectOptions): Promise<Collected> {
  const abs = resolve(opts.cwd ?? process.cwd(), input);
  const st = statInput(input, abs);
  const isDirectory = st.isDirectory();
  const defaultSite = defaultSiteName(abs, isDirectory);
  switch (inputKind(abs, isDirectory)) {
    case "folder":
      return { files: await filesFromFolder(abs), defaultSite, source: abs };
    case "zip":
      return { files: filesFromZip(await Bun.file(abs).bytes()), defaultSite, source: abs };
    case "tar.gz":
      return { files: await filesFromTarGz(await Bun.file(abs).bytes()), defaultSite, source: abs };
    case "html":
      return { files: htmlFile(await Bun.file(abs).bytes()), defaultSite, source: abs };
    default:
      return { files: [await plainFile(abs, st)], defaultSite, source: abs };
  }
}

/** Several files, each at `/<name>` as is (archives and .html aren't unpacked). No default name. */
async function collectFiles(inputs: string[], opts: CollectOptions): Promise<Collected> {
  const several = () =>
    usageError("put one folder, or several files", "Pass one folder on its own, or files only.");
  if (inputs.includes("-")) throw several();
  const abs = inputs.map((i) => resolve(opts.cwd ?? process.cwd(), i));
  const stats = inputs.map((input, i) => statInput(input, abs[i]!));
  if (stats.some((st) => st.isDirectory())) throw several();
  const files: SiteFile[] = [];
  for (const [i, path] of abs.entries()) {
    const file = await plainFile(path, stats[i]!);
    if (files.some((f) => f.path === file.path))
      throw usageError(
        `two files named ${file.path.slice(1)}`,
        "Each file goes to /<name>, so names must differ.",
      );
    files.push(file);
  }
  return { files, source: commonDir(abs) };
}

/** Deepest folder containing every path: `/a/b/x`, `/a/c/y` → `/a`. */
export function commonDir(paths: string[]): string {
  const split = paths.map((p) => dirname(p).split(sep));
  const common = split[0]!.slice();
  for (const parts of split) {
    let n = 0;
    while (n < common.length && parts[n] === common[n]) n++;
    common.length = n;
  }
  return common.join(sep) || sep;
}
