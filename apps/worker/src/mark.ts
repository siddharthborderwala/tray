// The `tray.` wordmark as an SVG: "tray" in Berkeley Mono Bold, converted to outlines,
// and the square blue period on the baseline. Outlines, so no font ships with it.
// The site uses it too (apps/site/src/components/Wordmark.astro).

export const MARK_VIEWBOX = "0 0 62.18 25.31";
export const MARK_PATH =
  "M0 7.03H3.72V14.45C3.72 18.54 4.56 19.43 8.4 19.43C9.32 19.43 10.08 19.38 12.49 19.07V16.07C10.89 16.32 10.33 16.38 9.46 16.38C7.36 16.38 6.92 16.02 6.92 14.36V7.03H11.79V4.37H6.97V0L3.75 1.34V4.37H0.81Z M16.55 19.15H19.82V13.02C19.82 8.46 20.66 7.45 24.56 7.45C25.4 7.45 26.01 7.5 27.24 7.7V4.48C25.4 4.31 24.7 4.28 23.35 4.31C20.8 4.34 20.58 4.48 19.04 7.36H18.9L19.35 4.37H16.55Z M37.49 19.15H40.29V9.3C40.29 5.01 39.23 4.09 34.41 4.09C29.88 4.09 28.9 4.93 29.01 8.68H32.14C32.12 7.06 32.54 6.69 34.5 6.69C36.74 6.69 37.24 7.17 37.24 9.35V10.05H35.25C29.71 10.05 28.5 10.95 28.5 15.09C28.5 18.62 29.37 19.4 33.35 19.4C35.98 19.4 36.71 19.04 37.35 17.39H37.49ZM37.21 12.4C37.16 15.79 36.54 16.55 33.85 16.55C32.06 16.55 31.67 16.21 31.67 14.64C31.67 12.8 32.2 12.4 34.69 12.4Z M44.97 25.31H48.27L55.5 4.37H52.14L48.72 15.04H48.61L45.14 4.37H41.78L46.54 18.17H47.52Z";
export const MARK_PERIOD = { x: 57.18, y: 14.15, size: 5, radius: 1 };

/** Inline SVG. The letters take `currentColor`; the period is `periodColor`. */
export function markSvg(periodColor = "#356BE5", label = "tray") {
  const [, , w, h] = MARK_VIEWBOX.split(" ");
  const p = MARK_PERIOD;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" width="${w}" height="${h}" role="img" aria-label="${label}"><path fill="currentColor" d="${MARK_PATH}"/><rect x="${p.x}" y="${p.y}" width="${p.size}" height="${p.size}" rx="${p.radius}" style="fill:${periodColor}"/></svg>`;
}
