// Every command, argument and flag, declared once with @bomb.sh/router.
import {
  argument,
  cli,
  command,
  description,
  extend,
  multiple,
  name,
  option,
  route,
  schema,
  toggle,
  version,
} from "@bomb.sh/router";
import {
  DeployId,
  Email,
  HostnameInput,
  ShareEntry,
  SiteName,
  TrayDomainInput,
} from "@tray-sh/schema";
import * as z from "zod";
import { VERSION } from "./version.ts";

/** Override the placeholder shown in help, e.g. `<DOMAIN>` for an argument keyed `loginDomain`. */
const label = (text: string) =>
  ((param: any) => ({
    ...param,
    cli: { ...param.cli, syntax: { ...param.cli.syntax, label: text } },
  })) as unknown as ReturnType<typeof description>;

const required = (label: string) => z.string({ error: `missing ${label}` });
const optional = () => z.string().optional();
/** A required value parsed by a shared schema, with "missing <label>" when absent. */
const requiredAs = <T>(label: string, s: z.ZodType<T, string>) => required(label).pipe(s);

/** A boolean flag that reads as `--name` (and an optional short form), without `--no-name`. */
const flag = <const N extends string>(key: N, long: string, desc: string, short?: string) =>
  toggle(name(key), cli(short ? [long, short] : [long], { switch: true }), description(desc));

/** Global flags. Mounted on every route so they work in any position. */
const globals = extend(
  flag(
    "json",
    "--json",
    "Print one JSON object to stdout (results and errors). Implies --non-interactive.",
  ),
  flag("nonInteractive", "--non-interactive", "Never prompt. Missing input is an error."),
  flag("yes", "--yes", "Accept confirmations.", "-y"),
  option(
    name("domain"),
    label("--domain <DOMAIN>"),
    schema(TrayDomainInput.optional()),
    description("Use this tray instead of the current account (e.g. acme.dev)."),
  ),
);

const site = (desc = "Site name.") =>
  argument(name("site"), schema(requiredAs("<site>", SiteName)), description(desc));
const siteFlag = (desc: string, s = SiteName.optional()) =>
  option(
    name("site"),
    cli(["--site", "-s"]),
    label("-s, --site <SITE>"),
    schema(s),
    description(desc),
  );

export const app = route(
  name("tray"),
  description("Turn a folder, a file, or a few files into a URL on your own domain."),
  version(VERSION),
  globals,

  command(
    name("put"),
    description(
      "Publish a folder, zip, HTML file, any other file (PDF, image…), several files, or - (HTML on stdin).",
    ),
    argument(
      name("path"),
      label("<PATH...>"),
      multiple(),
      schema(z.array(z.string(), { error: "missing <path>" }).min(1, "missing <path>")),
      description("Folder, .zip, .tar.gz, .html, any file, several files, or - for stdin."),
    ),
    siteFlag(
      "Site name. Default: slug of the folder or file name (the parent folder for dist, out, build, public, site, _site, www). No default for several files.",
    ),
    flag(
      "private",
      "--private",
      "Only the owner can view. Applies when creating (or with --replace).",
    ),
    flag("spa", "--spa", "Unknown paths serve /index.html."),
    flag("replace", "--replace", "Overwrite a site last put from a different source."),
    globals,
  ),
  command(name("list"), description("List sites. Alias: ls."), globals),
  command(
    name("open"),
    description("Open a site in the browser (prints the URL when non-interactive)."),
    site(),
    globals,
  ),
  command(
    name("edit"),
    description("Change a site's visibility."),
    site(),
    option(
      name("visibility"),
      label("--visibility <public|private>"),
      schema(z.enum(["public", "private"]).optional()),
      description("Make the site public or private."),
    ),
    globals,
  ),
  command(
    name("rollback"),
    description("Point a site at its previous deploy, or at --to."),
    site(),
    option(
      name("to"),
      label("--to <DEPLOY>"),
      schema(DeployId.optional()),
      description("Deploy id to make live."),
    ),
    globals,
  ),
  command(
    name("remove"),
    description("Delete a site and its custom domains. Alias: rm."),
    site(),
    globals,
  ),

  command(
    name("share"),
    description("Add people who can see a private site, or list them."),
    site(),
    argument(
      name("entries"),
      label("[EMAIL|@DOMAIN...]"),
      multiple(),
      schema(z.array(ShareEntry).default([])),
      description("Emails or @domain."),
    ),
    globals,
  ),
  command(
    name("unshare"),
    description("Remove people from a private site."),
    site(),
    argument(
      name("entries"),
      label("<EMAIL|@DOMAIN...>"),
      multiple(),
      schema(
        z.array(ShareEntry, { error: "missing <email|@domain>" }).min(1, "missing <email|@domain>"),
      ),
      description("Emails or @domain."),
    ),
    globals,
  ),

  route(
    name("domain"),
    description("Custom domains. Alias: domains."),
    globals,
    command(
      name("add"),
      description("Attach a custom host to a site."),
      argument(
        name("host"),
        schema(requiredAs("<host>", HostnameInput)),
        description("Hostname, e.g. docs.acme.com."),
      ),
      siteFlag("Site to attach the host to."),
      globals,
    ),
    command(
      name("remove"),
      description("Detach a custom host. Alias: rm."),
      argument(name("host"), schema(requiredAs("<host>", HostnameInput))),
      globals,
    ),
    command(
      name("list"),
      description("List custom hosts. Alias: ls."),
      siteFlag("Only hosts for this site."),
      globals,
    ),
  ),

  command(
    name("login"),
    description("Log in to a tray with the device-code flow."),
    argument(
      name("loginDomain"),
      label("[DOMAIN]"),
      schema(TrayDomainInput.optional()),
      description("Tray domain, e.g. acme.dev."),
    ),
    option(
      name("name"),
      label("--name <NAME>"),
      schema(optional()),
      description("Device / key name. Default: hostname."),
    ),
    globals,
  ),
  command(
    name("approve"),
    description("Approve a login code from another device."),
    argument(name("code"), schema(required("<code>"))),
    globals,
  ),
  command(
    name("logout"),
    description("Revoke this device's key and forget it."),
    argument(
      name("logoutDomain"),
      label("[DOMAIN]"),
      schema(TrayDomainInput.optional()),
      description("Tray domain. Default: current account."),
    ),
    globals,
  ),
  command(
    name("whoami"),
    description("Show the tray, account and credential in use. Never prompts."),
    globals,
  ),
  route(
    name("account"),
    description("Trays you are logged in to. Alias: accounts."),
    globals,
    command(name("list"), description("List accounts. Alias: ls."), globals),
    command(
      name("switch"),
      description("Set the current account."),
      argument(
        name("switchDomain"),
        label("<DOMAIN>"),
        schema(requiredAs("<domain>", TrayDomainInput)),
      ),
      globals,
    ),
  ),

  route(
    name("key"),
    description("API keys for agents and CI. Alias: keys."),
    globals,
    command(
      name("create"),
      description("Create an API key (shown once)."),
      option(name("name"), label("--name <NAME>"), schema(optional()), description("Key name.")),
      globals,
    ),
    command(name("list"), description("List API keys. Alias: ls."), globals),
    command(
      name("revoke"),
      description("Revoke an API key."),
      argument(name("keyName"), label("<NAME>"), schema(required("<name>"))),
      globals,
    ),
  ),

  command(
    name("skill"),
    description("Print the full agent guide for this version of tray."),
    globals,
    command(
      name("install"),
      description("Install the Tray skill for coding agents (~/.agents, ~/.claude)."),
      flag(
        "project",
        "--project",
        "Write .agents/ and .claude/ skills in the current folder instead.",
      ),
      globals,
    ),
  ),
  command(
    name("setup"),
    description("Provision a tray on your Cloudflare account."),
    option(
      name("email"),
      label("--email <EMAIL>"),
      schema(Email.optional()),
      description("Your email (owner)."),
    ),
    globals,
  ),
  command(name("upgrade"), description("Replace this binary with the latest release."), globals),
);

/** Command aliases, per route level. The router matches names exactly, so argv is rewritten first. */
const ALIASES: Record<string, Record<string, string>> = {
  "": { ls: "list", rm: "remove", domains: "domain", accounts: "account", keys: "key" },
  domain: { ls: "list", rm: "remove" },
  account: { ls: "list" },
  key: { ls: "list" },
};
const GROUPS = new Set(["domain", "account", "key"]);
const VALUE_FLAGS = new Set([
  "--domain",
  "--site",
  "-s",
  "--visibility",
  "--to",
  "--name",
  "--email",
]);

/** Rewrite `tray ls` → `tray list`, `tray domains rm x` → `tray domain remove x`. Only command words are touched. */
export function rewriteAliases(argv: string[]): string[] {
  const out = [...argv];
  let level = "";
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    const word = ALIASES[level]?.[a] ?? a;
    out[i] = word;
    if (level === "" && GROUPS.has(word)) {
      level = word;
      continue;
    }
    break; // first non-group word is the command; everything after is arguments
  }
  return out;
}
