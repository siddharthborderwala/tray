import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The agent skill served at /skill.md: the repo's skills/tray/SKILL.md, verbatim. */
const SOURCE = join(process.cwd(), "../../skills/tray/SKILL.md");

export function skillText(): string {
  // Fail the build rather than publish a stale or made-up skill.
  if (!existsSync(SOURCE)) throw new Error(`agent skill not found at ${SOURCE}`);
  return readFileSync(SOURCE, "utf8");
}

/** `description:` from the skill's frontmatter (plain, quoted, or a `>`/`|` block). */
export function skillDescription(text = skillText()): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const lines = front.split("\n");
  const i = lines.findIndex((l) => l.startsWith("description:"));
  if (i < 0) return "";
  const value = (lines[i] ?? "").slice("description:".length).trim();
  if (!/^[>|][+-]?$/.test(value)) return value.replace(/^["']|["']$/g, "");
  const block: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return (value.startsWith(">") ? block.join(" ") : block.join("\n")).trim();
}

/** sha256 of the exact bytes served at /skill.md. */
export function skillDigest(text = skillText()): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
