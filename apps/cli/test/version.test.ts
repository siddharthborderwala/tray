// SPEC §6: one version for the CLI, the Worker bundle it embeds, and the skill.
// `tray upgrade` and the tray-version warning compare these, so drift breaks both.
import { expect, test } from "bun:test";
import worker from "../../worker/package.json" with { type: "json" };
import cli from "../package.json" with { type: "json" };
import { SKILL_MD } from "../src/skill.ts";
import { VERSION } from "../src/version.ts";

test("CLI, Worker and skill share one version", () => {
  expect(VERSION).toBe(cli.version);
  expect(worker.version).toBe(cli.version);
  expect(SKILL_MD).toContain(`version: ${cli.version}\n`);
});
