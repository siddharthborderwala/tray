// scripts/install.sh: PATH handling. The download part isn't exercised; the
// script's functions are sourced without running `main`.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers.ts";

const SCRIPT = join(import.meta.dir, "../../../scripts/install.sh");

/** Source install.sh minus its last line (`main "$@"`) and run `setup_path <dir>`. */
function setupPath(env: Record<string, string>, dir: string) {
  const lib = join(tmp(), "install-lib.sh");
  const src = readFileSync(SCRIPT, "utf8").trimEnd();
  expect(src.endsWith('main "$@"')).toBe(true);
  writeFileSync(lib, src.slice(0, -'main "$@"'.length));
  const res = Bun.spawnSync(["sh", "-c", `. "$0"; setup_path "$1"`, lib, dir], {
    env: { PATH: "/usr/bin:/bin", ...env },
  });
  return { code: res.exitCode, out: res.stdout.toString() };
}

describe("install.sh", () => {
  test("is valid POSIX sh", () => {
    expect(Bun.spawnSync(["sh", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("zsh: appends one export to ~/.zshrc, using $HOME, and only once", () => {
    const home = tmp();
    const dir = join(home, ".tray/bin");
    const first = setupPath({ HOME: home, SHELL: "/bin/zsh" }, dir);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Restart your shell");
    setupPath({ HOME: home, SHELL: "/bin/zsh" }, dir);
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc).toBe('\n# tray\nexport PATH="$HOME/.tray/bin:$PATH"\n');
  });

  test("bash: ~/.bashrc, plus ~/.bash_profile on macOS", () => {
    const home = tmp();
    setupPath({ HOME: home, SHELL: "/bin/bash" }, join(home, ".tray/bin"));
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toContain(
      'export PATH="$HOME/.tray/bin:$PATH"',
    );
    expect(existsSync(join(home, ".bash_profile"))).toBe(process.platform === "darwin");
  });

  test("an rc file that already has the dir is left alone", () => {
    const home = tmp();
    writeFileSync(join(home, ".zshrc"), 'export PATH="$HOME/.tray/bin:$PATH"\n');
    setupPath({ HOME: home, SHELL: "/bin/zsh" }, join(home, ".tray/bin"));
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(
      'export PATH="$HOME/.tray/bin:$PATH"\n',
    );
  });

  test("TRAY_NO_MODIFY_PATH=1 skips rc files but still prints the export", () => {
    const home = tmp();
    const r = setupPath(
      { HOME: home, SHELL: "/bin/zsh", TRAY_NO_MODIFY_PATH: "1" },
      "/opt/tray/bin",
    );
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(r.out).toContain('export PATH="/opt/tray/bin:$PATH"');
  });

  test("GITHUB_PATH gets the bin dir", () => {
    const home = tmp();
    const gh = join(home, "github_path");
    setupPath(
      { HOME: home, SHELL: "/bin/zsh", GITHUB_PATH: gh, TRAY_NO_MODIFY_PATH: "1" },
      "/opt/tray/bin",
    );
    expect(readFileSync(gh, "utf8")).toBe("/opt/tray/bin\n");
  });

  test("unknown shells use ~/.profile", () => {
    const home = tmp();
    setupPath({ HOME: home, SHELL: "/bin/dash" }, "/opt/tray/bin");
    expect(readFileSync(join(home, ".profile"), "utf8")).toContain(
      'export PATH="/opt/tray/bin:$PATH"',
    );
  });
});
