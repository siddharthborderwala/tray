// The Tray agent skill: embedded at build time, printed by `tray skill`,
// installed into coding agents' skill folders by `tray skill install`.
import * as p from "@clack/prompts";
import { parse } from "@bomb.sh/router";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import skillMd from "../../../skills/tray/SKILL.md" with { type: "text" };
import guideMd from "../../../skills/tray/guide.md" with { type: "text" };
import { app } from "./app.ts";
import { loadAccounts } from "./config.ts";
import { result, type Ctx } from "./ctx.ts";
import { helpText } from "./help.ts";
import { VERSION } from "./version.ts";

export const SKILL_MD: string = skillMd;

/** SKILL.md without its YAML frontmatter. */
export function skillBody(md: string = SKILL_MD): string {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

/** Every executable route, e.g. `["put"]`, `["domain", "add"]`, `["skill", "install"]`. */
export function commandPaths(): string[][] {
  const out: string[][] = [];
  const walk = (node: any, path: string[]) => {
    if (path.length && node.methods.includes("execute")) out.push(path);
    for (const phase of node.phases)
      for (const child of phase.routes) walk(child, [...path, child.name]);
  };
  walk(app, []);
  return out;
}

const GLOBAL_FLAG =
  /^\s+(--json|--non-interactive|--yes, -y|--domain <DOMAIN>|-h, --help|-v, --version)\s/;

/** Drop the global flags (listed once at the top of the guide), including their wrapped lines. */
export function dropGlobalFlags(help: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of help.split("\n")) {
    if (GLOBAL_FLAG.test(line)) dropping = true;
    else if (!(dropping && /^\s{8,}\S/.test(line))) dropping = false;
    if (!dropping) out.push(line);
  }
  return out.join("\n");
}

/** `tray skill`: the skill, every command's help (generated from the router), then guide.md. */
export function fullGuide(): string {
  const commands = commandPaths().map((path) => {
    const help = parse(app, { argv: [...path, "--help"] });
    if (!help.ok || help.method !== "help") return `tray ${path.join(" ")}`;
    return dropGlobalFlags(helpText(help))
      .trimEnd()
      .replace(/\n+Options:$/, "");
  });
  return [
    `# Tray agent guide (tray ${VERSION})`,
    skillBody().replace(/^# .*\n+/, ""),
    "## Commands",
    "Global flags on every command: `--json`, `--non-interactive`, `-y, --yes`, `--domain <DOMAIN>`, `-h, --help`.",
    ...commands.map((c) => "```\n" + c + "\n```"),
    guideMd.trim(),
  ].join("\n\n");
}

export async function printGuide(ctx: Ctx): Promise<void> {
  result(ctx, fullGuide(), { version: VERSION, guide: fullGuide() });
}

// --- install ---------------------------------------------------------------------

export interface InstallTargets {
  home: string;
  cwd: string;
  project: boolean;
}

/** Directories that get `tray/SKILL.md`. */
export function skillDirs({ home, cwd, project }: InstallTargets): string[] {
  if (project) return [join(cwd, ".agents/skills/tray"), join(cwd, ".claude/skills/tray")];
  const dirs = [join(home, ".agents/skills/tray"), join(home, ".claude/skills/tray")];
  if (existsSync(join(home, ".hermes"))) dirs.push(join(home, ".hermes/skills/tray"));
  return dirs;
}

/**
 * Write `file` only if it's a regular file (or missing), never through a symlink,
 * and, for a project install, only inside the project. A cloned repo can't
 * point `.claude/skills/tray/SKILL.md` at `~/.bashrc` and have us overwrite it.
 */
function writeSkillFile(file: string, content: string, root?: string): boolean {
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
  } catch {} // missing is fine
  if (root) {
    const real = realpathSync(dirname(file));
    const base = realpathSync(root);
    if (real !== base && !real.startsWith(base + sep)) return false;
  }
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = constants;
  const fd = openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The regular file at `file`, or null (missing or a symlink). */
function readSkillFile(file: string): string | null {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** Write SKILL.md into each directory as a real file. Idempotent; returns the files written or already current. */
export function installSkill(
  targets: InstallTargets,
  content: string = SKILL_MD,
): { written: string[]; unchanged: string[]; skipped: string[] } {
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  const root = targets.project ? targets.cwd : undefined;
  for (const dir of skillDirs(targets)) {
    const file = join(dir, "SKILL.md");
    if (readSkillFile(file) === content) {
      unchanged.push(file);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    (writeSkillFile(file, content, root) ? written : skipped).push(file);
  }
  return { written, unchanged, skipped };
}

/** One line for agents whose sandboxes block the network by default. */
export function networkHint(home: string, domain?: string): string | undefined {
  const agents = [
    existsSync(join(home, ".codex")) && "Codex",
    existsSync(join(home, ".cursor")) && "Cursor",
  ].filter(Boolean);
  if (agents.length === 0) return undefined;
  return `${agents.join(" and ")} sandboxes block the network by default; allow tray.${domain ?? "<your-domain>"} there (see \`tray skill\`).`;
}

const homeOf = (ctx: Ctx) => ctx.env.HOME || homedir();
const domainOf = (ctx: Ctx) =>
  ctx.domainFlag || ctx.env.TRAY_DOMAIN || loadAccounts(ctx.configDir).current;

export async function skillInstall(ctx: Ctx, project: boolean): Promise<void> {
  const home = homeOf(ctx);
  const res = installSkill({ home, cwd: process.cwd(), project });
  const hint = networkHint(home, domainOf(ctx));
  if (hint && !ctx.mode.json) ctx.stderr(hint);
  const files = [...res.written, ...res.unchanged, ...res.skipped];
  const label = (f: string) =>
    res.written.includes(f)
      ? "wrote"
      : res.unchanged.includes(f)
        ? "up to date"
        : "skipped (a symlink, or outside this project)";
  result(ctx, files.map((f) => `${label(f)}  ${f}`).join("\n"), {
    ...res,
    ...(hint ? { hint } : {}),
  });
}

/**
 * "Add Tray to your coding agents? (Y/n)" at the end of `tray login` / `tray setup`.
 * Interactive only; declining or cancelling just skips it.
 */
export async function offerSkillInstall(ctx: Ctx): Promise<void> {
  if (!ctx.mode.interactive) return;
  const yes = await p.confirm({
    message: "Add Tray to your coding agents?",
    initialValue: true,
    output: process.stderr,
  });
  if (p.isCancel(yes) || !yes) return;
  const home = homeOf(ctx);
  const { written, unchanged } = installSkill({ home, cwd: process.cwd(), project: false });
  p.log.success(
    `Skill installed in ${written.length + unchanged.length} places (tray skill install --project for this repo)`,
    { output: process.stderr },
  );
  const hint = networkHint(home, domainOf(ctx));
  if (hint) p.log.info(hint, { output: process.stderr });
}

/** For `tray upgrade`: rewrite copies that are already installed, without adding new ones. */
export function refreshInstalledSkills(home: string, cwd: string): string[] {
  const dirs = [
    ...skillDirs({ home, cwd, project: false }).map((dir) => ({ dir, root: undefined })),
    ...skillDirs({ home, cwd, project: true }).map((dir) => ({ dir, root: cwd })),
  ];
  const refreshed: string[] = [];
  for (const { dir, root } of dirs) {
    const file = join(dir, "SKILL.md");
    const current = readSkillFile(file);
    if (current !== null && current !== SKILL_MD && writeSkillFile(file, SKILL_MD, root))
      refreshed.push(file);
  }
  return refreshed;
}
