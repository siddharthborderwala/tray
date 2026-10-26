// Domains, hostnames and email domains, parsed with WHATWG `URL` (input
// handling, IDN → punycode) and tldts (the Public Suffix List). Shared by the
// CLI and the Worker so both sides agree on what a domain is.
import { parse } from "tldts";
import * as z from "zod";

/**
 * The lowercase ASCII hostname in user input: a bare host (`Acme.dev`),
 * with a trailing slash or dot, or a URL (`https://tray.acme.dev/approve`).
 * Null for anything with a port, credentials, or no usable host.
 */
export function hostFromInput(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.port || url.username || url.password) return null;
  return url.hostname || null;
}

/**
 * A public DNS hostname under a registrable domain (`acme.dev`,
 * `docs.acme.co.uk`), already lowercase: no IPs, no bare public suffixes
 * (`co.uk`), no private or unknown TLDs (`acme.local`). Null otherwise.
 */
export function publicHostname(host: string): { hostname: string; domain: string } | null {
  const p = parse(host);
  if (!p.hostname || p.isIp || !p.isIcann || !p.domain) return null;
  return { hostname: p.hostname, domain: p.domain };
}

/** `Docs.Acme.com/`, `https://docs.acme.com` → `docs.acme.com`. Null if it isn't a public hostname. */
export function normalizeHostname(input: string): string | null {
  const host = hostFromInput(input);
  return host ? (publicHostname(host)?.hostname ?? null) : null;
}

/** True for a hostname that is already in canonical form (case aside). */
export function isHostname(input: string): boolean {
  return normalizeHostname(input) === input.toLowerCase();
}

/**
 * A tray's domain from user input. Sites live at `<site>.<domain>` and the API
 * at `tray.<domain>`, so the API host is accepted too: a leading `tray.` is
 * stripped when a registrable domain remains.
 *
 *   acme.dev, ACME.dev/, https://tray.acme.dev/   → acme.dev
 *   tray.sh                                       → tray.sh   (sh alone isn't a domain)
 *   tray.tray.sh                                  → tray.sh
 *   acme.co.uk, tray.acme.co.uk                   → acme.co.uk
 */
export function normalizeTrayDomain(input: string): string | null {
  const host = normalizeHostname(input);
  if (!host) return null;
  if (host.startsWith("tray.")) {
    const rest = publicHostname(host.slice("tray.".length));
    if (rest) return rest.hostname;
  }
  return host;
}

/** The registrable domain (the zone apex, usually): `docs.acme.co.uk` → `acme.co.uk`. */
export function registrableDomain(host: string): string | null {
  return publicHostname(host)?.domain ?? null;
}

const transformTo =
  (fn: (s: string) => string | null, message: string) => (s: string, ctx: z.RefinementCtx) => {
    const out = fn(s);
    if (out === null) {
      ctx.addIssue({ code: "custom", message, input: s });
      return z.NEVER;
    }
    return out;
  };

const HOSTNAME_MESSAGE = "expected a hostname like docs.acme.com";
const DOMAIN_MESSAGE = "expected a domain like acme.dev";

/** A DNS hostname such as `docs.acme.com` (case-insensitive). For API params and bodies. */
export const Hostname = z.string().max(253).refine(isHostname, HOSTNAME_MESSAGE);

/** User input for a hostname: also takes URLs, uppercase, trailing slashes. Outputs `docs.acme.com`. */
export const HostnameInput = z.string().transform(transformTo(normalizeHostname, HOSTNAME_MESSAGE));

/** A tray domain in canonical form (`acme.dev`). */
export const TrayDomain = z.string().refine((s) => normalizeTrayDomain(s) === s, DOMAIN_MESSAGE);

/** User input for a tray domain (flags, `TRAY_DOMAIN`, the Worker's `DOMAIN`). Outputs `acme.dev`. */
export const TrayDomainInput = z
  .string()
  .transform(transformTo(normalizeTrayDomain, DOMAIN_MESSAGE));

/** `@acme.com`: anyone with an email at that domain. */
export const EmailDomainEntry = z
  .string()
  .refine((s) => s.startsWith("@") && isHostname(s.slice(1)), "expected an email or @domain");

/** An email (`bob@acme.com`) or an email domain (`@acme.com`). Case-insensitive. */
export const ShareEntry = z.union([z.email(), EmailDomainEntry]);
