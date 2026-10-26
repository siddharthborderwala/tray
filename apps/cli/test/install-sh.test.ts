// scripts/install.sh: target detection, the full download + verify + install
// path (against a stub `curl` serving a fake release), and PATH handling.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Source install.sh minus `main "$@"` and run one shell snippet. */
function sourced(snippet: string) {
  const lib = join(tmp(), "install-lib.sh");
  writeFileSync(lib, readFileSync(SCRIPT, "utf8").trimEnd().slice(0, -'main "$@"'.length));
  const res = Bun.spawnSync(["sh", "-c", `. "$0"; ${snippet}`, lib]);
  return { code: res.exitCode, out: res.stdout.toString().trim() };
}

/**
 * A fake GitHub release on disk and a stub `curl` that serves it, then
 * `sh install.sh`. `tamper` corrupts the archive after its checksum is taken.
 */
function install(opts: { tamper?: boolean; version?: string } = {}) {
  const target = sourced("detect_target").out;
  const root = tmp();
  const release = join(root, "release");
  const stage = join(root, "stage");
  const stubs = join(root, "stubs");
  for (const d of [release, stage, stubs]) mkdirSync(d, { recursive: true });

  writeFileSync(join(stage, "tray"), '#!/bin/sh\necho "tray 9.9.9"\n');
  chmodSync(join(stage, "tray"), 0o755);
  const archive = `tray-${target}.tar.gz`;
  Bun.spawnSync(["tar", "-czf", join(release, archive), "-C", stage, "tray"]);
  const sum = new Bun.CryptoHasher("sha256")
    .update(readFileSync(join(release, archive)))
    .digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${sum}  ${archive}\n`);
  if (opts.tamper) writeFileSync(join(release, archive), "not the archive");

  // curl --proto =https ... <url> -o <file>: copy the URL's last path segment from the
  // release dir. Refuses to run without https-only flags, so the script must pass them.
  writeFileSync(
    join(stubs, "curl"),
    `#!/bin/sh
case " $* " in *" --proto =https --proto-redir =https "*) ;; *) exit 1 ;; esac
prev=; for a; do [ "$prev" = -o ] && out="$a"; case "$a" in https://*) url="$a" ;; esac; prev="$a"; done
echo "$url" >> "${root}/urls"
cp "${release}/\${url##*/}" "$out"
`,
  );
  chmodSync(join(stubs, "curl"), 0o755);

  const home = join(root, "home");
  mkdirSync(home);
  const res = Bun.spawnSync(["sh", SCRIPT], {
    env: {
      PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      SHELL: "/bin/zsh",
      TRAY_NO_MODIFY_PATH: "1",
      ...(opts.version ? { TRAY_VERSION: opts.version } : {}),
    },
  });
  const urls = existsSync(join(root, "urls")) ? readFileSync(join(root, "urls"), "utf8") : "";
  return {
    code: res.exitCode,
    out: res.stdout.toString(),
    err: res.stderr.toString(),
    bin: join(home, ".tray/bin/tray"),
    urls,
  };
}

describe("install.sh", () => {
  test("is valid POSIX sh", () => {
    expect(Bun.spawnSync(["sh", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("defines every helper main calls", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const defined = new Set([...src.matchAll(/^([a-z0-9_]+)\(\) \{/gm)].map((m) => m[1]));
    const main = /^main\(\) \{([\s\S]*?)^\}/m.exec(src)![1]!;
    // Lowercase words with an underscore or a digit are ours (detect_target, sha256…), not system tools.
    const ours = [
      ...main.matchAll(/^\s*([a-z0-9_]+)(?=\s|$)/gm),
      ...main.matchAll(/\$\(([a-z0-9_]+)/g),
    ]
      .map((m) => m[1]!)
      .filter((w) => /[_0-9]/.test(w) || ["need", "say", "fail", "download"].includes(w));
    expect(ours).toContain("detect_target");
    for (const fn of ours) expect([fn, defined.has(fn)]).toEqual([fn, true]);
  });

  test("detect_target names a release asset for this machine", () => {
    const { code, out } = sourced("detect_target");
    expect(code).toBe(0);
    expect(out).toMatch(/^(darwin|linux)-(x64|arm64)(-musl)?$/);
  });

  test("downloads, verifies and installs the binary", () => {
    const r = install();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(r.bin)).toBe(true);
    expect(r.out).toContain("Installed tray 9.9.9");
    expect(r.urls).toContain("/releases/latest/download/SHA256SUMS");
  });

  test("a checksum mismatch fails closed and installs nothing", () => {
    const r = install({ tamper: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum mismatch");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("TRAY_VERSION works with or without the v", () => {
    expect(install({ version: "0.1.0" }).urls).toContain("/releases/download/v0.1.0/");
    expect(install({ version: "v0.1.0" }).urls).toContain("/releases/download/v0.1.0/");
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
