// Where to put one <script> tag in an HTML page without changing anything else
// about it. Fails closed: when the start of the page is unusual (an unclosed
// comment or raw-text element, a script that uses `<!--` escapes, UTF-16, no
// safe point in the first 64 KB), the page is served byte-for-byte unchanged.
//
// The tag goes before `</head>`, or before the first thing that belongs in the
// body (`<body>`, `<p>`, `<frameset>`, visible text). So it always lands after
// `<!doctype>` (no quirks mode), after any `<meta charset>`, `<base>` and CSP
// `<meta>` (a page's own CSP still applies to it), and never inside a comment,
// <template>, <script>, <style>, <title>, <textarea> or similar.

/** How much of the page we look at. Real pages reach `</head>` or `<body>` long before. */
export const SCAN_LIMIT = 64 * 1024;

/** Elements whose content is text until their end tag. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/** Start tags the parser keeps in <head> (or before it) without starting the body. */
const HEAD = new Set([
  "html",
  "head",
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "title",
  "style",
  "script",
  "noscript",
  "template",
]);

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;

const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d;
const isAlpha = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const lower = (b: number) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

/** Index of the ASCII string `needle` (lowercase) in `buf` from `from`, ignoring case; -1 if absent. */
function find(buf: Uint8Array, needle: string, from: number): number {
  const n = needle.length;
  outer: for (let i = from; i + n <= buf.length; i++) {
    for (let j = 0; j < n; j++) if (lower(buf[i + j]!) !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** End of a raw-text element's content: the `</name` followed by space, `/` or `>`. */
function rawEnd(buf: Uint8Array, name: string, from: number): number {
  let i = from;
  for (;;) {
    const at = find(buf, "</" + name, i);
    if (at < 0) return -1;
    const next = buf[at + 2 + name.length];
    if (next === undefined) return -1; // can't tell yet: treat as unclosed
    if (isSpace(next) || next === SLASH || next === GT) return at;
    i = at + 1;
  }
}

/**
 * The tag's name and the index just past its `>`, parsing attributes (and
 * their quotes) the way the HTML tokenizer does. null if it doesn't close.
 */
function readTag(buf: Uint8Array, start: number): { name: string; end: number } | null {
  let i = start;
  let name = "";
  while (i < buf.length && !isSpace(buf[i]!) && buf[i] !== SLASH && buf[i] !== GT) {
    name += String.fromCharCode(lower(buf[i]!));
    i++;
  }
  for (;;) {
    while (i < buf.length && (isSpace(buf[i]!) || buf[i] === SLASH)) i++;
    if (i >= buf.length) return null;
    if (buf[i] === GT) return { name, end: i + 1 };
    // Attribute name: the first character may be `=` (a parse error, but part of the name).
    i++;
    while (
      i < buf.length &&
      !isSpace(buf[i]!) &&
      buf[i] !== SLASH &&
      buf[i] !== GT &&
      buf[i] !== EQ
    )
      i++;
    while (i < buf.length && isSpace(buf[i]!)) i++;
    if (buf[i] !== EQ) continue;
    i++;
    while (i < buf.length && isSpace(buf[i]!)) i++;
    if (i >= buf.length) return null;
    const q = buf[i];
    if (q === DQ || q === SQ) {
      const close = buf.indexOf(q, i + 1);
      if (close < 0) return null;
      i = close + 1;
    } else {
      while (i < buf.length && !isSpace(buf[i]!) && buf[i] !== GT) i++;
    }
  }
}

/**
 * Where the tag goes in `buf` (the first bytes of the page), or -1 to leave
 * the page alone. `complete` says whether `buf` is the whole page.
 */
export function injectionPoint(buf: Uint8Array, complete: boolean): number {
  // UTF-16 (by BOM): bytes aren't ASCII-compatible.
  if (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  )
    return -1;
  let i = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  let template = 0; // inside <template>: its content is inert, never inject there

  while (i < buf.length) {
    const b = buf[i]!;
    if (b !== LT) {
      if (isSpace(b)) {
        i++;
        continue;
      }
      if (template > 0) {
        i++;
        continue;
      }
      return i; // visible text starts the body
    }

    const next = buf[i + 1];
    if (next === undefined) return -1;

    if (next === BANG) {
      if (buf[i + 2] === 0x2d && buf[i + 3] === 0x2d) {
        // <!-- comment -->; `<!-->` and `<!--->` close at once.
        if (buf[i + 4] === GT) {
          i += 5;
          continue;
        }
        if (buf[i + 4] === 0x2d && buf[i + 5] === GT) {
          i += 6;
          continue;
        }
        const close = find(buf, "-->", i + 4);
        if (close < 0) return -1;
        i = close + 3;
        continue;
      }
      // <!doctype …> or a bogus comment like <![CDATA[ … >
      const close = buf.indexOf(GT, i + 2);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (next === QUESTION) {
      const close = buf.indexOf(GT, i + 2);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }

    if (next === SLASH) {
      const c = buf[i + 2];
      if (c === undefined) return -1;
      if (c === GT) {
        i += 3; // `</>` is ignored
        continue;
      }
      if (!isAlpha(c)) {
        const close = buf.indexOf(GT, i + 2); // bogus comment
        if (close < 0) return -1;
        i = close + 1;
        continue;
      }
      const tag = readTag(buf, i + 2);
      if (!tag) return -1;
      if (tag.name === "template" && template > 0) template--;
      else if (tag.name === "head" && template === 0) return i; // before </head>
      i = tag.end;
      continue;
    }

    if (!isAlpha(next)) {
      if (template > 0) {
        i++;
        continue;
      }
      return i; // a literal `<` is text, so the body has started
    }

    const tag = readTag(buf, i + 1);
    if (!tag) return -1;
    const { name } = tag;

    if (name === "plaintext") return template > 0 ? -1 : i;
    if (name === "template") {
      template++;
      i = tag.end;
      continue;
    }
    if (!HEAD.has(name) && template === 0) return i; // body content starts here

    if (RAW_TEXT.has(name)) {
      const end = rawEnd(buf, name, tag.end);
      if (end < 0) return -1;
      // Script data with `<!--` has escape states where `</script>` may not close it.
      if (name === "script" && find(buf.subarray(0, end), "<!--", tag.end) >= 0) return -1;
      const close = readTag(buf, end + 2);
      if (!close) return -1;
      i = close.end;
      continue;
    }
    i = tag.end;
  }
  // Reached the end without a body: append, but only if this is the whole page.
  return complete && template === 0 ? buf.length : -1;
}

/** Whether a page with this Content-Type is in an ASCII-compatible encoding we can scan. */
export function scannableType(type: string): boolean {
  const [mime = "", ...params] = type.toLowerCase().split(";");
  if (mime.trim() !== "text/html") return false;
  for (const p of params) {
    const [k, v = ""] = p.split("=");
    if (k?.trim() !== "charset") continue;
    const cs = v.trim().replace(/^"|"$/g, "");
    return [
      "utf-8",
      "utf8",
      "unicode-1-1-utf-8",
      "us-ascii",
      "ascii",
      "iso-8859-1",
      "latin1",
      "windows-1252",
      "iso-8859-15",
    ].includes(cs);
  }
  return true;
}

/**
 * The page with `tag` inserted, or null to serve it unchanged. Reads at most
 * SCAN_LIMIT bytes before deciding; the rest streams through untouched.
 */
export async function injectInto(
  body: ReadableStream<Uint8Array>,
  tag: Uint8Array,
): Promise<{ stream: ReadableStream<Uint8Array>; injected: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < SCAN_LIMIT) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    size += r.value.byteLength;
  }
  const head = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    head.set(c, o);
    o += c.byteLength;
  }
  const scanned = head.subarray(0, Math.min(size, SCAN_LIMIT));
  const at = injectionPoint(scanned, done && size <= SCAN_LIMIT);
  const first = at < 0 ? [head] : [head.subarray(0, at), tag, head.subarray(at)];

  let queue = first.filter((c) => c.byteLength > 0);
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (queue.length) {
        ctrl.enqueue(queue.shift()!);
        return;
      }
      if (done) {
        ctrl.close();
        return;
      }
      const r = await reader.read();
      if (r.done) ctrl.close();
      else ctrl.enqueue(r.value);
    },
    cancel(reason) {
      queue = [];
      return reader.cancel(reason);
    },
  });
  return { stream, injected: at >= 0 };
}
