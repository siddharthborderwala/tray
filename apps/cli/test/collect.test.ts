import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
  commonDir,
  defaultSiteName,
  collect,
  filesFromTarGz,
  filesFromZip,
  inputKind,
  shouldSkip,
  shouldSkipPath,
  slugify,
  stripSingleTopFolder,
  type Collected,
} from "../src/collect.ts";
import { TrayError } from "../src/errors.ts";
import { bytes, tmp } from "./helpers.ts";

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe("skip rules", () => {
  test("skips .git, .DS_Store, node_modules, __MACOSX and dotfiles", () => {
    for (const s of [".git", ".DS_Store", "node_modules", "__MACOSX", ".env", ".hidden"])
      expect(shouldSkip(s)).toBe(true);
  });
  test("keeps .well-known and normal names", () => {
    for (const s of [".well-known", "index.html", "a.b", "well-known"])
      expect(shouldSkip(s)).toBe(false);
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

  test("follows file links only inside the folder, never to skipped files", async () => {
    const outside = tmp();
    writeFileSync(join(outside, "id_rsa"), "PRIVATE");
    const dir = tmp();
    writeFileSync(join(dir, "index.html"), "x");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    symlinkSync(join(outside, "id_rsa"), join(dir, "vendor.js"));
    symlinkSync(join(dir, ".env"), join(dir, "config.txt"));
    symlinkSync(join(dir, "index.html"), join(dir, "home.html"));
    expect(paths((await collect(dir)).files)).toEqual(["/home.html", "/index.html"]);
  });

  test("does not strip a single top-level folder for folders", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "only"));
    writeFileSync(join(dir, "only/index.html"), "x");
    expect(paths((await collect(dir)).files)).toEqual(["/index.html", "/only/index.html"]); // root index generated
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

  test("missing paths and dotfiles are usage errors (exit 2)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env"), "SECRET=1");
    for (const p of [join(dir, "nope"), join(dir, ".env")]) {
      const err = await collect(p).catch((e) => e);
      expect(err).toBeInstanceOf(TrayError);
      expect(err.exit).toBe(2);
    }
  });
});

const text = (c: Collected, path: string) =>
  new TextDecoder().decode(c.files.find((f) => f.path === path)!.data);

describe("single file", () => {
  test("a PDF goes to /<name> with an index that opens it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "report.pdf"), "%PDF");
    const c = await collect(join(dir, "report.pdf"));
    expect(paths(c.files)).toEqual(["/index.html", "/report.pdf"]);
    expect(c.files.find((f) => f.path === "/report.pdf")!.type).toBe("application/pdf");
    expect(c.defaultSite).toBe("report");
    expect(c.source).toBe(join(dir, "report.pdf"));
    expect(c.generatedIndex).toBe("redirect");
    expect(text(c, "/index.html")).toContain(
      '<meta http-equiv="refresh" content="0; url=/report.pdf">',
    );
  });

  test("keeps the original name; the index escapes and encodes it", async () => {
    const dir = tmp();
    const name = "Q3 <b>&'Report.pdf";
    writeFileSync(join(dir, name), "%PDF");
    const c = await collect(join(dir, name));
    expect(paths(c.files)).toEqual(["/Q3 <b>&'Report.pdf", "/index.html"]);
    expect(c.defaultSite).toBe("q3-b-report");
    const html = text(c, "/index.html");
    expect(html).toContain("url=/Q3%20%3Cb%3E%26%27Report.pdf");
    expect(html).toContain("<title>Q3 &lt;b&gt;&amp;&#39;Report.pdf</title>");
    expect(html).not.toContain("<b>");
  });

  test("any extension is dropped from the default name", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "Q3 Report.pdf"), "x");
    writeFileSync(join(dir, "photo.final.jpg"), "x");
    expect((await collect(join(dir, "Q3 Report.pdf"))).defaultSite).toBe("q3-report");
    expect((await collect(join(dir, "photo.final.jpg"))).defaultSite).toBe("photo-final");
  });
});

describe("several files", () => {
  test("each goes to /<name>, archives and .html as is; source is the common folder", async () => {
    const root = tmp();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a/notes.pdf"), "%PDF");
    writeFileSync(join(root, "b/site.zip"), zipSync({ "index.html": bytes("x") }));
    writeFileSync(join(root, "b/page.html"), "<p>");
    const c = await collect(["a/notes.pdf", "b/site.zip", "b/page.html"], { cwd: root });
    expect(paths(c.files)).toEqual(["/index.html", "/notes.pdf", "/page.html", "/site.zip"]);
    expect(c.defaultSite).toBeUndefined();
    expect(c.source).toBe(root);
    expect(c.generatedIndex).toBe("list");
    const html = text(c, "/index.html");
    expect(html).toContain("<title>Files</title>");
    expect(html).toContain('<a href="/notes.pdf">notes.pdf</a>');
    expect(html).not.toContain('class="grid"');
  });

  test("mostly images: a grid with the images inline", async () => {
    const dir = tmp();
    for (const n of ["a.png", "b b.jpg", "c.txt"]) writeFileSync(join(dir, n), "x");
    const c = await collect([join(dir, "a.png"), join(dir, "b b.jpg"), join(dir, "c.txt")]);
    expect(c.source).toBe(dir);
    const html = text(c, "/index.html");
    expect(html).toContain('<ul class="grid">');
    expect(html).toContain('<img src="/b%20b.jpg" alt="" loading="lazy">');
    expect(html).not.toContain('<img src="/c.txt"');
  });

  test("the list page is headed by the site name when one is given", async () => {
    const dir = tmp();
    for (const n of ["a.png", "b.png"]) writeFileSync(join(dir, n), "x");
    const files = [join(dir, "a.png"), join(dir, "b.png")];
    expect(text(await collect(files), "/index.html")).toContain("<h1>Files</h1>");
    const named = await collect(files, { title: "figures" });
    expect(text(named, "/index.html")).toContain("<h1>figures</h1>");
  });

  test("a folder, stdin, a dotfile, or a repeated name is a usage error", async () => {
    const root = tmp();
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, "other"));
    for (const p of ["a.png", "sub/a.png", ".env"]) writeFileSync(join(root, p), "x");
    const cases: [string[], string][] = [
      [["a.png", "sub"], "put one folder, or several files"],
      [["a.png", "-"], "put one folder, or several files"],
      [["a.png", ".env"], "won't put .env"],
      [["a.png", "sub/a.png"], "two files named a.png"],
      [["a.png", "nope.png"], "no such file or folder: nope.png"],
    ];
    for (const [inputs, message] of cases) {
      const err = await collect(inputs, { cwd: root }).catch((e) => e);
      expect(err).toBeInstanceOf(TrayError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe(message);
    }
  });

  test("commonDir", () => {
    expect(commonDir(["/a/b/x", "/a/c/y"])).toBe("/a");
    expect(commonDir(["/a/b/x", "/a/b/y"])).toBe("/a/b");
    expect(commonDir(["/a/x", "/b/y"])).toBe("/");
  });
});

describe("generated index", () => {
  test("a folder without index.html gets a list titled with the default name", async () => {
    const dir = join(tmp(), "q3-review");
    mkdirSync(join(dir, "img"), { recursive: true });
    writeFileSync(join(dir, "img/a.png"), "x");
    writeFileSync(join(dir, "notes.md"), "x");
    const c = await collect(dir);
    expect(paths(c.files)).toEqual(["/img/a.png", "/index.html", "/notes.md"]);
    expect(c.generatedIndex).toBe("list");
    const html = text(c, "/index.html");
    expect(html).toContain("<h1>q3-review</h1>");
    expect(html).toContain('<a href="/img/a.png"><img src="/img/a.png"');
  });

  test("a folder with index.html is unchanged", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "index.html"), "mine");
    writeFileSync(join(dir, "a.pdf"), "x");
    const c = await collect(dir);
    expect(c.generatedIndex).toBeUndefined();
    expect(text(c, "/index.html")).toBe("mine");
  });

  test("an empty folder stays empty", async () => {
    const c = await collect(tmp());
    expect(c.files).toEqual([]);
    expect(c.generatedIndex).toBeUndefined();
  });

  test("a zip without index.html gets one", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "deck.zip"), zipSync({ "deck/slides.pdf": bytes("%PDF") }));
    const c = await collect(join(dir, "deck.zip"));
    expect(paths(c.files)).toEqual(["/index.html", "/slides.pdf"]);
    expect(c.generatedIndex).toBe("redirect");
  });

  test("stdin never gets one", async () => {
    const c = await collect("-", { readStdin: async () => bytes("<p>") });
    expect(c.generatedIndex).toBeUndefined();
    expect(paths(c.files)).toEqual(["/index.html"]);
  });
});

describe("helpers", () => {
  test("inputKind", () => {
    expect(inputKind("-", false)).toBe("stdin");
    expect(inputKind("/x", true)).toBe("folder");
    expect(inputKind("a.ZIP", false)).toBe("zip");
    expect(inputKind("a.htm", false)).toBe("html");
    expect(inputKind("a.txt", false)).toBe("file");
  });

  test("slugify", () => {
    expect(slugify("report.html")).toBe("report");
    expect(slugify("Q3 Review (final).zip")).toBe("q3-review-final");
    expect(slugify("Café.tar.gz")).toBe("cafe");
    expect(slugify("Q3 Report.pdf")).toBe("q3-report");
    expect(slugify("README")).toBe("readme");
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

describe("generic folder names", () => {
  test.each(["dist", "out", "build", "public", "site", "_site", "www"])(
    "%s falls back to the parent folder",
    (name) => {
      expect(defaultSiteName(`/Users/sid/work/q3-review/${name}`, true)).toBe("q3-review");
    },
  );
  test("other names, and files, keep their own name", () => {
    expect(defaultSiteName("/Users/sid/work/q3-review/docs", true)).toBe("docs");
    expect(defaultSiteName("/Users/sid/work/q3-review/dist.zip", false)).toBe("dist");
    expect(defaultSiteName("/Users/sid/work/site.html", false)).toBe("site");
    expect(defaultSiteName("/Users/sid/work/acme.dev", true)).toBe("acme-dev"); // folders keep dots
  });
  test("collect() uses it", async () => {
    const parent = join(tmp(), "launch-page");
    mkdirSync(join(parent, "dist"), { recursive: true });
    writeFileSync(join(parent, "dist/index.html"), "x");
    expect((await collect(join(parent, "dist"))).defaultSite).toBe("launch-page");
  });
});
