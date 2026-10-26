// Cloudflare Access JWT verification.
//
// Access signs its JWTs (RS256) with keys published at
// https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. We check the
// signature, `exp`/`nbf`, `iss` (the team domain) and `aud` (the app's AUD tag).
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { verifyWithJwks } from "hono/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import type { Fetch } from "./env.ts";

const CERTS_TTL_MS = 60 * 60 * 1000;

export type AccessVerifier = (
  token: string | undefined,
  opts: { teamDomain?: string; aud?: string },
) => Promise<{ email: string } | null>;

/** `acme`, `acme.cloudflareaccess.com` or `https://acme.cloudflareaccess.com/` → `https://acme.cloudflareaccess.com`. */
export function teamIssuer(teamDomain: string): string {
  let host = teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host.includes(".")) host += ".cloudflareaccess.com";
  return `https://${host}`;
}

export function createAccessVerifier(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): AccessVerifier {
  const cache = new Map<string, { keys: HonoJsonWebKey[]; at: number }>();

  async function certs(issuer: string, kid: string | undefined): Promise<HonoJsonWebKey[]> {
    const hit = cache.get(issuer);
    if (hit && Date.now() - hit.at < CERTS_TTL_MS && hit.keys.some((k) => k.kid === kid))
      return hit.keys;
    const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys: HonoJsonWebKey[] };
    cache.set(issuer, { keys, at: Date.now() });
    return keys;
  }

  return async (token, { teamDomain, aud }) => {
    if (!token || !teamDomain || !aud) return null;
    try {
      const issuer = teamIssuer(teamDomain);
      const header = JSON.parse(
        atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ) as { kid?: string };
      const keys = await certs(issuer, header.kid);
      const payload = await verifyWithJwks(token, {
        keys,
        allowedAlgorithms: ["RS256"],
        verification: { iss: issuer, aud },
      });
      return typeof payload.email === "string" && payload.email
        ? { email: payload.email.toLowerCase() }
        : null;
    } catch {
      return null;
    }
  };
}

/** The Access JWT on a request: the `cf-access-jwt-assertion` header Access adds, else the `CF_Authorization` cookie. */
export function accessToken(c: Context): string | undefined {
  return c.req.header("cf-access-jwt-assertion") || getCookie(c, "CF_Authorization") || undefined;
}
