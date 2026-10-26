// Name-conflict and visibility rules for `tray put` (SPEC.md §4).
//
// The Worker is authoritative: it compares the deploy's `source` with the one
// stored for the site and answers `409 site_exists` when they differ and
// `replace` isn't set. The CLI decides what to send and what to do on 409.
import type { Visibility } from "./wire.ts";

export interface DeployFlagsInput {
  /** Site exists already (GET /sites/{site} answered 200). */
  exists: boolean;
  /** --replace given, or the user confirmed the replace prompt. */
  replace: boolean;
  /** --private given. */
  private: boolean;
}

/**
 * `--private` only applies to new sites or with --replace; plain redeploys
 * leave visibility unchanged (so it isn't sent at all).
 */
export function deployFlags(input: DeployFlagsInput): { replace: boolean; visibility?: Visibility } {
  const applyVisibility = !input.exists || input.replace;
  return {
    replace: input.replace,
    ...(applyVisibility && input.private ? { visibility: "private" as const } : {}),
  };
}

/** What to do with `409 site_exists`: ask (interactive) or fail with `site_exists` (exit 1). */
export function onSiteExists(input: { interactive: boolean; replacing: boolean }): "prompt" | "fail" {
  return input.interactive && !input.replacing ? "prompt" : "fail";
}

/** `source.machine`: readable and unique, e.g. `mbp-3f9a`. */
export function machineLabel(hostname: string, machineId: string): string {
  return `${hostname}-${machineId.replace(/-/g, "").slice(0, 4)}`;
}
