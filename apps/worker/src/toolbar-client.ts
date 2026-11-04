// The toolbar on hosted pages, for signed-in visitors. It runs inside the
// site's own page, so it:
// - lives in a closed shadow root on a uniquely named element, with its own
//   styles, so the page's CSS can't reach it and it can't reach the page's;
// - mounts after `load` (after frameworks hydrate) and only in the top window;
// - builds every node with textContent (no server or page data as HTML);
// - uses absolute same-origin URLs, so a page's <base href> can't redirect them.
// Serialized with `toString()` and served as /.tray/toolbar-<v>.js: keep it
// self-contained (no imports, no outside references).

import { themeCss } from "@tray-sh/theme";
import type { ToolbarConfig, ToolbarMe } from "./toolbar-types.ts";

declare const TRAY_TOOLBAR_CONFIG: ToolbarConfig;

(function toolbarMain(cfg: ToolbarConfig) {
  const FLAG = "__trayToolbar";
  const w = window as unknown as Record<string, unknown>;
  if (window.top !== window || w[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true });
  } catch {
    return;
  }
  const url = (path: string) => new URL(path, location.origin).href;

  // The handle and avatars are identity, the same in both themes (an ink
  // tile, a periwinkle initial, the blue period). Everything else uses the
  // theme's --tray-* tokens, set on .root inside the shadow tree so a page's
  // own custom properties can't reach them.
  const INK = "#242424";
  const BLUE = "#356BE5";
  const PERI = "#7B9BFF";
  /** The handle's edge: visible on dark pages, quiet on light ones. */
  const EDGE = "#3A3A3A";
  /** Namespaced, since it's registered on the page's document.fonts. */
  const FAMILY = "__tray_mono";
  const KEY = "tray-toolbar-corner";
  const INSET = 16;

  type Corner = "tl" | "tr" | "bl" | "br";

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
    kids: Node[] = [],
  ) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    for (const k of kids) n.append(k);
    return n;
  };

  /**
   * The initial as a huge outlined glyph, cropped by the tile. Ink ground,
   * periwinkle outline. An `@domain` gets a periwinkle bar down the left edge.
   */
  const SVG = "http://www.w3.org/2000/svg";
  const svg = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
  ) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  /**
   * The initial as a huge outlined glyph, cropped by the tile. Ink ground,
   * periwinkle outline. An `@domain` gets a periwinkle bar down the left edge.
   * SVG with an explicit baseline, so every browser crops it the same way
   * (CSS line boxes put the baseline in different places in Chrome and Safari).
   * Laid out on a 32-unit tile and scaled to `size`.
   */
  const avatar = (who: string, size: number) => {
    const domain = who.startsWith("@");
    const letter = (domain ? who.slice(1) : who).charAt(0).toLowerCase() || "?";
    const FONT = 46.4; // 1.45 × the tile
    // Every initial sits in the same spot, pushed to the bottom right so it
    // bleeds off the tile's right and bottom edges. The line box starts 1 unit
    // above the tile and the baseline sits 0.86 em below that (JetBrains Mono,
    // as Chrome lays it out).
    const x = 7;
    const y = -1 + 0.86 * FONT;
    const stroke = (size >= 28 ? 1.5 : 1) * (32 / size); // constant on screen
    const root = svg("svg", {
      viewBox: "0 0 32 32",
      width: size,
      height: size,
      class: domain ? "avatar domain" : "avatar",
      "aria-hidden": "true",
      focusable: "false",
    });
    const text = svg("text", {
      x,
      y,
      "font-size": FONT,
      "font-weight": 700,
      fill: "none",
      // An @domain is the inverse: an ink initial on a periwinkle tile.
      stroke: domain ? INK : PERI,
      "stroke-width": stroke,
      "font-family": `"${FAMILY}", ui-monospace, monospace`,
    });
    text.textContent = letter;
    root.append(svg("rect", { width: 32, height: 32, fill: domain ? PERI : INK }), text);
    return root;
  };

  const css = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
${themeCss(".root", { colorScheme: false })}
.root{font:13px/20px "${FAMILY}",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.03em;color:var(--tray-foreground);-webkit-font-smoothing:antialiased}
.avatar{display:block;flex-shrink:0;overflow:hidden;user-select:none}
@media (prefers-color-scheme:dark){.panel .avatar:not(.domain){outline:1px solid ${EDGE};outline-offset:-1px}}
.handle{position:fixed;z-index:2147483647;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:${INK};border:1px solid ${EDGE};cursor:grab;touch-action:none;transition:left .2s ease,top .2s ease}
.handle::after{content:"";position:absolute;right:-4px;bottom:-4px;width:7px;height:7px;background:${BLUE}}
.handle:focus-visible{outline:2px solid ${BLUE};outline-offset:2px}
.handle.dragging{cursor:grabbing;border-color:${BLUE};outline:3px solid ${PERI};transition:none}
.tip{position:fixed;z-index:2147483647;background:var(--tray-inverse);color:var(--tray-inverse-foreground);font-size:12px;line-height:18px;padding:4px 8px;white-space:nowrap;pointer-events:none;display:none}
.handle:hover+.tip{display:block}
.handle.dragging+.tip,.open+.tip{display:none!important}
.panel{position:fixed;z-index:2147483647;width:340px;max-height:calc(100vh - 96px);overflow:auto;background:var(--tray-background);border:1px solid var(--tray-outline);display:none;flex-direction:column}
.panel.show{display:flex}
.account{display:flex;align-items:center;gap:12px;padding:16px}
.col{display:flex;flex-direction:column;min-width:0;flex:1}
.email{font-size:15px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.sub,.role,.note{font-size:12px;line-height:18px;color:var(--tray-muted-foreground)}
.row .note{font-size:11px;line-height:16px}
.rule{height:1px;background:var(--tray-border);flex-shrink:0}
.people{display:flex;flex-direction:column;padding:16px 16px 12px;gap:4px}
.head{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:8px}
.title{font-weight:600}
.row{display:flex;align-items:center;gap:12px;min-height:40px}
.row .who{font-size:14px;line-height:20px;overflow-wrap:anywhere}
.role{flex-shrink:0}
.hint{display:flex;flex-direction:column;gap:8px;padding-top:12px}
.hint .note{font-size:13px;line-height:20px}
.code{display:flex;align-items:center;gap:12px;background:var(--tray-muted);padding:10px 12px}
.code code{flex:1;min-width:0;font:inherit;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.copy{font:inherit;font-size:12px;line-height:16px;color:var(--tray-muted-foreground);background:var(--tray-background);border:1px solid var(--tray-border);padding:1px 8px;cursor:pointer;flex-shrink:0}
.copy:hover{color:var(--tray-foreground);border-color:var(--tray-border-strong)}
.foot{display:flex;align-items:center;justify-content:space-between;padding:12px 16px}
.foot a{font-size:14px;color:var(--tray-foreground);text-decoration:underline;text-underline-offset:3px}
.foot a:hover{color:var(--tray-accent)}
.mark{display:block;color:var(--tray-foreground);line-height:0}
.mark svg{height:16px;width:auto}
@media (max-width:480px){
  .panel{left:0!important;right:0!important;bottom:0!important;top:auto!important;width:auto;max-height:80vh;border-width:1px 0 0}
}
.root ::selection{background:var(--tray-selection);color:var(--tray-selection-foreground)}
@media (prefers-reduced-motion:reduce){.handle{transition:none}}
@media print{.root{display:none}}
`;

  // A fresh element name each load, so a page can't style it or define it first.
  const host = document.createElement(`tray-toolbar-${Math.random().toString(36).slice(2, 10)}`);
  host.setAttribute(
    "style",
    "all:initial!important;display:block!important;position:static!important;width:0!important;height:0!important;overflow:visible!important",
  );
  const shadow = host.attachShadow({ mode: "closed" });
  const style = el("style", undefined, css);
  const root = el("div", "root");
  shadow.append(style, root);

  const load = async () => {
    let me: ToolbarMe;
    try {
      const res = await fetch(url(cfg.me), { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      me = (await res.json()) as ToolbarMe;
      if (typeof me?.email !== "string") return;
    } catch {
      return;
    }
    const body = document.body;
    if (!body || body.tagName === "FRAMESET") return;
    try {
      const face = new FontFace(FAMILY, `url("${url(cfg.font)}") format("woff2")`, {
        weight: "100 800",
      });
      document.fonts.add(face);
      void face.load();
    } catch {
      // The system monospace is fine.
    }
    build(me);
    body.append(host);
    // Pages that rebuild <body> drop us; put the toolbar back, a few times at most.
    let restores = 10;
    new MutationObserver(() => {
      if (host.isConnected || restores <= 0 || !document.body) return;
      restores--;
      document.body.append(host);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };

  const build = (me: ToolbarMe) => {
    // The handle is the avatar itself: an ink tile, no paper frame (calm on dark pages).
    const handle = el("button", "handle", undefined, [avatar(me.email, 42)]);
    handle.type = "button";
    handle.setAttribute("aria-label", `Signed in as ${me.email}. Open the Tray menu`);
    handle.setAttribute("aria-expanded", "false");
    const tip = el("div", "tip", me.email);
    const panel = el("div", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Tray");
    root.append(handle, tip, panel);

    // Account
    panel.append(
      el("div", "account", undefined, [
        avatar(me.email, 40),
        el("div", "col", undefined, [
          el("span", "email", me.email),
          el("span", "sub", `${me.role === "owner" ? "Owner" : "Viewer"} · ${me.host}`),
        ]),
      ]),
      el("div", "rule"),
    );

    const row = (who: string, label: string, role: string, note?: string) =>
      el("div", "row", undefined, [
        avatar(who, 28),
        el("div", "col", undefined, [
          el("span", "who", label),
          ...(note ? [el("span", "note", note)] : []),
        ]),
        el("span", "role", role),
      ]);

    const people = el("div", "people");
    if (me.role === "owner") {
      people.append(
        el("div", "head", undefined, [
          el("span", "title", "People with access"),
          el("span", "role", me.visibility === "private" ? "Private" : "Public"),
        ]),
        row(me.email, me.email, "Owner", "you"),
      );
      if (me.visibility === "private") {
        for (const who of me.sharedWith ?? []) {
          people.append(
            who.startsWith("@")
              ? row(who, who, "Viewer", `anyone with ${who} email`)
              : row(who, who, "Viewer"),
          );
        }
      } else {
        const anyone = el("div", "row", undefined, [el("span", "who", "Anyone with the link")]);
        people.append(anyone);
      }
      const command =
        me.visibility === "private"
          ? `tray share ${me.site} <email>`
          : `tray edit ${me.site} --visibility private`;
      const copy = el("button", "copy", "copy");
      copy.type = "button";
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(command).then(() => {
          copy.textContent = "copied";
          setTimeout(() => (copy.textContent = "copy"), 1500);
        });
      });
      people.append(
        el("div", "hint", undefined, [
          el(
            "span",
            "note",
            me.visibility === "private"
              ? "To change who has access, ask your agent, or run:"
              : "To make it private, ask your agent, or run:",
          ),
          el("div", "code", undefined, [el("code", undefined, command), copy]),
        ]),
      );
    } else {
      people.append(
        el("div", "head", undefined, [el("span", "title", "Shared by")]),
        row(me.owner, me.owner, "Owner"),
      );
    }
    panel.append(people, el("div", "rule"));

    // Footer: sign out, and the wordmark.
    const signout = el("a", undefined, "Sign out");
    signout.href = url(cfg.signout);
    const mark = el("a", "mark");
    mark.href = "https://tray.sh";
    mark.target = "_blank";
    mark.rel = "noopener";
    mark.setAttribute("aria-label", "Tray");
    mark.innerHTML = cfg.mark;
    panel.append(el("div", "foot", undefined, [signout, mark]));

    // Placement: a corner, remembered per site.
    let corner: Corner = "br";
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "tl" || saved === "tr" || saved === "bl" || saved === "br") corner = saved;
    } catch {
      // Storage blocked: default corner.
    }
    const SIZE = 44;
    const at = (c: Corner) => ({
      x: c[1] === "l" ? INSET : window.innerWidth - INSET - SIZE,
      y: c[0] === "t" ? INSET : window.innerHeight - INSET - SIZE,
    });
    const place = () => {
      const { x, y } = at(corner);
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
      // Tooltip beside the handle, toward the middle of the screen.
      const left = corner[1] === "r";
      tip.style.top = `${y + 12}px`;
      tip.style.left = left ? "" : `${x + SIZE + 8}px`;
      tip.style.right = left ? `${window.innerWidth - x + 8}px` : "";
      // Panel above a bottom handle, below a top one, on the handle's side.
      const bottom = corner[0] === "b";
      panel.style.top = bottom ? "" : `${y + SIZE + 8}px`;
      panel.style.bottom = bottom ? `${window.innerHeight - y + 8}px` : "";
      panel.style.left = left ? "" : `${x}px`;
      panel.style.right = left ? `${INSET}px` : "";
    };
    place();
    window.addEventListener("resize", place);

    const setOpen = (open: boolean) => {
      panel.classList.toggle("show", open);
      handle.classList.toggle("open", open);
      handle.setAttribute("aria-expanded", String(open));
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    document.addEventListener("pointerdown", (e) => {
      if (!e.composedPath().includes(host)) setOpen(false);
    });

    // Drag: follows the pointer, then snaps to the nearest corner. A press
    // that barely moves is a click.
    let start: { px: number; py: number; x: number; y: number } | null = null;
    let moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      handle.setPointerCapture(e.pointerId);
      const r = handle.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      moved = false;
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        setOpen(false);
        handle.classList.add("dragging");
      }
      handle.style.left = `${start.x + dx}px`;
      handle.style.top = `${start.y + dy}px`;
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      start = null;
      if (!moved) return;
      handle.classList.remove("dragging");
      const r = handle.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      corner = `${cy < window.innerHeight / 2 ? "t" : "b"}${cx < window.innerWidth / 2 ? "l" : "r"}`;
      try {
        localStorage.setItem(KEY, corner);
      } catch {
        // Not remembered; fine.
      }
      place();
      e.preventDefault();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("click", () => {
      if (moved) {
        moved = false;
        return;
      }
      setOpen(!panel.classList.contains("show"));
    });
  };

  if (document.readyState === "complete") void load();
  else window.addEventListener("load", () => void load(), { once: true });
})(TRAY_TOOLBAR_CONFIG);
