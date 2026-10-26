import { parse, printErrors, printVersion } from "@bomb.sh/router";
import { app, rewriteAliases } from "./app.ts";
import { accountList, accountSwitch, approve, login, logout, whoami } from "./commands/auth.ts";
import { domainAdd, domainList, domainRemove } from "./commands/domain.ts";
import { keyCreate, keyList, keyRevoke } from "./commands/key.ts";
import { put } from "./commands/put.ts";
import { setup, upgrade } from "./commands/setup.ts";
import { share, unshare } from "./commands/share.ts";
import { edit, list, open, remove, rollback } from "./commands/sites.ts";
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
import { printGuide, skillInstall } from "./skill.ts";

export interface MainDeps {
  env?: Record<string, string | undefined>;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
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
  domain?: string;
}

/** Global flags can appear on any route along the path; merge them (deepest `--domain` wins). */
export function mergeGlobals(models: Record<string, Partial<Globals>>): Globals {
  const g: Globals = { json: false, nonInteractive: false, yes: false };
  for (const m of Object.values(models)) {
    g.json ||= !!m.json;
    g.nonInteractive ||= !!m.nonInteractive;
    g.yes ||= !!m.yes;
    if (m.domain) g.domain = m.domain;
  }
  return g;
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
  const args = rewriteAliases(argv);
  // Errors before the router has bound --json still need to honour it.
  const wantsJson = args.includes("--json");
  const stdoutTTY = deps.stdoutTTY ?? !!process.stdout.isTTY;

  const parsed = parse(app, { argv: args });
  if (!parsed.ok) {
    if (parsed.code === "method-not-allowed" && parsed.method === "execute") {
      // `tray` or `tray domain` on its own: show help for that route.
      const help = parse(app, { argv: [...parsed.path, "--help"] });
      if (help.ok && help.method === "help") {
        if (parsed.path.length === 0) {
          stdout(helpText(help));
          return EXIT.ok;
        }
        stderr(helpText(help));
        return EXIT.usage;
      }
    }
    const message = printErrors(parsed).trim();
    const err = new TrayError(
      message,
      "invalid_usage",
      EXIT.usage,
      `Run \`tray ${parsed.path.join(" ")}${parsed.path.length ? " " : ""}--help\`.`,
      parsed.code === "unprocessable-content" ? badParam(parsed) : undefined,
    );
    (wantsJson ? stdout : stderr)(formatError(err, wantsJson, wantsJson && stdoutTTY));
    return err.exit;
  }
  if (parsed.method === "help") {
    stdout(helpText(parsed));
    return EXIT.ok;
  }
  if (parsed.method === "version") {
    stdout(printVersion(parsed));
    return EXIT.ok;
  }

  const g = mergeGlobals(parsed.models as Record<string, Partial<Globals>>);
  const dir = configDir(env);
  const mode = detectMode({
    json: g.json,
    nonInteractive: g.nonInteractive,
    stdinTTY: deps.stdinTTY ?? !!process.stdin.isTTY,
    stdoutTTY,
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
  };

  try {
    await run(ctx, parsed);
    return EXIT.ok;
  } catch (e) {
    const err =
      e instanceof TrayError
        ? e
        : new TrayError((e as Error)?.message ?? String(e), "internal", EXIT.failed);
    (ctx.mode.json ? stdout : stderr)(formatError(err, ctx.mode.json, ctx.mode.prettyJson));
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
      return setup(ctx, intent.model.email);
    case "/upgrade":
      return upgrade(ctx);
  }
}
