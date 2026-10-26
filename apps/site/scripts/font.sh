#!/bin/sh
# Subsets your licensed Berkeley Mono Variable to woff2 for the site.
#   bun run font [path/to/Berkeley Mono Variable.otf]
# Needs fonttools with brotli (brew install fonttools). The output is gitignored.
set -eu

src="${1:-$HOME/Library/Fonts/Berkeley Mono Variable.otf}"
out="public/fonts/BerkeleyMonoVariable.woff2"

if [ ! -f "$src" ]; then
  echo "error: font not found at $src" >&2
  echo "Pass the path: bun run font /path/to/BerkeleyMonoVariable.otf" >&2
  exit 1
fi
command -v pyftsubset >/dev/null || { echo "error: pyftsubset not found (brew install fonttools)" >&2; exit 1; }

# Latin, Latin-1, and the punctuation, arrows and symbols the site uses.
mkdir -p public/fonts
pyftsubset "$src" \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+203A,U+2190-2193,U+2197,U+2665" \
  --layout-features="*" \
  --flavor=woff2 \
  --output-file="$out"
echo "wrote $out ($(wc -c < "$out" | tr -d ' ') bytes)"
