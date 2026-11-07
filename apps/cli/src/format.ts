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

/**
 * A table for stdout. On a terminal: aligned columns, like `gh` and `vercel`.
 * Piped: tab-separated (cells never contain tabs), so `cut -f2` works.
 */
export function formatTable(headers: string[], rows: string[][], tty = true): string {
  if (!tty) return [headers, ...rows].map((r) => r.join("\t")).join("\n");
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]! + 3)))
      .join("")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** `key  value` rows (whoami, previews): aligned on a terminal, tab-separated when piped. */
export function formatPairs(rows: [string, string][], tty = true): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => (tty ? `${k.padEnd(w + 2)}${v}` : `${k}\t${v}`)).join("\n");
}

/** A time cell: `3d ago` on a terminal, ISO 8601 (or empty) when piped. */
export const timeCell = (iso: string | null | undefined, tty: boolean) =>
  tty ? relativeTime(iso) : (iso ?? "");

/** An empty cell: `—` on a terminal, nothing when piped. */
export const emptyCell = (tty: boolean) => (tty ? "—" : "");

/** `--json` output: 2-space indented for a terminal, one compact line when piped or redirected. */
export function toJson(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * A headline ends in a period. Not capitalized here: CLI messages are written
 * capitalized, and ones that start with a name (a site, from the Worker) keep it as is.
 */
export function sentence(text: string): string {
  const t = text.trim();
  return /[.!?:]$/.test(t) ? t : t + ".";
}

/**
 * An error for stderr. JSON: one line with the API's keys plus `details` and
 * `next`. Human:
 *
 *   ✗ Not logged in to acme.dev.
 *     <detail>
 *
 *   Log in, or set TRAY_API_KEY:
 *       tray login acme.dev
 *
 * `✗` only with color; `Error:` otherwise. Canceling isn't an error: its
 * notice prints as is.
 */
export function formatError(
  err: TrayError,
  opts: { json: boolean; color?: boolean; warnings?: { code: string; message: string }[] },
): string {
  if (opts.json) {
    // API errors keep their extra fields (e.g. `missing`), as SPEC §3 promises the API's shape.
    const body = (err as TrayError & { body?: Record<string, unknown> }).body;
    return JSON.stringify({
      ...body,
      error: err.message,
      code: err.code,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.param ? { param: err.param } : {}),
      ...(err.details ? { details: err.details } : {}),
      ...(err.next ? { next: err.next } : {}),
      ...(opts.warnings?.length ? { warnings: opts.warnings } : {}),
    });
  }
  if (err.code === "canceled") return err.message;
  const mark = opts.color ? "\x1b[31m✗\x1b[0m " : "Error: ";
  const lines = [mark + sentence(err.message), ...(err.details ?? []).map((d) => `  ${d}`)];
  const hint = err.hint?.replaceAll("`", "");
  if (hint || err.next) lines.push("");
  if (hint) lines.push(hint);
  if (err.next) lines.push(...err.next.map((c) => `    ${c}`));
  return lines.join("\n");
}

/** `/Users/sid/work/x` → `~/work/x` */
export function tildify(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
