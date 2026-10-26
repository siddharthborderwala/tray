// The "Zero Trust" step of `tray setup`. Access (login page, private sites)
// needs a Zero Trust organization. When there isn't one: interactive mode
// opens the dashboard, explains what to pick, and waits; non-interactive mode
// exits 1 with the same instructions.
import * as p from "@clack/prompts";
import { openBrowser, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import { zeroTrustTeam, type CloudflareClient } from "./cloudflare.ts";

export const ZERO_TRUST_URL = "https://one.dash.cloudflare.com/";

/**
 * From https://developers.cloudflare.com/cloudflare-one/setup/ ("Create a Zero
 * Trust organization"): choose a team name, then a plan; payment details are
 * required even on the Free plan, which isn't charged.
 */
export const ZERO_TRUST_STEPS =
  `Open ${ZERO_TRUST_URL}, choose a team name, and pick the Free plan. ` +
  "Cloudflare asks for payment details even on the Free plan, but doesn't charge it.";

export interface ZeroTrustDeps {
  open?: (url: string) => void;
  /** Resolves when the user presses Enter; rejects (cancelled) on Esc / Ctrl-C. */
  waitForEnter?: (message: string) => Promise<void>;
}

export async function pressEnter(message: string): Promise<void> {
  const answer = await p.text({ message, placeholder: "Enter", output: process.stderr });
  if (p.isCancel(answer)) throw cancelled();
}

function row(ctx: Ctx, ok: boolean, value: string) {
  const line = `${"Zero Trust".padEnd(21)}${value}`;
  if (!ctx.mode.interactive) ctx.stderr(`Zero Trust: ${value}`);
  else if (ok) p.log.step(line, { output: process.stderr });
  else p.log.error(line, { output: process.stderr });
}

/** The team domain (e.g. `acme.cloudflareaccess.com`), once Zero Trust is on. */
export async function requireZeroTrust(
  ctx: Ctx,
  cf: CloudflareClient,
  accountId: string,
  deps: ZeroTrustDeps = {},
): Promise<string> {
  let team = await zeroTrustTeam(cf, accountId);
  if (team) {
    row(ctx, true, team);
    return team;
  }
  row(ctx, false, "not enabled");
  if (!ctx.mode.interactive) {
    throw new TrayError(
      "Cloudflare Zero Trust isn't enabled on this account",
      "zero_trust_disabled",
      EXIT.failed,
      `${ZERO_TRUST_STEPS}\nThen run \`tray setup\` again.`,
    );
  }

  p.log.info(`Tray uses Zero Trust for sign-in. ${ZERO_TRUST_STEPS}`, { output: process.stderr });
  const wait = deps.waitForEnter ?? pressEnter;
  await wait("Press Enter to open Cloudflare");
  (deps.open ?? openBrowser)(ZERO_TRUST_URL);
  while (!team) {
    await wait("Press Enter once it's enabled");
    team = await zeroTrustTeam(cf, accountId);
    if (!team)
      p.log.warn("Zero Trust still isn't enabled on this account.", { output: process.stderr });
  }
  row(ctx, true, team);
  return team;
}
