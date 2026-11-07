// Per-invocation context: mode, output streams, prompts, and API access.
import * as p from "@clack/prompts";
import { createApi, type Api } from "./api.ts";
import { loadAccounts } from "./config.ts";
import { apiBaseUrl, resolveDomain, resolveKey, type KeyStore } from "./credentials.ts";
import { EXIT, TrayError, cancelled, missingFlag } from "./errors.ts";
import { toJson } from "./format.ts";
import type { Mode } from "./mode.ts";
import { VERSION } from "./version.ts";

export interface Ctx {
  mode: Mode;
  yes: boolean;
  /** --domain flag value, if given. */
  domainFlag?: string;
  env: Record<string, string | undefined>;
  configDir: string;
  keyStore: KeyStore;
  fetch?: typeof fetch;
  /** Injected in tests to skip real waits (login polling). */
  sleep?: (ms: number) => Promise<unknown>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The command line as typed (after `tray`), for retry commands in errors. */
  argv?: string[];
  /** --no-open: print URLs, never launch a browser. */
  noOpen?: boolean;
  /** --debug: one stderr line per API call. */
  debug?: boolean;
  /** With --json, warnings go here and into the result's `warnings`, not on stderr. */
  warnings?: { code: string; message: string }[];
}

const ui = { output: process.stderr };

// --- output -----------------------------------------------------------------

/**
 * The command's answer, the only thing on stdout: `json` (one document, plus
 * any `warnings`) with --json, otherwise `text` (a URL, a table, an id).
 * Empty `text` prints nothing.
 */
export function result(ctx: Ctx, text: string, json: object): void {
  if (ctx.mode.json) {
    const warnings = ctx.warnings?.length ? { warnings: ctx.warnings } : {};
    ctx.stdout(toJson({ ...json, ...warnings }, ctx.mode.prettyJson));
  } else if (text) ctx.stdout(text);
}

/**
 * Like `result`, closing the Clack frame (`└ frame`) on stderr first in
 * interactive mode. The answer itself still goes to stdout.
 */
export function outro(ctx: Ctx, frame: string, text: string, json: object): void {
  if (ctx.mode.interactive) p.outro(frame, ui);
  result(ctx, text, json);
}

/** What happened, on stderr (`✓ Removed q3-review.`). Silent with --json. */
export function receipt(ctx: Ctx, message: string): void {
  if (ctx.mode.json) return;
  if (ctx.mode.interactive) p.log.success(message, ui);
  else ctx.stderr(`✓ ${message}`);
}

/**
 * Nothing to show: the message and next command on stderr. stdout gets
 * nothing on a terminal, and just the header row when piped (so a script
 * reading columns sees the shape).
 */
export function empty(ctx: Ctx, headers: string[], message: string, next?: string): void {
  ctx.stderr(next ? `${message}\n    ${next}` : message);
  if (ctx.mode.stdoutTTY === false) ctx.stdout(headers.join("\t"));
}

/** Progress / hints, on stderr. Silent with --json. */
export function info(ctx: Ctx, message: string): void {
  if (ctx.mode.json) return;
  if (ctx.mode.interactive) p.log.info(message, ui);
  else ctx.stderr(message);
}

export function success(ctx: Ctx, message: string): void {
  receipt(ctx, message);
}

/** A warning: stderr, or the result's `warnings` with --json. */
export function warn(ctx: Ctx, message: string, code = "warning"): void {
  if (ctx.mode.json) (ctx.warnings ??= []).push({ code, message: message.replaceAll("`", "") });
  else if (ctx.mode.interactive) p.log.warn(message, ui);
  else ctx.stderr(`warning: ${message.replaceAll("`", "")}`);
}

/** `tray <what was typed> <extra>`: a retry command for errors. */
export function retry(ctx: Ctx, extra: string): string | undefined {
  if (!ctx.argv) return undefined;
  const words = ctx.argv.filter((a) => a !== "--json" && a !== "--non-interactive");
  return ["tray", ...words, extra].join(" ");
}

export function intro(ctx: Ctx): void {
  if (ctx.mode.interactive) p.intro("tray", ui);
}

/**
 * A finished phase: a Clack step (◇ message) interactively, one plain stderr
 * line otherwise (so CI logs show progress). Silent with --json.
 */
export function step(ctx: Ctx, message: string): void {
  if (ctx.mode.interactive) p.log.step(message, ui);
  else if (!ctx.mode.json) ctx.stderr(message);
}

export interface Spinner {
  start(msg: string): void;
  message(msg: string): void;
  stop(msg: string): void;
  error(msg: string): void;
}

/** Interactive: a Clack spinner. Otherwise only its final line, via `step`. */
export function spinner(ctx: Ctx): Spinner {
  if (ctx.mode.interactive) return p.spinner(ui);
  return { start() {}, message() {}, stop: (m) => step(ctx, m), error() {} };
}

// --- prompts ------------------------------------------------------------------

function cancel(): never {
  throw cancelled();
}

/**
 * Confirmation. `--yes` accepts it; interactive asks; non-interactive exits 2
 * with the retry command (the same line plus `--yes`).
 */
export async function confirm(ctx: Ctx, message: string): Promise<boolean> {
  if (ctx.yes) return true;
  if (!ctx.mode.interactive) {
    const again = retry(ctx, "--yes");
    throw new TrayError(
      "This needs confirmation in non-interactive mode",
      "confirmation_required",
      EXIT.usage,
      again ? "Confirm with --yes:" : "Pass --yes.",
      "--yes",
      { details: [message], next: again ? [again] : undefined },
    );
  }
  const answer = await p.confirm({ message, initialValue: false, ...ui });
  if (p.isCancel(answer)) cancel();
  return answer;
}

/** A value with a flag. Interactive asks; non-interactive exits 2 naming the flag. */
export async function askText(
  ctx: Ctx,
  opts: {
    flag: string;
    message: string;
    placeholder?: string;
    initial?: string;
    validate?: (v: string) => string | undefined;
  },
): Promise<string> {
  if (!ctx.mode.interactive) throw missingFlag(opts.flag, opts.flag, retry(ctx, opts.flag));
  const answer = await p.text({
    message: opts.message,
    placeholder: opts.placeholder,
    initialValue: opts.initial,
    validate: (v) => (v ? opts.validate?.(v) : "required"),
    ...ui,
  });
  if (p.isCancel(answer)) cancel();
  return answer.trim();
}

export async function askSelect<T extends string>(
  ctx: Ctx,
  opts: { flag: string; message: string; options: { value: T; label?: string; hint?: string }[] },
): Promise<T> {
  if (!ctx.mode.interactive) throw missingFlag(opts.flag, opts.flag, retry(ctx, opts.flag));
  const answer = await p.select<T>({ message: opts.message, options: opts.options as any, ...ui });
  if (p.isCancel(answer)) cancel();
  return answer as T;
}

// --- API access -------------------------------------------------------------------

export function currentDomain(ctx: Ctx): string {
  return resolveDomain(ctx.domainFlag, ctx.env, loadAccounts(ctx.configDir));
}

/** Resolve domain + key and return a client. Throws (exit 4) when not logged in. */
export async function authedApi(ctx: Ctx): Promise<{ api: Api; domain: string }> {
  const domain = currentDomain(ctx);
  const key = await resolveKey(domain, ctx.env, ctx.keyStore);
  return { api: apiFor(ctx, domain, key), domain };
}

/** A client for `domain`; `key` omitted for the unauthenticated device-flow calls. */
export function apiFor(ctx: Ctx, domain: string, key?: string): Api {
  return createApi({
    baseUrl: apiBaseUrl(domain, ctx.env),
    key,
    fetch: ctx.debug ? debugFetch(ctx) : ctx.fetch,
    onOutdated: (v) =>
      warn(
        ctx,
        `the tray Worker on ${domain} is v${v}, older than this CLI (v${VERSION}); run \`tray upgrade\``,
        "worker_outdated",
      ),
  });
}

/** --debug: `GET https://tray.acme.dev/v1/sites 200 84ms` per call. Never headers or bodies. */
function debugFetch(ctx: Ctx): typeof fetch {
  const base = ctx.fetch ?? fetch;
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const started = performance.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = input instanceof Request ? input.url : String(input);
    try {
      const res = await base(input, init);
      ctx.stderr(`${method} ${url} ${res.status} ${Math.round(performance.now() - started)}ms`);
      return res;
    } catch (err) {
      ctx.stderr(`${method} ${url} failed ${Math.round(performance.now() - started)}ms`);
      throw err;
    }
  }) as typeof fetch;
}

/**
 * Open an http(s) URL in the default browser. Best effort. Anything else (an
 * `-a App` option, a `file:` URL, shell metacharacters for `cmd`) is ignored.
 */
export function openBrowser(url: string): void {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    href = parsed.href;
  } catch {
    return;
  }
  const cmd =
    process.platform === "darwin"
      ? ["open", href]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", href]
        : ["xdg-open", href];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {}
}
