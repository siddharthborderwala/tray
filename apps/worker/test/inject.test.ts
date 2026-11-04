// Where the toolbar's <script> goes. Every case here is also checked against
// Chrome's parser (see the browser check in the toolbar commit notes): the tag
// lands in <head> or <body>, outside inert or raw-text content, and the rest
// of the DOM is unchanged.
import { describe, expect, test } from "bun:test";
import { injectInto, injectionPoint, SCAN_LIMIT, scannableType } from "../src/inject.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });
const TAG = '<script src="https://s.acme.dev/.tray/toolbar-0.js" defer></script>';
/** The page with the tag inserted, or null when it's left alone. */
const inject = (html: string, complete = true) => {
  const buf = enc.encode(html);
  const at = injectionPoint(buf, complete);
  return at < 0 ? null : dec.decode(buf.subarray(0, at)) + TAG + dec.decode(buf.subarray(at));
};

describe("injection point", () => {
  const cases: [string, string, string | null][] = [
    [
      "full page: before </head>",
      "<!doctype html><html><head><title>x</title></head><body>hi</body></html>",
      `<!doctype html><html><head><title>x</title>${TAG}</head><body>hi</body></html>`,
    ],
    [
      "after meta charset, base and CSP",
      '<!DOCTYPE html><meta charset=utf-8><base href="https://evil.example/"><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><p>x',
      `<!DOCTYPE html><meta charset=utf-8><base href="https://evil.example/"><meta http-equiv="Content-Security-Policy" content="script-src 'self'">${TAG}<p>x`,
    ],
    [
      "no head or body tags: before the first body element",
      "<!doctype html><title>t</title><h1>hi</h1>",
      `<!doctype html><title>t</title>${TAG}<h1>hi</h1>`,
    ],
    ["fragment", "<h1>frag</h1>", `${TAG}<h1>frag</h1>`],
    ["plain text", "hello world", `${TAG}hello world`],
    ["empty page: appended", "", TAG],
    ["only whitespace and a comment: appended", "  <!-- x -->\n", `  <!-- x -->\n${TAG}`],
    [
      "head-only page: before </head>",
      "<html><head><title>x</title></head></html>",
      `<html><head><title>x</title>${TAG}</head></html>`,
    ],
    [
      "before <body> when there's no </head>",
      "<html><head><title>x</title><body class=a>",
      `<html><head><title>x</title>${TAG}<body class=a>`,
    ],
    [
      "uppercase tags",
      "<!DOCTYPE HTML><HTML><HEAD><TITLE>x</TITLE></HEAD><BODY>",
      `<!DOCTYPE HTML><HTML><HEAD><TITLE>x</TITLE>${TAG}</HEAD><BODY>`,
    ],
    ["UTF-8 BOM is kept first", "﻿<!doctype html><p>x", `﻿<!doctype html>${TAG}<p>x`],
    [
      "`</head>` inside a comment is skipped",
      "<head><!-- </head><body> --><title>x</title></head>",
      `<head><!-- </head><body> --><title>x</title>${TAG}</head>`,
    ],
    [
      "`<!-->` closes at once",
      "<head><!--><title>x</title></head>",
      `<head><!--><title>x</title>${TAG}</head>`,
    ],
    [
      "`</head>` inside a title is text",
      "<head><title></head><body></title></head>",
      `<head><title></head><body></title>${TAG}</head>`,
    ],
    [
      "`</head>` inside a script string is skipped",
      '<head><script>var s="</head><body>";</script></head>',
      `<head><script>var s="</head><body>";</script>${TAG}</head>`,
    ],
    [
      "`</scriptx>` doesn't close a script",
      "<head><script>a='</scriptx>'</script></head>",
      `<head><script>a='</scriptx>'</script>${TAG}</head>`,
    ],
    [
      "style with markup",
      "<head><style>a::after{content:'</head>'}</style></head>",
      `<head><style>a::after{content:'</head>'}</style>${TAG}</head>`,
    ],
    [
      "`>` inside a quoted attribute",
      '<head><meta content="a>b" name=x></head>',
      `<head><meta content="a>b" name=x>${TAG}</head>`,
    ],
    [
      "`>` inside a single-quoted attribute",
      "<head><link href='a>b'></head>",
      `<head><link href='a>b'>${TAG}</head>`,
    ],
    [
      "template content is inert: skipped",
      "<head><template><p>x</p></template></head>",
      `<head><template><p>x</p></template>${TAG}</head>`,
    ],
    [
      "nested templates",
      "<template><template><p></template><div></template><p>x",
      `<template><template><p></template><div></template>${TAG}<p>x`,
    ],
    [
      "noscript in head",
      "<head><noscript><p>no js</p></noscript></head>",
      `<head><noscript><p>no js</p></noscript>${TAG}</head>`,
    ],
    [
      "processing instruction and CDATA are bogus comments",
      "<?xml version='1.0'?><![CDATA[x]]><p>",
      `<?xml version='1.0'?><![CDATA[x]]>${TAG}<p>`,
    ],
    ["a literal < is text", "<head></head>", `<head>${TAG}</head>`],
    ["`< p` is text, so the body starts there", "< p>x", `${TAG}< p>x`],
    ["`</>` is ignored", "</><p>x", `</>${TAG}<p>x`],
    ["frameset", "<html><head></head><frameset>", `<html><head>${TAG}</head><frameset>`],
    ["svg document body", "<svg><title>x</title></svg>", `${TAG}<svg><title>x</title></svg>`],
    ["self-closing", "<meta charset=utf-8/><br/>", `<meta charset=utf-8/>${TAG}<br/>`],
    [
      "textarea in body is past the point",
      "<textarea></head></textarea>",
      `${TAG}<textarea></head></textarea>`,
    ],
    // Fail closed
    ["unclosed comment", "<!doctype html><!-- <p>", null],
    ["unclosed script", "<head><script>let a = 1;", null],
    ["unclosed title", "<title>hi", null],
    ["unclosed style", "<style>a{}", null],
    ["unclosed template", "<template><p>x", null],
    ["unclosed tag", '<meta content="x', null],
    ["unclosed doctype", "<!doctype html", null],
    ["script with `<!--` escapes", "<script><!--<script>a</script>--></script><p>", null],
    ["plaintext inside template", "<template><plaintext>x", null],
    ["UTF-16 LE BOM", "\xff\xfe<\x00p\x00", null],
  ];
  for (const [name, html, want] of cases) {
    test(name, () => {
      if (html.startsWith("\xff\xfe")) {
        const buf = Uint8Array.from(html, (c) => c.charCodeAt(0));
        expect(injectionPoint(buf, true)).toBe(-1);
        return;
      }
      expect(inject(html)).toBe(want);
    });
  }

  test("plaintext starts the body", () => {
    expect(inject("<plaintext>x")).toBe(`${TAG}<plaintext>x`);
  });

  test("an incomplete page is never appended to", () => {
    expect(inject("<head><title>x</title>", false)).toBeNull();
    expect(inject("<head><title>x</title>", true)).toBe(`<head><title>x</title>${TAG}`);
    // A tag cut off at the end of what we scanned.
    expect(inject("<head><meta name=x", false)).toBeNull();
    expect(inject("<head><script>a</scr", false)).toBeNull();
  });

  test("only the insertion changes the page", () => {
    for (const [, html, want] of cases) {
      if (want === null || html.startsWith("\xff")) continue;
      expect(want.replace(TAG, "")).toBe(html);
      expect(want.split(TAG).length).toBe(2);
    }
  });
});

describe("content types", () => {
  test("HTML in ASCII-compatible encodings only", () => {
    expect(scannableType("text/html")).toBe(true);
    expect(scannableType("text/html;charset=utf-8")).toBe(true);
    expect(scannableType('TEXT/HTML; Charset="UTF-8"')).toBe(true);
    expect(scannableType("text/html; charset=windows-1252")).toBe(true);
    expect(scannableType("text/html; charset=utf-16")).toBe(false);
    expect(scannableType("text/html; charset=utf-16le")).toBe(false);
    expect(scannableType("text/html; charset=shift_jis")).toBe(false);
    expect(scannableType("application/xhtml+xml")).toBe(false);
    expect(scannableType("text/plain")).toBe(false);
    expect(scannableType("text/htmlx")).toBe(false);
    expect(scannableType("")).toBe(false);
  });
});

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
const read = async (s: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(s).arrayBuffer());

describe("streaming", () => {
  const tag = enc.encode(TAG);

  test("splits across chunks, and every byte after the point passes through", async () => {
    const html = "<!doctype html><head><title>x</title></head><body>" + "é".repeat(100) + "</body>";
    const bytes = enc.encode(html);
    // One byte per chunk: the worst case for chunk boundaries.
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    const { stream, injected } = await injectInto(streamOf(chunks), tag);
    expect(injected).toBe(true);
    expect(dec.decode(await read(stream))).toBe(html.replace("</head>", TAG + "</head>"));
  });

  test("large pages: decided within the first 64 KB, the rest streams unchanged", async () => {
    const tail = new Uint8Array(5 * 1024 * 1024).fill(0x61); // 5 MB of "a"
    const head = enc.encode("<!doctype html><title>x</title><body>");
    const { stream, injected } = await injectInto(streamOf([head, tail]), tag);
    expect(injected).toBe(true);
    const out = await read(stream);
    expect(out.byteLength).toBe(head.byteLength + tag.byteLength + tail.byteLength);
    expect(dec.decode(out.subarray(0, 200))).toStartWith(
      `<!doctype html><title>x</title>${TAG}<body>`,
    );
  });

  test("no safe point in the first 64 KB: unchanged", async () => {
    // A 64 KB+ inline script in <head> before anything else.
    const html = "<head><script>" + "x".repeat(SCAN_LIMIT) + "</script></head><body>";
    const { stream, injected } = await injectInto(streamOf([enc.encode(html)]), tag);
    expect(injected).toBe(false);
    expect(dec.decode(await read(stream))).toBe(html);
  });

  test("unchanged pages are byte-for-byte identical", async () => {
    const bytes = Uint8Array.of(0xff, 0xfe, 0x3c, 0x00, 0x70, 0x00);
    const { stream, injected } = await injectInto(streamOf([bytes]), tag);
    expect(injected).toBe(false);
    expect(await read(stream)).toEqual(bytes);
  });

  test("empty body", async () => {
    const { stream, injected } = await injectInto(streamOf([]), tag);
    expect(injected).toBe(true);
    expect(dec.decode(await read(stream))).toBe(TAG);
  });
});
