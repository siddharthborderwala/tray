// Cloudflare Access JWT verification, with jose.
//
// Access signs its JWTs (RS256) with keys published at
// https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. We check the
// signature, `exp`/`nbf`, `iss` (the team domain) and `aud` (the app's AUD tag).
// jose's remote JWKS caches the keys, refetches on an unknown `kid` (rotation),
// and rate-limits those refetches.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { Fetch } from "./env.ts";

const CERTS_TTL_MS = 60 * 60 * 1000;
/** A token with an unknown `kid` refetches the certs (rotation), but at most this often. */
const CERTS_REFRESH_MS = 60 * 1000;

export type AccessVerifier = (
  token: string | undefined,
  opts: { teamDomain?: string; aud?: string },
) => Promise<{ email: string } | null>;

/** `acme`, `acme.cloudflareaccess.com` or `https://acme.cloudflareaccess.com/` → `https://acme.cloudflareaccess.com`. */
export function teamIssuer(teamDomain: string): string {
  const s = teamDomain.trim();
  const { hostname } = new URL(s.includes("://") ? s : `https://${s}`);
  return `https://${hostname.includes(".") ? hostname : `${hostname}.cloudflareaccess.com`}`;
}

export function createAccessVerifier(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): AccessVerifier {
  const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  const keysFor = (issuer: string) => {
    let set = jwks.get(issuer);
    if (!set) {
      set = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        cacheMaxAge: CERTS_TTL_MS,
        cooldownDuration: CERTS_REFRESH_MS,
        [customFetch]: (url, init) => fetchImpl(url, init),
      });
      jwks.set(issuer, set);
    }
    return set;
  };

  return async (token, { teamDomain, aud }) => {
    if (!token || !teamDomain || !aud) return null;
    try {
      const issuer = teamIssuer(teamDomain);
      const { payload } = await jwtVerify(token, keysFor(issuer), {
        algorithms: ["RS256"],
        issuer,
        audience: aud,
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
