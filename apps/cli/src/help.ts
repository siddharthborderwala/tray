// Help text: the router's output, with `tray ` prefixed and the root footer.
import { printHelp } from "@bomb.sh/router";

const ROOT_HELP_FOOTER = `
Environment:
  TRAY_DOMAIN           Tray to use (e.g. acme.dev).
  TRAY_API_KEY          API key. Overrides saved login.
  CLOUDFLARE_API_TOKEN  Used by \`tray setup\` and \`tray domain add\`.
  NO_COLOR, CI          Respected. CI implies --non-interactive.
  AGENT, AI_AGENT       Agent detected (also CLAUDECODE, CURSOR_AGENT, GEMINI_CLI,
                        CODEX_THREAD_ID): non-interactive, like CI.
  TRAY_INTERACTIVE      1 forces interactive mode (TTYs still required).

Exit codes: 0 ok · 1 failed · 2 bad usage / missing input · 4 not authenticated · 130 cancelled`;

/** The router prints sub-routes as `put …`; show them as `tray put …`. */
export function helpText(intent: Parameters<typeof printHelp>[0]): string {
  const text = printHelp(intent);
  if (intent.route === "/") return text + "\n" + ROOT_HELP_FOOTER;
  const path = intent.path.join(" ");
  return text
    .replace(new RegExp(`^${path}`), `tray ${path}`)
    .replace(`Usage:\n  ${path}`, `Usage:\n  tray ${path}`);
}
