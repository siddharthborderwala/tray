import { parse, printErrors, printVersion } from "@bomb.sh/router";
import { app, rewriteAliases } from "./app.ts";
import { accountList, accountSwitch, approve, login, logout, whoami } from "./commands/auth.ts";
import { domainAdd, domainList, domainRemove } from "./commands/domain.ts";
import { keyCreate, keyList, keyRevoke } from "./commands/key.ts";
import { put } from "./commands/put.ts";
import { setup, upgrade } from "./commands/setup.ts";
import { share, unshare } from "./commands/share.ts";
import { deploys, edit, list, open, remove, rollback } from "./commands/sites.ts";
import { configDir } from "./config.ts";
import { MACOS_SIGNED } from "./build.ts";
import {
  KEYCHAIN_INTERACTIVE_TIMEOUT_MS,
  KEYCHAIN_TIMEOUT_MS,
  defaultKeyStore,
  type KeyStore,
} from "./credentials.ts";
import type { Ctx } from "./ctx.ts";
import { EXIT, TrayError } from "./errors.ts";
import { formatError } from "./format.ts";
import { helpText } from "./help.ts";
import { detectMode } from "./mode.ts";
import { VERSION } from "./version.ts";
import { printGuide, skillInstall } from "./skill.ts";

export interface MainDeps {
  env?: Record<string, string | undefined>;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  keyStore?: KeyStore;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

interface Globals {
  json: boolean;
  nonInteractive: boolean;
  yes: boolean;
  noColor: boolean;
  noOpen: boolean;
  debug: boolean;
  domain?: string;
}

/** Global flags can appear on any route along the path; merge them (deepest `--domain` wins). */
export function mergeGlobals(models: Record<string, Partial<Globals>>): Globals {
  const g: Globals = {
    json: false,
    nonInteractive: false,
    yes: false,
    noColor: false,
    noOpen: false,
    debug: false,
  };
  for (const m of Object.values(models)) {
    g.json ||= !!m.json;
    g.nonInteractive ||= !!m.nonInteractive;
    g.yes ||= !!m.yes;
    g.noColor ||= !!m.noColor;
    g.noOpen ||= !!m.noOpen;
    g.debug ||= !!m.debug;
    if (m.domain) g.domain = m.domain;
  }
  return g;
}

/** Edit distance, for "Did you mean …?" (small inputs only). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

export function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let score = 3; // suggest only within edit distance 2
  for (const c of candidates) {
    const n = distance(word, c);
    if (n < score) [best, score] = [c, n];
  }
  return best;
}

type RouteDef = {
  phases: {
    routes: { name: string }[];
    model: { params: Record<string, { cli?: { syntax?: { type: string; label: string } } }> };
  }[];
};

/** The router's failures, as errors people can act on. Only the first problem is reported. */
function usageFailure(
  parsed: { path: readonly string[]; definition: unknown; issues: readonly any[] },
  args: string[],
): TrayError {
  const route = parsed.definition as RouteDef;
  const where = ["tray", ...parsed.path].join(" ");
  const help = [`${where} --help`];
  const issue = parsed.issues[0] ?? { message: "invalid usage" };
  const unexpected = /^unexpected "(.*)"$/.exec(issue.message ?? "");
  if (unexpected) {
    const token = JSON.parse(`"${unexpected[1]}"`) as string;
    if (token.startsWith("-")) {
      const flags = route.phases.flatMap((p) =>
        Object.values(p.model.params).flatMap((param) =>
          (param.cli?.syntax?.label ?? "").split(/[\s,]+/).filter((t) => t.startsWith("-")),
        ),
      );
      const guess = closest(token.split("=")[0]!, [...flags, "--help"]);
      return new TrayError(
        `Unknown option ${token} for ${where}.${guess ? ` Did you mean ${guess}?` : ""}`,
        "unknown_option",
        EXIT.usage,
        "See its options:",
        token,
        { next: help },
      );
    }
    const commands = route.phases.flatMap((p) => p.routes.map((r) => r.name));
    if (commands.length) {
      const guess = closest(token, commands);
      return new TrayError(
        `Unknown command ${token} for ${where}.${guess ? ` Did you mean ${guess}?` : ""}`,
        "unknown_command",
        EXIT.usage,
        "See all commands:",
        undefined,
        { next: help },
      );
    }
    return new TrayError(
      `Unexpected argument ${token} for ${where}.`,
      "invalid_usage",
      EXIT.usage,
      "See its usage:",
      undefined,
      { next: help },
    );
  }
  const param = badParam(parsed);
  const message: string = issue.message ?? "invalid usage";
  if (message.startsWith("missing ")) {
    return new TrayError(
      `${where} needs ${message.slice(8)}.`,
      "invalid_usage",
      EXIT.usage,
      "See its usage:",
      param,
      {
        next: help,
      },
    );
  }
  // A bad value: name the flag and the value as typed.
  const value = param?.startsWith("-") ? valueOf(args, param) : undefined;
  return new TrayError(
    `Invalid ${param ?? "input"}${value !== undefined ? ` ${JSON.stringify(value)}` : ""}: ${message}.`,
    "invalid_usage",
    EXIT.usage,
    "See its usage:",
    param,
    { next: help },
  );
}

/** The value given for `--flag` (or its short form) in argv: `--flag v` or `--flag=v`. */
function valueOf(args: string[], flag: string): string | undefined {
  const names = flag === "--site" ? ["--site", "-s"] : [flag];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(n + "=")) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/**
 * `tray help put` → `tray put --help`. After `--`, arguments are values even
 * if they start with `-`: the router has no `--`, so `-x` becomes `./-x` (only
 * `put` takes positional paths that could).
 */
const SWITCHES: Record<string, string> = {
  "--json": "--json",
  "--non-interactive": "--non-interactive",
  "--yes": "--yes",
  "-y": "--yes",
  "--no-color": "--no-color",
  "--no-open": "--no-open",
  "--debug": "--debug",
};

export function normalizeArgv(argv: string[]): string[] {
  let args = argv[0] === "help" ? [...argv.slice(1), "--help"] : argv;
  // A repeated switch (`--yes -y`) just means it once.
  const seen = new Set<string>();
  const stop = args.indexOf("--");
  args = args.filter((a, i) => {
    const key = (stop === -1 || i < stop) && SWITCHES[a];
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const end = args.indexOf("--");
  if (end !== -1)
    args = [
      ...args.slice(0, end),
      ...args.slice(end + 1).map((a) => (a.startsWith("-") ? `./${a}` : a)),
    ];
  return args;
}

/** The flag (`--site`) or argument (`host`) a validation error is about, for the JSON `param`. */
function badParam(result: {
  definition: unknown;
  issues: readonly { path?: readonly unknown[] }[];
}) {
  const key = result.issues[0]?.path?.[0];
  if (typeof key !== "string") return undefined;
  const route = result.definition as {
    phases: {
      model: { params: Record<string, { cli?: { syntax?: { type: string; label: string } } }> };
    }[];
  };
  const syntax = route.phases.map((p) => p.model.params[key]?.cli?.syntax).find(Boolean);
  if (syntax?.type !== "option") return key;
  return syntax.label.split(/[\s,]+/).find((t) => t.startsWith("--")) ?? key;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(t + "\n"));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(t + "\n"));
  const args = normalizeArgv(rewriteAliases(argv));
  // Errors before the router has bound --json still need to honour it.
  const wantsJson = args.includes("--json");
  const stdoutTTY = deps.stdoutTTY ?? !!process.stdout.isTTY;
  const stderrTTY = deps.stderrTTY ?? !!process.stderr.isTTY;
  const color = stderrTTY && !env.NO_COLOR && !args.includes("--no-color");

  const parsed = parse(app, { argv: args });
  if (!parsed.ok) {
    if (parsed.code === "method-not-allowed" && parsed.method === "execute") {
      // `tray` or `tray domain` on its own: its help, like --help.
      const help = parse(app, { argv: [...parsed.path, "--help"] });
      if (help.ok && help.method === "help") {
        stdout(helpText(help));
        return EXIT.ok;
      }
    }
    const err =
      parsed.code === "unprocessable-content"
        ? usageFailure(parsed, args)
        : new TrayError(printErrors(parsed).trim(), "invalid_usage", EXIT.usage);
    stderr(formatError(err, { json: wantsJson, color }));
    return err.exit;
  }
  if (parsed.method === "help") {
    stdout(helpText(parsed));
    return EXIT.ok;
  }
  if (parsed.method === "version") {
    stdout(wantsJson ? JSON.stringify({ version: VERSION }) : printVersion(parsed));
    return EXIT.ok;
  }

  const g = mergeGlobals(parsed.models as Record<string, Partial<Globals>>);
  const dir = configDir(env);
  const mode = detectMode({
    json: g.json,
    nonInteractive: g.nonInteractive,
    stdinTTY: deps.stdinTTY ?? !!process.stdin.isTTY,
    stdoutTTY,
    stderrTTY,
    noColor: g.noColor,
    env,
  });
  const ctx: Ctx = {
    mode,
    yes: g.yes,
    domainFlag: g.domain,
    env,
    configDir: dir,
    keyStore:
      deps.keyStore ??
      defaultKeyStore(dir, {
        macosSigned: MACOS_SIGNED,
        // Someone at an interactive terminal can answer an OS keychain prompt; agents and CI can't.
        timeoutMs: mode.interactive ? KEYCHAIN_INTERACTIVE_TIMEOUT_MS : KEYCHAIN_TIMEOUT_MS,
      }),
    fetch: deps.fetch,
    sleep: deps.sleep,
    stdout,
    stderr,
    argv: argv.filter((a) => a !== "--yes" && a !== "-y"),
    noOpen: g.noOpen,
    debug: g.debug,
  };

  try {
    await run(ctx, parsed);
    return EXIT.ok;
  } catch (e) {
    const err =
      e instanceof TrayError
        ? e
        : new TrayError((e as Error)?.message ?? String(e), "internal", EXIT.failed);
    stderr(
      formatError(err, { json: ctx.mode.json, color: ctx.mode.color, warnings: ctx.warnings }),
    );
    return err.exit;
  }
}

type Execute = Extract<ReturnType<typeof parse<typeof app>>, { method: "execute" }>;

async function run(ctx: Ctx, intent: Execute): Promise<void> {
  switch (intent.route) {
    case "/put": {
      const m = intent.model;
      return put(ctx, {
        paths: m.path,
        site: m.site,
        private: m.private,
        spa: m.spa,
        replace: m.replace,
      });
    }
    case "/list":
      return list(ctx);
    case "/open":
      return open(ctx, intent.model.site);
    case "/edit":
      return edit(ctx, intent.model.site, intent.model.visibility);
    case "/rollback":
      return rollback(ctx, intent.model.site, intent.model.to);
    case "/deploys":
      return deploys(ctx, intent.model.site, {
        limit: intent.model.limit,
        next: intent.model.next,
      });
    case "/remove":
      return remove(ctx, intent.model.site);
    case "/share":
      return share(ctx, intent.model.site, intent.model.entries);
    case "/unshare":
      return unshare(ctx, intent.model.site, intent.model.entries);
    case "/domain/add":
      return domainAdd(ctx, intent.model.host, intent.model.site);
    case "/domain/remove":
      return domainRemove(ctx, intent.model.host);
    case "/domain/list":
      return domainList(ctx, intent.model.site);
    case "/login":
      return login(ctx, intent.model.loginDomain, intent.model.name);
    case "/approve":
      return approve(ctx, intent.model.code);
    case "/logout":
      return logout(ctx, intent.model.logoutDomain);
    case "/whoami":
      return whoami(ctx);
    case "/skill":
      return printGuide(ctx);
    case "/skill/install":
      return skillInstall(ctx, intent.model.project);
    case "/account/list":
      return accountList(ctx);
    case "/account/switch":
      return accountSwitch(ctx, intent.model.switchDomain);
    case "/key/create":
      return keyCreate(ctx, intent.model.name);
    case "/key/list":
      return keyList(ctx);
    case "/key/revoke":
      return keyRevoke(ctx, intent.model.keyName);
    case "/setup":
      return setup(ctx, intent.model.email, { newToken: intent.model.newToken });
    case "/upgrade":
      return upgrade(ctx, { to: intent.model.upgradeVersion });
  }
}
