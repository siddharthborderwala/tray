// Tray's colors, as semantic tokens with a light and a dark value. The one
// source for tray.sh, the Worker's own pages, the CLI's generated file lists
// and the toolbar. Components use only `var(--tray-*)`, never palette hexes.
//
// Every name is prefixed `--tray-`: these also run inside the toolbar on
// people's artifacts, where an unprefixed `--background` would collide with a
// page's own tokens (custom properties inherit into shadow DOM).

/** The brand palette. Never changes between themes. */
export const palette = {
  paper: "#FAF9F0",
  ink: "#242424",
  blue: "#356BE5",
  periwinkle: "#7B9BFF",
} as const;

export const tokens = {
  /** Page background. */
  background: { light: palette.paper, dark: "#1B1B1B" },
  /** Body text. */
  foreground: { light: palette.ink, dark: "#E8E8E2" },
  /** Code blocks, panels, empty states. */
  muted: { light: "#ECEBE3", dark: "#252524" },
  /** Secondary text (meta, sizes, roles). Readable on background and muted. */
  "muted-foreground": { light: "#5A5A5A", dark: "#A3A39B" },
  /** Tertiary text (labels, captions, comments). Readable on background and muted. */
  "faint-foreground": { light: "#666666", dark: "#8F8F88" },
  /** Hairlines. Decorative. */
  border: { light: "#DDDBD0", dark: "#34342F" },
  /** Buttons and inputs: a visible edge (3:1). A gray in dark, not near-white. */
  "border-strong": { light: palette.ink, dark: "#6E6E67" },
  /** Floating panels (the toolbar): ink in light; in dark, the handle's quiet edge. Decorative. */
  outline: { light: palette.ink, dark: "#3A3A3A" },
  /** Links, the `›` prompt, focus rings. */
  accent: { light: palette.blue, dark: palette.periwinkle },
  /** The accent on a `muted` surface. */
  "accent-on-muted": { light: "#235EE3", dark: "#8AA6FF" },
  /** Text on an `accent` fill (a primary button). */
  "accent-foreground": { light: palette.paper, dark: "#1B1B1B" },
  /** Tooltips, the skip link. */
  inverse: { light: palette.ink, dark: "#E8E8E2" },
  "inverse-foreground": { light: palette.paper, dark: "#1B1B1B" },
  /** The hero panel, avatar tiles, the favicon: the same in both themes. */
  brand: { light: palette.periwinkle, dark: palette.periwinkle },
  "brand-foreground": { light: palette.ink, dark: palette.ink },
  "brand-accent": { light: palette.blue, dark: palette.blue },
  /** Text selection. */
  selection: { light: palette.periwinkle, dark: palette.periwinkle },
  "selection-foreground": { light: palette.ink, dark: palette.ink },
} as const;

export type Token = keyof typeof tokens;
export type Theme = "light" | "dark";

/** `var(--tray-<name>)`. */
export const v = (name: Token) => `var(--tray-${name})`;

const decls = (theme: Theme) =>
  Object.entries(tokens)
    .map(([name, t]) => `--tray-${name}:${t[theme]}`)
    .join(";");

/**
 * The tokens as CSS on `selector`: light by default, dark under
 * `prefers-color-scheme: dark`. Pass `colorScheme: false` where the selector
 * isn't the document root (the toolbar's shadow tree), so we don't set
 * `color-scheme` on anything of the page's.
 */
export function themeCss(selector = ":root", { colorScheme = true } = {}): string {
  const scheme = colorScheme ? ";color-scheme:light dark" : "";
  return (
    `${selector}{${decls("light")}${scheme}}` +
    `@media (prefers-color-scheme:dark){${selector}{${decls("dark")}}}`
  );
}

/** The `<meta name="theme-color">` values for each scheme, so the browser bar matches. */
export const themeColors = [
  { content: tokens.background.light, media: "(prefers-color-scheme: light)" },
  { content: tokens.background.dark, media: "(prefers-color-scheme: dark)" },
] as const;

/** `themeColors` as HTML. */
export const themeColorMeta = () =>
  themeColors
    .map((t) => `<meta name="theme-color" content="${t.content}" media="${t.media}">`)
    .join("");

// --- contrast (WCAG 2.x), for the tests ----------------------------------

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
