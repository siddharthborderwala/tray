// Access turns away anyone not on the sign-in policy before they use a Zero
// Trust seat, so the policy lists exactly the people who can view something:
// the owner and everyone a private site is shared with. Synced after every
// change to who that is. It's recomputed from R2 each time, so a retry (or the
// next change) repairs a sync that failed.
import type { Context } from "hono";
import type { Ctx } from "./router.ts";
import { signinAllowList } from "./storage.ts";

export async function syncSigninPolicy(c: Context<Ctx>): Promise<void> {
  await c.var.deps.cloudflare(c.env).setSigninAllowList(await signinAllowList(c.env));
}
