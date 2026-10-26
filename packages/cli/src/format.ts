// Pure formatting helpers (tables, sizes, times, errors).
import type { TrayError } from "./errors.ts";
import { homedir } from "node:os";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Plain aligned columns, like `gh` and `vercel` print. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]! + 3)))
      .join("")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function formatError(err: TrayError, json: boolean): string {
  if (json) {
    return JSON.stringify({
      error: err.message,
      code: err.code,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.param ? { param: err.param } : {}),
    });
  }
  return err.hint ? `error: ${err.message}\n${err.hint}` : `error: ${err.message}`;
}

/** `/Users/sid/work/x` → `~/work/x` */
export function tildify(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
