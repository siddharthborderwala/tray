#!/bin/sh
# Installs the tray CLI.  curl -fsSL tray.sh/install | sh
#
#   TRAY_VERSION=v0.1.0   install a specific version (default: latest; the v is optional)
#   TRAY_INSTALL=~/.tray  install directory (binary goes in $TRAY_INSTALL/bin)
#   TRAY_NO_MODIFY_PATH=1 don't touch shell rc files (PATH)
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
  case "$version" in
    latest | v*) ;;
    *) version="v$version" ;; # TRAY_VERSION=0.1.0 works too
  esac
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

  setup_path "$bin_dir"
  say ""
  say "Next: tray setup --domain <your-domain>   (or: tray login <domain>)"
}

setup_path() {
  # CI: make tray available to later GitHub Actions steps.
  if [ -n "${GITHUB_PATH:-}" ]; then
    printf '%s\n' "$1" >>"$GITHUB_PATH"
  fi
  if [ "${TRAY_NO_MODIFY_PATH:-}" = "1" ]; then
    on_path "$1" || say "Add tray to your PATH:  export PATH=\"$1:\$PATH\""
  else
    add_to_path "$1"
  fi
}

on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Append `export PATH=...` to the user's shell rc file(s), once.
add_to_path() {
  dir="$1"
  # Write $HOME rather than the expanded path when we can; it reads better.
  case "$dir" in
    "$HOME"/*) rc_dir="\$HOME${dir#"$HOME"}" ;;
    *) rc_dir="$dir" ;;
  esac
  line="export PATH=\"$rc_dir:\$PATH\""
  changed=""
  case "$(basename "${SHELL:-sh}")" in
    zsh)
      append_once "${ZDOTDIR:-$HOME}/.zshrc" "$line" && changed="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      append_once "$HOME/.bashrc" "$line" && changed="$HOME/.bashrc"
      # macOS Terminal starts login shells, which read .bash_profile, not .bashrc.
      if [ "$(uname -s)" = "Darwin" ]; then
        append_once "$HOME/.bash_profile" "$line" && changed="${changed:+$changed and }$HOME/.bash_profile"
      fi
      ;;
    fish)
      if command -v fish >/dev/null 2>&1; then
        fish -c "if contains -- '$dir' \$fish_user_paths; exit 1; end; fish_add_path '$dir'" && changed="fish_user_paths"
      fi
      ;;
    *)
      append_once "$HOME/.profile" "$line" && changed="$HOME/.profile"
      ;;
  esac
  if [ -n "$changed" ]; then
    say ""
    say "Added $dir to PATH in $changed."
    say "Restart your shell (or open a new terminal) to use tray."
  elif ! on_path "$dir"; then
    say ""
    say "Add tray to your PATH:  export PATH=\"$dir:\$PATH\""
  fi
}

# append_once FILE LINE: add LINE to FILE unless it already puts our bin dir
# on PATH (as the expanded path or the $HOME form). Returns 0 only when FILE
# was changed.
append_once() {
  if [ -f "$1" ] && { grep -Fq "$dir" "$1" || grep -Fq "$rc_dir" "$1"; }; then
    return 1
  fi
  printf '\n# tray\n%s\n' "$2" >>"$1"
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
