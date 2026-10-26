// The tray's domain, from the `DOMAIN` binding, parsed once with the shared
// schema (tldts): `ACME.dev`, `tray.acme.dev` or `https://acme.dev/` all mean
// `acme.dev`.
import { TrayDomainInput } from "@tray-sh/schema";
import type { Env } from "./env.ts";
import { TrayError } from "./errors.ts";

const parsed = new Map<string, string>();

export function trayDomain(env: Pick<Env, "DOMAIN">): string {
  const raw = env.DOMAIN ?? "";
  const hit = parsed.get(raw);
  if (hit) return hit;
  const result = TrayDomainInput.safeParse(raw);
  if (!result.success) {
    throw new TrayError(
      500,
      "internal",
      `the Worker's DOMAIN binding (${JSON.stringify(raw)}) isn't a domain`,
      {
        hint: "Re-run `tray setup --domain <your-domain>`.",
      },
    );
  }
  parsed.set(raw, result.data);
  return result.data;
}

/** `tray.<domain>`: the API and /approve host. */
export const apiHost = (env: Pick<Env, "DOMAIN">) => `tray.${trayDomain(env)}`;
