import type { Ctx } from "../ctx.ts";
import { EXIT, TrayError } from "../errors.ts";

/**
 * `tray setup [--domain <d>] [--email <e>]` — one-time provisioning of a tray
 * on the user's Cloudflare account.
 *
 * TODO: blocked on apps/worker (its bundle gets embedded in this binary).
 * Planned steps, all plain `fetch` against https://api.cloudflare.com/client/v4
 * (no SDK, no Wrangler), each idempotent so re-running fixes missing pieces:
 *
 *  0. Inputs: --domain (or prompt), CLOUDFLARE_API_TOKEN (or password prompt;
 *     needs Workers, R2, DNS, Access), --email (or prompt). Non-interactive:
 *     missing values exit 2 naming the flag.
 *  1. Zone + account: GET /zones?name=<domain> → zone id, account id. Exit 1 if
 *     the domain isn't on Cloudflare.
 *  2. Zero Trust: GET /accounts/<id>/access/organizations. If missing, print the
 *     one-time enable link (dash.cloudflare.com/<id>/one) and exit 1.
 *  3. R2 bucket: GET then POST /accounts/<id>/r2/buckets { name: "tray-<domain-dashed>" }.
 *  4. Worker: PUT /accounts/<id>/workers/scripts/tray (multipart: embedded bundle
 *     + metadata with the R2 binding, DOMAIN var, owner email, compatibility date).
 *     Store the CF token as a Worker secret so it can attach custom domains
 *     (POST /v1/domains) and manage the sign-in Access app.
 *  5. Routes + DNS: Worker route `*.<domain>/*` (POST /zones/<zone>/workers/routes)
 *     with a proxied wildcard DNS record, and Worker Custom Domain tray.<domain>
 *     (PUT /accounts/<id>/workers/domains).
 *  6. Access: an application for tray.<domain>/approve with an include policy for
 *     --email, and the sign-in app for *.<domain>/.tray/signin (email code)
 *     (POST /accounts/<id>/access/apps).
 *  7. Key for this machine: write keys/<id>.json (id = sha256(key)[0:12]) via the R2 API
 *     (works even if all keys were lost — the recovery path), then save it like
 *     `tray login` does and make the domain current.
 *  8. Save the CF token (keychain) for later setup re-runs.
 */
export async function setup(_ctx: Ctx, _email: string | undefined): Promise<void> {
  throw new TrayError(
    "tray setup is not available yet",
    "not_implemented",
    EXIT.failed,
    "It needs the Worker bundle, which isn't built yet. To use an existing tray: tray login <domain>.",
  );
}

/**
 * `tray upgrade` — TODO: download the latest release binary for this platform
 * from tray.sh, verify its checksum, atomically replace process.execPath, then
 * compare the Worker version (the `tray-version` response header) and offer to
 * redeploy it (same path as `tray setup` step 4).
 */
export async function upgrade(_ctx: Ctx): Promise<void> {
  throw new TrayError(
    "tray upgrade is not available yet",
    "not_implemented",
    EXIT.failed,
    "Reinstall with: curl -fsSL tray.sh/install | sh",
  );
}
