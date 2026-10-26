// `tray.<domain>/approve`: behind the owner Access app. The signed-in owner
// approves or denies a device login.
import { type Context, Hono } from "hono";
import { decideDevice, findDevice, normalizeUserCode, ownerFromAccess } from "./auth.ts";
import { TrayError } from "./errors.ts";
import { approveCodeForm, approveDetails, messagePage, PAGE_HEADERS } from "./pages.ts";
import type { Ctx } from "./router.ts";

/** A form post from this page itself: same-origin by Fetch Metadata and by Origin (when sent). */
function sameOrigin(c: Context<Ctx>): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false; // `Origin: null` (sandboxed frames, opaque origins)
  }
}

export const approvePage = new Hono<Ctx>()
  .use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PAGE_HEADERS)) c.res.headers.set(name, value);
  })
  .use(async (c, next) => {
    const owner = await ownerFromAccess(c);
    if (!owner) {
      return c.html(
        messagePage(
          "Not signed in",
          "Open this page through Cloudflare Access as the tray's owner.",
        ),
        403,
      );
    }
    c.set("identity", owner);
    await next();
  })

  .get("/", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.html(approveCodeForm(), 200);
    try {
      const { pending } = await findDevice(c.env, code);
      if (pending.status !== "pending") throw new TrayError(400, "expired_token", "already used");
      const page = approveDetails({
        userCode: pending.userCode,
        name: pending.name,
        ip: pending.ip,
        expiresAt: pending.expiresAt,
        email: c.var.identity.email,
      });
      return c.html(page, 200);
    } catch (err) {
      if (!(err instanceof TrayError)) throw err;
      return c.html(
        messagePage(
          "Code not found",
          `${normalizeUserCode(code)} has expired or was already used. Run \`tray login\` again.`,
        ),
        400,
      );
    }
  })

  .post("/", async (c) => {
    if (!sameOrigin(c)) {
      return c.html(messagePage("Forbidden", "Cross-site request refused."), 403);
    }
    const form = await c.req.parseBody();
    const code = String(form.code ?? "");
    const approve = form.action !== "deny";
    try {
      await decideDevice(c.env, code, approve, c.var.identity.email);
    } catch (err) {
      if (!(err instanceof TrayError)) throw err;
      return c.html(
        messagePage(
          "Code not found",
          "This code has expired or was already used. Run `tray login` again.",
        ),
        400,
      );
    }
    return approve
      ? c.html(messagePage("Approved", "You can close this tab and go back to your terminal."), 200)
      : c.html(messagePage("Denied", "The login was denied."), 200);
  });
