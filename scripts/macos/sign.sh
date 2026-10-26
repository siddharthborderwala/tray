#!/bin/sh
# Signs a darwin tray binary with our Developer ID and verifies it.
#
#   scripts/macos/sign.sh <binary>
#
# Needs TRAY_MACOS_SIGN_IDENTITY (the certificate's SHA-1 or name) and
# APPLE_TEAM_ID; TRAY_MACOS_KEYCHAIN optionally names the keychain holding it.
# Called by scripts/build-binaries.ts before packaging. entitlements.plist is
# exactly what Bun documents for signed `bun build --compile` executables
# (https://bun.com/docs/bundler/executables, "Code signing on macOS"); the
# JavaScriptCore JIT needs it under the hardened runtime. (No comments in the
# plist: AMFI rejects them.)
set -eu

bin="$1"
here="$(cd "$(dirname "$0")" && pwd)"
identifier="sh.tray.cli"
: "${TRAY_MACOS_SIGN_IDENTITY:?set TRAY_MACOS_SIGN_IDENTITY}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"

set -- --force --sign "$TRAY_MACOS_SIGN_IDENTITY" --options runtime --timestamp \
  --entitlements "$here/entitlements.plist" --identifier "$identifier"
if [ -n "${TRAY_MACOS_KEYCHAIN:-}" ]; then set -- "$@" --keychain "$TRAY_MACOS_KEYCHAIN"; fi
codesign "$@" "$bin"

codesign --verify --strict --verbose=2 "$bin"
info="$(codesign -dvv "$bin" 2>&1)"
printf '%s\n' "$info"
printf '%s\n' "$info" | grep -qx "Identifier=$identifier" || { echo "error: wrong identifier" >&2; exit 1; }
printf '%s\n' "$info" | grep -qx "TeamIdentifier=$APPLE_TEAM_ID" || { echo "error: wrong team" >&2; exit 1; }
printf '%s\n' "$info" | grep -q "^Authority=Developer ID Application" || { echo "error: not a Developer ID signature" >&2; exit 1; }
printf '%s\n' "$info" | grep -q "flags=.*runtime" || { echo "error: hardened runtime missing" >&2; exit 1; }

# Run it, if this Mac can (x64 needs Rosetta on Apple silicon).
case "$(file "$bin")" in
  *x86_64*) [ "$(uname -m)" = "x86_64" ] || arch -x86_64 /usr/bin/true 2>/dev/null || { echo "skip run: no Rosetta"; exit 0; } ;;
  *arm64*) [ "$(uname -m)" = "arm64" ] || { echo "skip run: arm64 binary on x86_64"; exit 0; } ;;
esac
"$bin" --version
