// Builds release artifacts for the tray CLI.
//
//   bun scripts/build-binaries.ts [target ...]   (default: all targets)
//
// For each target it writes:
//   dist/release/tray-<target>.tar.gz   (.zip on Windows)  GitHub release asset
//   dist/npm/cli-<target>/              npm package @traysh/cli-<target>
// and once:
//   dist/npm/cli/                       npm package @traysh/cli (launcher)
//
// Run `bun run --filter @traysh/worker build` first: the CLI embeds the Worker.
import { $ } from "bun";
import { cp, mkdir, rm } from "node:fs/promises";

const ALL = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "windows-x64",
];

const root = new URL("..", import.meta.url).pathname;
const cli = await Bun.file(`${root}apps/cli/package.json`).json();
const version: string = cli.version;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const t of targets) if (!ALL.includes(t)) throw new Error(`unknown target: ${t}`);

const dist = `${root}dist`;
await mkdir(`${dist}/release`, { recursive: true });

for (const target of targets) {
  const [os, arch, libc] = target.split("-");
  const exe = os === "windows" ? "tray.exe" : "tray";
  const binDir = `${dist}/bin/${target}`;
  await rm(binDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });

  await $`bun build --compile --minify --sourcemap --target=bun-${target} --no-compile-autoload-dotenv --no-compile-autoload-bunfig ${root}apps/cli/src/index.ts --outfile ${binDir}/${exe}`.quiet();

  // GitHub release asset
  const asset = `${dist}/release/tray-${target}`;
  if (os === "windows") await $`cd ${binDir} && zip -q ${asset}.zip ${exe}`;
  else await $`tar -czf ${asset}.tar.gz -C ${binDir} ${exe}`;

  // npm platform package
  const pkgDir = `${dist}/npm/cli-${target}`;
  await rm(pkgDir, { recursive: true, force: true });
  await mkdir(`${pkgDir}/bin`, { recursive: true });
  await cp(`${binDir}/${exe}`, `${pkgDir}/bin/${exe}`);
  await Bun.write(
    `${pkgDir}/package.json`,
    JSON.stringify(
      {
        name: `@traysh/cli-${target}`,
        version,
        description: `The tray CLI binary for ${target}`,
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/siddharthborderwala/tray.git" },
        os: [os === "windows" ? "win32" : os],
        cpu: [arch],
        ...(libc ? { libc: [libc] } : os === "linux" ? { libc: ["glibc"] } : {}),
        files: ["bin"],
      },
      null,
      2,
    ),
  );
  console.log(`built ${target}`);
}

// npm launcher package: @traysh/cli
const launcher = `${dist}/npm/cli`;
await rm(launcher, { recursive: true, force: true });
await mkdir(`${launcher}/bin`, { recursive: true });
await cp(`${root}apps/cli/npm/tray.cjs`, `${launcher}/bin/tray.cjs`);
await cp(`${root}README.md`, `${launcher}/README.md`);
await cp(`${root}LICENSE`, `${launcher}/LICENSE`);
await Bun.write(
  `${launcher}/package.json`,
  JSON.stringify(
    {
      name: "@traysh/cli",
      version,
      description:
        "Artifacts for every agent. Turn a folder or an HTML file into a link you can share.",
      license: "MIT",
      homepage: "https://tray.sh",
      repository: { type: "git", url: "git+https://github.com/siddharthborderwala/tray.git" },
      bin: { tray: "bin/tray.cjs" },
      files: ["bin"],
      optionalDependencies: Object.fromEntries(ALL.map((t) => [`@traysh/cli-${t}`, version])),
    },
    null,
    2,
  ),
);
console.log(`npm packages in dist/npm (version ${version})`);
