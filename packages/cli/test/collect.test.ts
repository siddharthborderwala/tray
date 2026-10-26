import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { collect, filesFromTarGz, filesFromZip, inputKind, shouldSkip, shouldSkipPath, slugify, stripSingleTopFolder } from "../src/collect.ts";
import { TrayError } from "../src/errors.ts";
import { bytes, tmp } from "./helpers.ts";

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe("skip rules", () => {
  test("skips .git, .DS_Store, node_modules, __MACOSX and dotfiles", () => {
    for (const s of [".git", ".DS_Store", "node_modules", "__MACOSX", ".env", ".hidden"]) expect(shouldSkip(s)).toBe(true);
  });
  test("keeps .well-known and normal names", () => {
    for (const s of [".well-known", "index.html", "a.b", "well-known"]) expect(shouldSkip(s)).toBe(false);
  });
  test("applies to any segment of a path", () => {
    expect(shouldSkipPath("a/node_modules/x.js")).toBe(true);
    expect(shouldSkipPath(".well-known/security.txt")).toBe(false);
    expect(shouldSkipPath("a/.env")).toBe(true);
  });
});

describe("folder", () => {
  test("walks recursively and applies skip rules", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "css"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(dir, ".well-known"));
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(dir, "css/site.css"), "body{}");
    writeFileSync(join(dir, ".git/HEAD"), "ref");
    writeFileSync(join(dir, "node_modules/pkg/i.js"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, ".well-known/security.txt"), "x");
    symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
    const c = await collect(dir);
    expect(paths(c.files)).toEqual(["/.well-known/security.txt", "/css/site.css", "/index.html"]);
    expect(c.source).toBe(dir);
    const css = c.files.find((f) => f.path === "/css/site.css")!;
    expect(css.type).toStartWith("text/css");
    expect(new TextDecoder().decode(css.data)).toBe("body{}");
  });

  test("does not strip a single top-level folder for folders", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "only"));
    writeFileSync(join(dir, "only/index.html"), "x");
    expect(paths((await collect(dir)).files)).toEqual(["/only/index.html"]);
  });

  test("default site name is the folder slug", async () => {
    const parent = tmp();
    const dir = join(parent, "My Report");
    mkdirSync(dir);
    writeFileSync(join(dir, "index.html"), "x");
    expect((await collect(dir)).defaultSite).toBe("my-report");
  });
});

describe("zip", () => {
  test("unpacks, skips __MACOSX and dotfiles, strips a shared top folder", () => {
    const zip = zipSync({
      "site/index.html": bytes("<h1>"),
      "site/img/a.png": bytes("png"),
      "site/.DS_Store": bytes("x"),
      "__MACOSX/site/._index.html": bytes("x"),
      "site/": new Uint8Array(),
    });
    const files = filesFromZip(zip);
    expect(paths(files)).toEqual(["/img/a.png", "/index.html"]);
    expect(files.find((f) => f.path === "/img/a.png")!.type).toBe("image/png");
  });

  test("keeps layout when there is no single top folder", () => {
    const zip = zipSync({ "index.html": bytes("x"), "about/index.html": bytes("y") });
    expect(paths(filesFromZip(zip))).toEqual(["/about/index.html", "/index.html"]);
  });

  test("drops entries that try to escape the root", () => {
    const zip = zipSync({ "../evil.html": bytes("x"), "ok.html": bytes("y") });
    expect(paths(filesFromZip(zip))).toEqual(["/ok.html"]);
  });

  test("invalid zip is a usage error", () => {
    expect(() => filesFromZip(bytes("not a zip"))).toThrow(TrayError);
  });
});

describe("tar.gz", () => {
  test("unpacks with Bun.Archive and strips a shared top folder", async () => {
    const tgz = await new Bun.Archive(
      { "dist/index.html": "<h1>", "dist/js/app.js": "1", "dist/node_modules/x.js": "x" },
      { compress: "gzip" },
    ).bytes();
    const files = await filesFromTarGz(tgz);
    expect(paths(files)).toEqual(["/index.html", "/js/app.js"]);
  });

  test("collect() picks .tar.gz and .tgz by extension", async () => {
    const dir = tmp();
    const tgz = await new Bun.Archive({ "index.html": "x" }, { compress: "gzip" }).bytes();
    writeFileSync(join(dir, "site.tar.gz"), tgz);
    writeFileSync(join(dir, "other.tgz"), tgz);
    const a = await collect(join(dir, "site.tar.gz"));
    expect(paths(a.files)).toEqual(["/index.html"]);
    expect(a.defaultSite).toBe("site");
    expect((await collect(join(dir, "other.tgz"))).defaultSite).toBe("other");
  });
});

describe("single html and stdin", () => {
  test("an .html file becomes /index.html named after the file", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "report.html"), "<p>r</p>");
    const c = await collect(join(dir, "report.html"));
    expect(paths(c.files)).toEqual(["/index.html"]);
    expect(c.defaultSite).toBe("report");
    expect(c.files[0]!.type).toStartWith("text/html");
  });

  test("- reads stdin into /index.html with no default name", async () => {
    const c = await collect("-", { readStdin: async () => bytes("<p>stdin</p>") });
    expect(paths(c.files)).toEqual(["/index.html"]);
    expect(c.defaultSite).toBeUndefined();
    expect(c.source).toBe("-");
  });

  test("unsupported files and missing paths are usage errors (exit 2)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "pic.png"), "x");
    for (const p of [join(dir, "pic.png"), join(dir, "nope")]) {
      const err = await collect(p).catch((e) => e);
      expect(err).toBeInstanceOf(TrayError);
      expect(err.exit).toBe(2);
    }
  });
});

describe("helpers", () => {
  test("inputKind", () => {
    expect(inputKind("-", false)).toBe("stdin");
    expect(inputKind("/x", true)).toBe("folder");
    expect(inputKind("a.ZIP", false)).toBe("zip");
    expect(inputKind("a.htm", false)).toBe("html");
    expect(inputKind("a.txt", false)).toBeUndefined();
  });

  test("slugify", () => {
    expect(slugify("report.html")).toBe("report");
    expect(slugify("Q3 Review (final).zip")).toBe("q3-review-final");
    expect(slugify("Café.tar.gz")).toBe("cafe");
    expect(slugify("tray")).toBeUndefined(); // reserved
    expect(slugify("___")).toBeUndefined();
    expect(slugify("a".repeat(80))!.length).toBe(63);
  });

  test("stripSingleTopFolder needs every file nested under the same folder", () => {
    const f = (path: string) => ({ path, data: new Uint8Array(), type: "" });
    expect(paths(stripSingleTopFolder([f("/a/x"), f("/a/b/y")]))).toEqual(["/b/y", "/x"]);
    expect(paths(stripSingleTopFolder([f("/a/x"), f("/b/y")]))).toEqual(["/a/x", "/b/y"]);
    expect(paths(stripSingleTopFolder([f("/a"), f("/a2/x")]))).toEqual(["/a", "/a2/x"]);
    expect(paths(stripSingleTopFolder([f("/index.html")]))).toEqual(["/index.html"]);
  });
});
