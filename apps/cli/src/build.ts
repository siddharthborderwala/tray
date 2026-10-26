// Build-time constants, set with `bun build --define` in release builds.
//
// TRAY_MACOS_SIGNED is defined as `true` only by the release job that signs
// the darwin binaries with our Developer ID (identifier sh.tray.cli). Local and
// unsigned builds leave it undefined.
declare const TRAY_MACOS_SIGNED: boolean | undefined;

export const MACOS_SIGNED: boolean =
  typeof TRAY_MACOS_SIGNED !== "undefined" && TRAY_MACOS_SIGNED === true;
