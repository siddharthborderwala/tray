// Help text, rendered from the router's route definitions plus the examples
// and notes below. Root help groups commands by task; command help lists only
// its own options, then examples (each parsed in a test), notes and a docs link.
import type { printHelp } from "@bomb.sh/router";

type Intent = Parameters<typeof printHelp>[0];
interface Param {
  description?: string;
  cli?: { syntax?: { type: string; label: string } };
}
interface RouteDef {
  name: string;
  description?: string;
  version?: string;
  methods: string[];
  phases: { routes: RouteDef[]; model: { params: Record<string, Param> } }[];
}

const DOCS = "https://tray.sh/cli";
const WIDTH = 80;
const GLOBAL_KEYS = new Set([
  "json",
  "nonInteractive",
  "yes",
  "domain",
  "noColor",
  "noOpen",
  "debug",
]);

/** Root help, by task. Every top-level command appears in exactly one group. */
const GROUPS: [string, string[]][] = [
  ["Publish", ["put", "list", "open", "deploys", "rollback", "remove"]],
  ["Access", ["edit", "share", "unshare"]],
  ["Domains", ["domain"]],
  ["Account", ["login", "logout", "whoami", "account", "key", "approve"]],
  ["Setup", ["setup", "upgrade", "skill"]],
];

/** Per command: 1–3 examples (parsed by a test) and notes. Keyed by path. */
export const EXAMPLES: Record<string, string[]> = {
  put: [
    "tray put ./dist --site q3-review",
    "tray put report.pdf",
    "tray put - --site notes < page.html",
  ],
  list: ["tray list", "tray list --json"],
  open: ["tray open q3-review"],
  deploys: ["tray deploys q3-review", "tray deploys q3-review --limit 50"],
  rollback: ["tray rollback q3-review", "tray rollback q3-review --to mh7q2k1c-8f1a"],
  remove: ["tray remove q3-review", "tray remove q3-review --yes"],
  edit: ["tray edit q3-review --visibility private"],
  share: ["tray share q3-review", "tray share q3-review bob@acme.com @acme.com"],
  unshare: ["tray unshare q3-review bob@acme.com"],
  "domain add": ["tray domain add docs.acme.com --site q3-review"],
  "domain remove": ["tray domain remove docs.acme.com"],
  "domain list": ["tray domain list", "tray domain list --site q3-review"],
  login: ["tray login acme.dev"],
  logout: ["tray logout"],
  whoami: ["tray whoami", "tray whoami --json"],
  approve: ["tray approve QXFT-7K2M"],
  "account list": ["tray account list"],
  "account switch": ["tray account switch acme.dev"],
  "key create": ["tray key create --name ci"],
  "key list": ["tray key list"],
  "key revoke": ["tray key revoke ci"],
  skill: ["tray skill"],
  "skill install": ["tray skill install", "tray skill install --project"],
  setup: ["tray setup --domain acme.dev --email you@acme.dev"],
  upgrade: ["tray upgrade"],
};

const NOTES: Record<string, string[]> = {
  put: [
    "Without --site, the name comes from the folder or file (the parent folder for dist, out, build, public, site, _site, www).",
    "Without index.html, Tray adds a page that lists the files.",
  ],
  open: ["Non-interactive, it only prints the URL."],
  rollback: [
    "Interactive with no --to, you pick from recent deploys. Non-interactive, --to is required.",
  ],
  whoami: ["Never prompts, so it's safe in scripts."],
  share: ["With no emails, it lists who can see the site."],
};

const ROOT_FOOTER = `Environment:
  TRAY_DOMAIN           Tray to use (e.g. acme.dev)
  TRAY_API_KEY          API key; overrides the saved login
  CLOUDFLARE_API_TOKEN  Used by tray setup and tray upgrade
  NO_COLOR, CI          Respected; CI implies --non-interactive
  AGENT, AI_AGENT       Agent detected (also CLAUDECODE, CURSOR_AGENT, GEMINI_CLI,
                        CODEX_THREAD_ID): non-interactive, like CI
  TRAY_INTERACTIVE      1 forces interactive mode (TTYs still required)

Exit codes: 0 ok · 1 failed · 2 bad usage or missing input · 4 not logged in · 130 canceled`;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...lines, line] : lines;
}

function rows(items: [string, string | undefined][]): string[] {
  const size = Math.max(...items.map(([l]) => l.length));
  const room = Math.max(24, WIDTH - size - 4);
  return items.flatMap(([label, desc]) => {
    if (!desc) return [`  ${label}`];
    const [first, ...rest] = wrap(desc, room);
    return [`  ${label.padEnd(size)}  ${first}`, ...rest.map((l) => " ".repeat(size + 4) + l)];
  });
}

const params = (route: RouteDef) =>
  route.phases.flatMap((p) => Object.entries(p.model.params)) as [string, Param][];

/** `compact`: for the agent guide (no -h, no global-options footer, no empty Options). */
export function helpText(intent: Intent, { compact = false } = {}): string {
  const route = intent.definition as unknown as RouteDef;
  const path = intent.path.join(" ");
  const children = route.phases.flatMap((p) => p.routes);
  const own = params(route).filter(
    ([k, p]) => p.cli?.syntax && (path === "" || !GLOBAL_KEYS.has(k)),
  );
  const args = own.filter(([, p]) => p.cli!.syntax!.type === "argument");
  const options = own.filter(([, p]) => p.cli!.syntax!.type !== "argument");
  const subject = path ? `tray ${path}` : "tray";
  const lines = [route.version ? `${subject} ${route.version}` : subject];
  if (route.description) lines.push(...wrap(route.description, WIDTH));

  const usage = [subject, "[OPTIONS]", ...args.map(([, p]) => p.cli!.syntax!.label)];
  if (children.length) usage.push(route.methods.includes("execute") ? "[COMMAND]" : "<COMMAND>");
  lines.push("", "Usage:", `  ${usage.join(" ")}`);
  if (args.length)
    lines.push(
      "",
      "Arguments:",
      ...rows(args.map(([, p]) => [p.cli!.syntax!.label, p.description])),
    );

  if (path === "") {
    const byName = new Map(children.map((c) => [c.name, c]));
    for (const [group, names] of GROUPS)
      lines.push("", `${group}:`, ...rows(names.map((n) => [n, byName.get(n)?.description])));
  } else if (children.length) {
    lines.push("", "Commands:", ...rows(children.map((c) => [c.name, c.description])));
  }

  const opts: [string, string | undefined][] = options.map(([, p]) => [
    p.cli!.syntax!.label,
    p.description,
  ]);
  if (!compact) opts.push(["-h, --help", "Print help"]);
  if (route.methods.includes("version")) opts.push(["-v, --version", "Print the version"]);
  if (opts.length) lines.push("", path === "" ? "Global options:" : "Options:", ...rows(opts));

  const examples = EXAMPLES[path];
  if (examples) lines.push("", "Examples:", ...examples.map((e) => `  ${e}`));
  const notes = NOTES[path];
  if (notes)
    lines.push("", "Notes:", ...notes.flatMap((n) => wrap(n, WIDTH - 2).map((l) => `  ${l}`)));

  if (compact) return lines.join("\n");
  if (path === "") lines.push("", ROOT_FOOTER, "", `Learn more: ${DOCS}`);
  else
    lines.push(
      "",
      ...wrap(
        "Global options: --json, --non-interactive, --yes, --domain, --no-color, --no-open, --debug (see tray --help)",
        WIDTH,
      ),
      `Learn more: ${DOCS}#${intent.path[0]}`,
    );
  return lines.join("\n");
}
