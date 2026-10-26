// `tray.<domain>/approve`: behind the owner Access app. The signed-in owner
// approves or denies a device login.
import { Hono } from "hono";
import { decideDevice, findDevice, normalizeUserCode, ownerFromAccess } from "./auth.ts";
import { TrayError } from "./errors.ts";
import { approveCodeForm, approveDetails, messagePage } from "./pages.ts";
import type { Ctx } from "./router.ts";

const NO_STORE = { "cache-control": "no-store" };

export const approvePage = new Hono<Ctx>()
  .use(async (c, next) => {
    const owner = await ownerFromAccess(c);
    if (!owner) {
      return c.html(
        messagePage(
          "Not signed in",
          "Open this page through Cloudflare Access as the tray's owner.",
        ),
        403,
        NO_STORE,
      );
    }
    c.set("identity", owner);
    await next();
  })

  .get("/", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.html(approveCodeForm(), 200, NO_STORE);
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
      return c.html(page, 200, NO_STORE);
    } catch (err) {
      if (!(err instanceof TrayError)) throw err;
      return c.html(
        messagePage(
          "Code not found",
          `${normalizeUserCode(code)} has expired or was already used. Run \`tray login\` again.`,
        ),
        400,
        NO_STORE,
      );
    }
  })

  .post("/", async (c) => {
    // Same-origin form posts only.
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) {
      return c.html(messagePage("Forbidden", "Cross-site request refused."), 403, NO_STORE);
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
        NO_STORE,
      );
    }
    return approve
      ? c.html(
          messagePage("Approved", "You can close this tab and go back to your terminal."),
          200,
          NO_STORE,
        )
      : c.html(messagePage("Denied", "The login was denied."), 200, NO_STORE);
  });
