#!/usr/bin/env node
// Launcher for `npm i -g @traysh/cli`: runs the prebuilt binary from the
// matching platform package (@traysh/cli-<os>-<arch>).
const { spawnSync } = require("node:child_process");

const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
const musl =
  process.platform === "linux" && !process.report?.getReport().header.glibcVersionRuntime;
const target = `${os}-${arch}${musl ? "-musl" : ""}`;
const exe = process.platform === "win32" ? "tray.exe" : "tray";

let bin;
try {
  bin = require.resolve(`@traysh/cli-${target}/bin/${exe}`);
} catch {
  console.error(`tray: no prebuilt binary for ${target}. Try: curl -fsSL tray.sh/install | sh`);
  process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
