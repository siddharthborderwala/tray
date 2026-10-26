import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SKILL_MD,
  commandPaths,
  dropGlobalFlags,
  fullGuide,
  installSkill,
  networkHint,
  refreshInstalledSkills,
  skillBody,
  skillDirs,
} from "../src/skill.ts";
import { VERSION } from "../src/version.ts";
import { tmp } from "./helpers.ts";

/** Minimal frontmatter reader: top-level `key: value`, `key: >-` blocks and one nested map. */
function frontmatter(md: string): Record<string, any> {
  const block = md.match(/^---\n([\s\S]*?)\n---\n/)![1]!;
  const out: Record<string, any> = {};
  let key = "";
  for (const line of block.split("\n")) {
    const top = line.match(/^([a-z-]+):\s*(.*)$/);
    if (top) {
      key = top[1]!;
      out[key] = top[2] === ">-" || top[2] === "" ? "" : top[2];
      continue;
    }
    const nested = line.match(/^ {2}([a-z-]+):\s*(.+)$/);
    if (nested && typeof out[key] !== "string") (out[key] ??= {})[nested[1]!] = nested[2];
    else if (nested && out[key] === "" && key === "metadata")
      out[key] = { [nested[1]!]: nested[2] };
    else out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

describe("SKILL.md", () => {
  const fm = frontmatter(SKILL_MD);

  test("frontmatter has the required fields", () => {
    expect(fm.name).toBe("tray");
    expect(fm.license).toBe("MIT");
    expect(fm["allowed-tools"]).toBe("Bash(tray:*)");
    expect(fm.compatibility).toContain("tray");
    expect(fm.metadata.version).toBe(VERSION); // version-matched to the CLI
    expect(fm.metadata.author).toBeTruthy();
  });

  test("description is pushy: real phrases, and 'even if the user doesn't mention tray'", () => {
    for (const phrase of [
      "share this",
      "send me a link",
      "host this",
      "publish the report",
      "make it viewable",
    ]) {
      expect(fm.description).toContain(phrase);
    }
    expect(fm.description).toContain("even if the user doesn't mention tray");
  });

  test("body is short and covers the workflow", () => {
    const body = skillBody();
    expect(body.split("\n").length).toBeLessThan(75);
    for (const s of [
      "tray whoami --json",
      "tray put",
      "-s ",
      "--private",
      "--spa",
      "site_exists",
      "tray skill",
      "https://tray.sh/llms.txt",
    ]) {
      expect(body).toContain(s);
    }
    expect(body).not.toContain("MUST");
  });
});

describe("tray skill guide", () => {
  test("covers every command, generated from the router", () => {
    const guide = fullGuide();
    const paths = commandPaths().map((p) => p.join(" "));
    expect(paths).toContain("put");
    expect(paths).toContain("domain add");
    expect(paths).toContain("skill install");
    expect(paths).toContain("whoami");
    for (const p of paths) expect(guide).toContain(`tray ${p} [OPTIONS]`);
  });

  test("includes the version, JSON shapes and exit codes", () => {
    const guide = fullGuide();
    expect(guide).toContain(`tray ${VERSION}`);
    expect(guide).toContain('"code":"site_exists"');
    for (const code of ["| 0 |", "| 1 |", "| 2 |", "| 4 |", "| 130 |"])
      expect(guide).toContain(code);
    expect(guide).not.toContain("license: MIT"); // no frontmatter
  });

  test("dropGlobalFlags removes global flags and their wrapped lines only", () => {
    const help = [
      "Options:",
      "  --spa              Unknown paths serve /index.html.",
      "  --json             Print one JSON object to stdout (results and errors).",
      "                     Implies --non-interactive.",
      "  -h, --help         Print help",
      "  --replace          Overwrite a site.",
    ].join("\n");
    expect(dropGlobalFlags(help)).toBe(
      [
        "Options:",
        "  --spa              Unknown paths serve /index.html.",
        "  --replace          Overwrite a site.",
      ].join("\n"),
    );
  });
});

describe("tray skill install", () => {
  test("user install: ~/.agents and ~/.claude, plus ~/.hermes only if it exists", () => {
    const home = tmp();
    expect(skillDirs({ home, cwd: "/x", project: false })).toEqual([
      join(home, ".agents/skills/tray"),
      join(home, ".claude/skills/tray"),
    ]);
    mkdirSync(join(home, ".hermes"));
    expect(skillDirs({ home, cwd: "/x", project: false })).toContain(
      join(home, ".hermes/skills/tray"),
    );
  });

  test("--project writes into the current folder", () => {
    expect(skillDirs({ home: "/h", cwd: "/repo", project: true })).toEqual([
      "/repo/.agents/skills/tray",
      "/repo/.claude/skills/tray",
    ]);
  });

  test("writes real files and is idempotent", () => {
    const home = tmp();
    const first = installSkill({ home, cwd: "/x", project: false });
    expect(first.written.length).toBe(2);
    for (const f of first.written) expect(readFileSync(f, "utf8")).toBe(SKILL_MD);
    const again = installSkill({ home, cwd: "/x", project: false });
    expect(again.written).toEqual([]);
    expect(again.unchanged).toEqual(first.written);
  });

  test("an outdated copy is rewritten", () => {
    const home = tmp();
    const file = join(home, ".claude/skills/tray/SKILL.md");
    mkdirSync(join(home, ".claude/skills/tray"), { recursive: true });
    writeFileSync(file, "old");
    expect(installSkill({ home, cwd: "/x", project: false }).written).toContain(file);
  });

  test("refreshInstalledSkills only touches copies that exist", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(join(home, ".claude/skills/tray"), { recursive: true });
    writeFileSync(join(home, ".claude/skills/tray/SKILL.md"), "old");
    expect(refreshInstalledSkills(home, cwd)).toEqual([join(home, ".claude/skills/tray/SKILL.md")]);
    expect(existsSync(join(home, ".agents/skills/tray/SKILL.md"))).toBe(false);
  });

  test("network hint only when Codex or Cursor is installed", () => {
    const home = tmp();
    expect(networkHint(home)).toBeUndefined();
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    expect(networkHint(home, "acme.dev")).toBe(
      "Codex and Cursor sandboxes block the network by default; allow tray.acme.dev there (see `tray skill`).",
    );
  });
});
