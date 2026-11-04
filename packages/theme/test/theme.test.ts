import { describe, expect, test } from "bun:test";
import { contrast, themeCss, tokens, type Theme, type Token } from "../src/index.ts";

const THEMES: Theme[] = ["light", "dark"];
const c = (theme: Theme, fg: Token, bg: Token) => contrast(tokens[fg][theme], tokens[bg][theme]);

describe("contrast, in both themes", () => {
  // [text, surface, minimum]: 4.5:1 for text, 3:1 for UI edges (WCAG AA).
  const pairs: [Token, Token, number][] = [
    ["foreground", "background", 4.5],
    ["foreground", "muted", 4.5],
    ["muted-foreground", "background", 4.5],
    ["muted-foreground", "muted", 4.5],
    ["faint-foreground", "background", 4.5],
    ["faint-foreground", "muted", 4.5],
    ["accent", "background", 4.5],
    ["accent-on-muted", "muted", 4.5],
    ["accent-foreground", "accent", 4.5],
    ["inverse-foreground", "inverse", 4.5],
    ["brand-foreground", "brand", 4.5],
    ["selection-foreground", "selection", 4.5],
    ["border-strong", "background", 3],
    ["brand-accent", "brand", 1.5], // the outlined mark on the hero: decorative
  ];
  for (const theme of THEMES)
    for (const [fg, bg, min] of pairs)
      test(`${theme}: ${fg} on ${bg} ≥ ${min}`, () => {
        expect(c(theme, fg, bg)).toBeGreaterThanOrEqual(min);
      });
});

test("brand tokens are the same in both themes", () => {
  for (const name of ["brand", "brand-foreground", "brand-accent"] as Token[])
    expect(tokens[name].dark).toBe(tokens[name].light);
});

test("CSS: prefixed names, dark under the media query, color-scheme only at the root", () => {
  const css = themeCss();
  expect(css).toStartWith(":root{--tray-background:#FAF9F0;");
  expect(css).toContain("color-scheme:light dark");
  expect(css).toContain("@media (prefers-color-scheme:dark){:root{--tray-background:#1B1B1B;");
  expect(css.match(/--(?!tray-)[a-z]/g)).toBeNull();
  expect(themeCss(".root", { colorScheme: false })).not.toContain("color-scheme:light");
});
