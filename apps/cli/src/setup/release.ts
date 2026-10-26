// Release downloads for `tray upgrade`, matching scripts/install.sh: the same
// asset names, SHA256SUMS verification, failing closed on any mismatch.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { posix } from "node:path";
import { EXIT, TrayError } from "../errors.ts";
import type { Fetch } from "./cloudflare.ts";

export const REPO = "siddharthborderwala/tray";

/** `darwin-arm64`, `linux-x64-musl`, `windows-x64`, … (same rules as install.sh). */
export function detectTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  probe: { rosetta?: () => boolean; musl?: () => boolean } = {},
): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!["darwin", "linux", "windows"].includes(os)) {
    throw new TrayError(`unsupported OS: ${platform}`, "unsupported_platform", EXIT.failed);
  }
  let cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!cpu)
    throw new TrayError(`unsupported architecture: ${arch}`, "unsupported_platform", EXIT.failed);
  const rosetta =
    probe.rosetta ??
    (() => spawnSync("sysctl", ["-n", "sysctl.proc_translated"]).stdout?.toString().trim() === "1");
  if (os === "darwin" && cpu === "x64" && rosetta()) cpu = "arm64";
  const musl =
    probe.musl ??
    (() =>
      existsSync("/etc/alpine-release") ||
      /musl/.test(spawnSync("ldd", ["--version"]).stderr?.toString() ?? ""));
  if (os === "linux" && musl()) cpu += "-musl";
  return `${os}-${cpu}`;
}

export const assetName = (target: string) =>
  `tray-${target}${target.startsWith("windows") ? ".zip" : ".tar.gz"}`;

/** The latest release's version, e.g. `0.2.0`. */
export async function latestVersion(fetchImpl: Fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  }).catch((err: Error) => {
    throw new TrayError(`could not reach GitHub: ${err.message}`, "network", EXIT.failed);
  });
  if (!res.ok)
    throw new TrayError(
      `could not look up the latest release (HTTP ${res.status})`,
      "release_lookup_failed",
      EXIT.failed,
    );
  const { tag_name } = (await res.json()) as { tag_name?: string };
  if (!tag_name)
    throw new TrayError("the latest release has no tag", "release_lookup_failed", EXIT.failed);
  return tag_name.replace(/^v/, "");
}

async function download(fetchImpl: Fetch, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url).catch((err: Error) => {
    throw new TrayError(`download failed: ${url}: ${err.message}`, "network", EXIT.failed);
  });
  if (!res.ok)
    throw new TrayError(
      `download failed: ${url} (HTTP ${res.status})`,
      "download_failed",
      EXIT.failed,
    );
  return new Uint8Array(await res.arrayBuffer());
}

export function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Download the release archive for `target`, verify it against SHA256SUMS, and return the binary inside. */
export async function fetchBinary(
  fetchImpl: Fetch,
  version: string,
  target: string,
): Promise<Uint8Array> {
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const asset = assetName(target);
  const [archive, sums] = await Promise.all([
    download(fetchImpl, `${base}/${asset}`),
    download(fetchImpl, `${base}/SHA256SUMS`),
  ]);

  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === asset)?.[0];
  if (!expected)
    throw new TrayError(`no checksum for ${asset} in SHA256SUMS`, "checksum_missing", EXIT.failed);
  if (sha256Hex(archive) !== expected.toLowerCase()) {
    throw new TrayError(
      `checksum mismatch for ${asset}`,
      "checksum_mismatch",
      EXIT.failed,
      "The download was corrupted or tampered with. Nothing was changed.",
    );
  }

  const exe = target.startsWith("windows") ? "tray.exe" : "tray";
  const binary = asset.endsWith(".zip")
    ? unzipSync(archive)[exe]
    : await fileFromTarGz(archive, exe);
  if (!binary) throw new TrayError(`${asset} doesn't contain ${exe}`, "bad_archive", EXIT.failed);
  return binary;
}

/** The contents of `name` in a .tar.gz (Bun.Archive), or undefined if it isn't there. */
export async function fileFromTarGz(
  archive: Uint8Array,
  name: string,
): Promise<Uint8Array | undefined> {
  let files: Map<string, File>;
  try {
    files = await new Bun.Archive(archive).files();
  } catch {
    return undefined;
  }
  for (const [path, file] of files) {
    if (posix.normalize(path) === name) return new Uint8Array(await file.arrayBuffer());
  }
  return undefined;
}

/** Is this process a standalone tray binary we can replace (not `bun run`, not an npm install)? */
export function replaceableBinary(execPath: string): boolean {
  const base = execPath.split(/[\\/]/).pop() ?? "";
  return (base === "tray" || base === "tray.exe") && !/[\\/]node_modules[\\/]/.test(execPath);
}
