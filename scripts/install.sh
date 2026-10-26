#!/bin/sh
# Installs the tray CLI.  curl -fsSL tray.sh/install | sh
#
#   TRAY_VERSION=v0.1.0   install a specific version (default: latest)
#   TRAY_INSTALL=~/.tray  install directory (binary goes in $TRAY_INSTALL/bin)
#
# Downloads a release from GitHub, verifies its SHA-256 checksum, and fails
# closed if anything doesn't match.
set -eu

REPO="siddharthborderwala/tray"

main() {
  need uname
  need tar
  need mktemp

  target="$(detect_target)"
  version="${TRAY_VERSION:-latest}"
  if [ "$version" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$version"
  fi

  install_dir="${TRAY_INSTALL:-$HOME/.tray}"
  bin_dir="$install_dir/bin"
  archive="tray-$target.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading tray ($target)"
  download "$base/$archive" "$tmp/$archive"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

  expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)"
  [ -n "$expected" ] || fail "no checksum for $archive in SHA256SUMS"
  actual="$(sha256 "$tmp/$archive")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

  tar -xzf "$tmp/$archive" -C "$tmp"
  mkdir -p "$bin_dir"
  mv "$tmp/tray" "$bin_dir/tray"
  chmod +x "$bin_dir/tray"

  say "Installed $("$bin_dir/tray" --version) to $bin_dir/tray"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      say "Add tray to your PATH:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  say ""
  say "Next: tray setup --domain <your-domain>"
}

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) fail "unsupported OS: $os (on Windows, download a release from https://github.com/$REPO/releases)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
  # An x64 shell under Rosetta on Apple silicon: use the native build.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
  if [ "$os" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -q musl; }; then
    arch="$arch-musl"
  fi
  echo "$os-$arch"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || fail "download failed: $1"
  else
    fail "need curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "need sha256sum or shasum to verify the download"
  fi
}

need() { command -v "$1" >/dev/null 2>&1 || fail "need $1"; }
say() { printf '%s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

main "$@"
