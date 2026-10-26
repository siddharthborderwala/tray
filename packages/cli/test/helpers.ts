import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmp = (prefix = "tray-test-") => mkdtempSync(join(tmpdir(), prefix));
export const bytes = (s: string) => new TextEncoder().encode(s);

export interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: any;
}

type Handler = (req: Recorded) => Response | Promise<Response> | unknown;

/** A fetch stand-in routing `METHOD /path` to handlers; records every call. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    let body: any = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {}
    }
    const rec: Recorded = { method, path: url.pathname + url.search, headers: new Headers(init?.headers), body };
    calls.push(rec);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      if (m !== method) return false;
      const re = new RegExp("^" + p!.replace(/:[a-z]+/gi, "[^/]+") + "$");
      return re.test(url.pathname);
    });
    if (!key) return Response.json({ error: `no mock for ${method} ${url.pathname}`, code: "NOT_FOUND" }, { status: 404 });
    const out = await routes[key]!(rec);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const memoryKeyStore = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    async get(d: string) {
      return data[d] ?? null;
    },
    async set(d: string, k: string) {
      data[d] = k;
    },
    async delete(d: string) {
      delete data[d];
    },
  };
};
