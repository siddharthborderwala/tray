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
}

const ui = { output: process.stderr };

// --- output -----------------------------------------------------------------

/** Print the command's result: `json` with --json, otherwise `text`. */
export function result(ctx: Ctx, text: string, json: unknown): void {
  ctx.stdout(ctx.mode.json ? toJson(json, ctx.mode.prettyJson) : text);
}

/** Like `result`, but closes the Clack frame (└  text) in interactive mode. The result still goes to stdout. */
export function outro(ctx: Ctx, text: string, json: unknown): void {
  if (ctx.mode.interactive) p.outro(text, { output: process.stdout });
  else result(ctx, text, json);
}

/** Progress / hints. Never on stdout. */
export function info(ctx: Ctx, message: string): void {
  if (ctx.mode.interactive) p.log.info(message, ui);
  else ctx.stderr(message);
}

export function success(ctx: Ctx, message: string): void {
  if (ctx.mode.interactive) p.log.success(message, ui);
  else ctx.stderr(message);
}

export function warn(ctx: Ctx, message: string): void {
  if (ctx.mode.interactive) p.log.warn(message, ui);
  else ctx.stderr(`warning: ${message}`);
}

export function intro(ctx: Ctx): void {
  if (ctx.mode.interactive) p.intro("tray", ui);
}

/** Interactive: Clack step that completes immediately (◇ message). */
export function step(ctx: Ctx, message: string): void {
  if (ctx.mode.interactive) p.log.step(message, ui);
}

export interface Spinner {
  start(msg: string): void;
  message(msg: string): void;
  stop(msg: string): void;
  error(msg: string): void;
}

export function spinner(ctx: Ctx): Spinner {
  if (ctx.mode.interactive) return p.spinner(ui);
  return { start() {}, message() {}, stop() {}, error() {} };
}

// --- prompts ------------------------------------------------------------------

function cancel(): never {
  throw cancelled();
}

/**
 * Confirmation. `--yes` accepts it; interactive asks; non-interactive exits 2
 * naming the flag.
 */
export async function confirm(ctx: Ctx, message: string): Promise<boolean> {
  if (ctx.yes) return true;
  if (!ctx.mode.interactive)
    throw new TrayError(
      `confirmation required: ${message}`,
      "confirmation_required",
      EXIT.usage,
      "Pass --yes.",
      "--yes",
    );
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
  if (!ctx.mode.interactive) throw missingFlag(opts.flag);
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
  if (!ctx.mode.interactive) throw missingFlag(opts.flag);
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
    fetch: ctx.fetch,
    onOutdated: (v) =>
      ctx.stderr(
        `warning: the tray Worker on ${domain} is v${v}, older than this CLI (v${VERSION}); run \`tray upgrade\``,
      ),
  });
}

/** Open a URL in the default browser. Best effort. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {}
}
