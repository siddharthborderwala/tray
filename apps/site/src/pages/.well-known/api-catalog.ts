import type { APIRoute } from "astro";
import { SITE_URL } from "../../lib/site";

export const prerender = true;

/** RFC 9727 API catalog: where the API is described and documented. */
export const GET: APIRoute = () => {
  const body = {
    linkset: [
      {
        anchor: `${SITE_URL}/`,
        "service-desc": [
          { href: `${SITE_URL}/openapi.json`, type: "application/vnd.oai.openapi+json" },
        ],
        "service-doc": [{ href: `${SITE_URL}/api`, type: "text/html" }],
      },
    ],
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    },
  });
};
