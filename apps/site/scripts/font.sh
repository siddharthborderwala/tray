#!/bin/sh
# Converts your licensed Berkeley Mono Variable to woff2 for the site.
#   bun run font [path/to/Berkeley Mono Variable.otf]
# Needs woff2_compress (brew install woff2). The output is gitignored.
set -eu

src="${1:-$HOME/Library/Fonts/Berkeley Mono Variable.otf}"
out="public/fonts/BerkeleyMonoVariable.woff2"

if [ ! -f "$src" ]; then
  echo "error: font not found at $src" >&2
  echo "Pass the path: bun run font /path/to/BerkeleyMonoVariable.otf" >&2
  exit 1
fi
command -v woff2_compress >/dev/null || { echo "error: woff2_compress not found (brew install woff2)" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$src" "$tmp/font.otf"
woff2_compress "$tmp/font.otf" >/dev/null
mkdir -p public/fonts
mv "$tmp/font.woff2" "$out"
echo "wrote $out"
