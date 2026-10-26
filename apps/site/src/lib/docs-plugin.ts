/**
 * Turns plain Markdown HTML into the Tray docs components:
 *
 * - `## Heading` → `<section>` with an anchored heading and a hairline.
 * - `### \`tray list\` (alias \`ls\`)` → command signature with an alias badge.
 * - Code fences → gray blocks with a deep-blue `›` prompt and a copy button.
 *   `$ ` starts a command, `# ` a comment, other lines are output.
 *   Fence meta: `tabs="curl,bun,npm"` (one command per tab), `response`
 *   (deep-blue JSON), `title="…"` (small label above the code).
 * - Tables → hairline rows (thead kept for screen readers, hidden visually).
 * - A paragraph that is only a link → a "more" link.
 *
 * Runs as a Sätteri hast plugin (Astro's Markdown processor): the `after` hook
 * copies the finished tree into plain objects, rewrites it, and swaps it in.
 */

import type { HastPluginDefinition } from "satteri";

type Props = Record<string, unknown>;
interface Text {
  type: "text";
  value: string;
}
interface Element {
  type: "element";
  tagName: string;
  properties: Props;
  children: Node[];
  data?: { meta?: string | null };
}
interface Root {
  type: "root";
  children: Node[];
}
type Node = Element | Text | { type: string; [k: string]: unknown };

const isEl = (n: Node | undefined, tag?: string): n is Element =>
  !!n && n.type === "element" && (!tag || (n as Element).tagName === tag);

const h = (tagName: string, properties: Props = {}, children: Node[] = []): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});
const t = (value: string): Text => ({ type: "text", value });

function textOf(n: Node): string {
  if (n.type === "text") return (n as Text).value;
  if (isEl(n)) return n.children.map(textOf).join("");
  return "";
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function metaAttr(meta: string, key: string): string | undefined {
  return new RegExp(`${key}="([^"]*)"`).exec(meta)?.[1];
}
const hasFlag = (meta: string, key: string) =>
  new RegExp(`(^|\\s)${key}(\\s|$)`).test(meta.replace(/"[^"]*"/g, '""'));

// ---------------------------------------------------------------------------
// Code blocks

const copyButton = (text: string, label = "copy code") =>
  h("button", { type: "button", className: ["copy"], ariaLabel: label, dataCopy: text }, [
    t("copy"),
  ]);

const prompt = () => h("span", { className: ["prompt"], ariaHidden: "true" }, [t("›")]);

function codeBlock(code: Element): Element {
  const lang = String((code.properties.className as string[] | undefined)?.[0] ?? "").replace(
    "language-",
    "",
  );
  const meta = code.data?.meta ?? "";
  const raw = textOf(code).replace(/\n$/, "");
  const lines = raw.split("\n");

  const tabs = metaAttr(meta, "tabs");
  if (tabs) return tabsBlock(tabs.split(","), lines);

  const title = metaAttr(meta, "title");
  const response = hasFlag(meta, "response");
  const hasPrompt = lines.some((l) => l.startsWith("$ "));

  const out: Element[] = [];
  const commands: string[] = [];
  let continuing = false;
  for (const line of lines) {
    if (hasPrompt && line.startsWith("$ ")) {
      const cmd = line.slice(2);
      commands.push(cmd);
      continuing = cmd.endsWith("\\");
      out.push(h("span", { className: ["line", "cmd"] }, [prompt(), t(cmd)]));
    } else if (continuing) {
      commands.push(line);
      continuing = line.endsWith("\\");
      out.push(h("span", { className: ["line", "cont"] }, [t(line)]));
    } else if (line.trim() === "") {
      out.push(h("span", { className: ["line", "gap"], ariaHidden: "true" }));
    } else if (hasPrompt && line.startsWith("# ")) {
      out.push(h("span", { className: ["line", "comment"] }, [t(line)]));
    } else {
      out.push(h("span", { className: ["line", hasPrompt ? "out" : "plain"] }, [t(line)]));
    }
  }

  const copyText = hasPrompt ? commands.join("\n") : raw;
  const copyLabel = hasPrompt
    ? commands.length > 1
      ? "copy commands"
      : "copy command"
    : "copy code";
  const body: Node[] = [];
  if (title) body.push(h("span", { className: ["code-title"] }, [t(title)]));
  body.push(...out);

  const classes = ["code", `lang-${lang || "text"}`];
  if (response) classes.push("response");
  if (title) classes.push("titled");
  if (lines.length === 1 && !title) classes.push("single");
  if (lang === "text") classes.push("message");

  return h("div", { className: classes }, [
    h("pre", { tabIndex: 0 }, [h("code", {}, body)]),
    ...(lang === "text" ? [] : [copyButton(copyText, copyLabel)]),
  ]);
}

function tabsBlock(labels: string[], lines: string[]): Element {
  const cmds = lines.map((l) => l.replace(/^\$ /, ""));
  const id = "install";
  const first = cmds[0] ?? "";
  return h("div", { className: ["code", "tabs"], dataTabs: "" }, [
    h(
      "div",
      { className: ["tablist"], role: "tablist", ariaLabel: "Install with" },
      labels.map((label, i) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `${id}-tab-${i}`,
            ariaSelected: i === 0 ? "true" : "false",
            ariaControls: `${id}-panel`,
            tabIndex: i === 0 ? 0 : -1,
            dataCommand: cmds[i] ?? "",
          },
          [t(label.trim())],
        ),
      ),
    ),
    h(
      "div",
      {
        className: ["tabpanel"],
        role: "tabpanel",
        id: `${id}-panel`,
        ariaLabelledby: `${id}-tab-0`,
      },
      [
        h("pre", { tabIndex: 0 }, [
          h("code", {}, [
            h("span", { className: ["line", "cmd"] }, [
              prompt(),
              h("span", { dataCommandText: "" }, [t(first)]),
            ]),
          ]),
        ]),
        copyButton(first, "copy command"),
      ],
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Tables

function tableClass(table: Element): string {
  const thead = table.children.find((c) => isEl(c, "thead")) as Element | undefined;
  const headRow = thead?.children.find((c) => isEl(c, "tr")) as Element | undefined;
  const firstHead = headRow?.children.find((c) => isEl(c, "th"));
  const head = firstHead ? textOf(firstHead).trim().toLowerCase() : "";
  if (head === "method") return "t-endpoints";
  if (head === "step") return "t-steps";

  const tbody = table.children.find((c) => isEl(c, "tbody")) as Element | undefined;
  const firsts = (tbody?.children ?? [])
    .filter((r): r is Element => isEl(r, "tr"))
    .map((r) => {
      const td = r.children.find((c) => isEl(c, "td"));
      return td ? textOf(td).trim() : "";
    });
  const longest = Math.max(0, ...firsts.map((s) => s.length));
  if (longest <= 4) return "t-narrow";
  if (longest >= 18) return "t-wide";
  return "t-flags";
}

// ---------------------------------------------------------------------------

function transform(node: Element | Root): void {
  node.children = node.children.map((child) => {
    if (!isEl(child)) return child;

    if (child.tagName === "pre") {
      const code = child.children.find((c) => isEl(c, "code"));
      if (code) return codeBlock(code);
    }

    if (child.tagName === "table") {
      child.properties.className = [tableClass(child)];
      // No visible header row in the design: drop <thead> and make each row's
      // first cell its header, so the table still reads well.
      child.children = child.children.filter((part) => !isEl(part, "thead"));
      for (const part of child.children) {
        if (!isEl(part, "tbody")) continue;
        for (const row of part.children) {
          if (!isEl(row, "tr")) continue;
          const first = row.children.find((c) => isEl(c, "td"));
          if (isEl(first)) {
            first.tagName = "th";
            first.properties = { ...first.properties, scope: "row" };
          }
        }
      }
      return h("div", { className: ["table"] }, [child]);
    }

    if (child.tagName === "h3") {
      // `### \`tray list\` (alias \`ls\`)` is a command signature; plain text is a small label.
      const text = textOf(child).trim();
      if (!child.children.some((c) => isEl(c, "code"))) {
        child.properties.className = ["label"];
        return child;
      }
      const m = /^(.*?)\s*\(alias (\S+)\)$/.exec(text);
      child.properties.className = ["signature"];
      child.children = m
        ? [
            h("span", {}, [t(m[1] ?? "")]),
            h("span", { className: ["badge"] }, [t(`alias ${m[2]}`)]),
          ]
        : [h("span", {}, [t(text)])];
      return child;
    }

    if (child.tagName === "p") {
      const meaningful = child.children.filter((c) => !(c.type === "text" && !textOf(c).trim()));
      if (meaningful.length === 1 && isEl(meaningful[0], "a")) {
        child.properties.className = ["more"];
      }
    }

    transform(child);
    return child;
  });
}

/** Group top-level content into a <section> per h2. */
function sectionize(root: Root): void {
  const out: Node[] = [];
  let section: Element | null = null;
  for (const child of root.children) {
    if (isEl(child, "h2")) {
      const text = textOf(child).trim();
      const id = slugify(text);
      child.properties.id = id;
      child.children = [h("a", { href: `#${id}` }, [t(text)])];
      section = h("section", { className: ["doc-section"], ariaLabelledby: id, dataSection: id }, [
        child,
      ]);
      out.push(section);
    } else if (section) {
      section.children.push(child);
    } else if (child.type === "text" && !textOf(child).trim()) {
      continue;
    } else {
      // The intro before the first h2 is one section too, so its paragraphs sit together.
      section = h("section", { className: ["doc-section", "intro"] }, [child]);
      out.push(section);
    }
  }
  // Drop whitespace-only text nodes between blocks inside sections.
  for (const n of out) {
    if (isEl(n, "section"))
      n.children = n.children.filter((c) => c.type !== "text" || textOf(c).trim());
  }
  root.children = out;
}

/** Deep-copy a (possibly lazily materialized) hast node into plain objects. */
function clone(n: Node): Node {
  const src = n as Record<string, unknown>;
  const out: Record<string, unknown> = { type: src.type };
  if ("tagName" in src) out.tagName = src.tagName;
  if ("value" in src) out.value = src.value;
  if ("properties" in src) {
    const props: Props = {};
    for (const [k, v] of Object.entries((src.properties as Props) ?? {})) {
      props[k] = Array.isArray(v) ? [...v] : v;
    }
    out.properties = props;
  }
  const data = src.data as { meta?: string | null } | undefined;
  if (data?.meta) out.data = { meta: data.meta };
  if (Array.isArray(src.children)) out.children = (src.children as Node[]).map(clone);
  return out as Node;
}

export const trayHast: HastPluginDefinition = {
  name: "tray-docs",
  after(root, ctx) {
    const tree = clone(root as unknown as Node) as Root;
    transform(tree);
    sectionize(tree);
    ctx.replaceNode(root, tree as never);
  },
};
