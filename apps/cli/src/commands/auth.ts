import { ApiFailure, type Api } from "../api.ts";
import { loadAccounts, saveAccounts, shortHostname } from "../config.ts";
import { apiUrl, normalizeDomain, resolveDomain } from "../credentials.ts";
import {
  apiFor,
  askText,
  authedApi,
  confirm,
  currentDomain,
  empty,
  info,
  openBrowser,
  receipt,
  result,
  spinner,
  warn,
  type Ctx,
} from "../ctx.ts";
import { EXIT, TrayError, cancelled, notLoggedIn } from "../errors.ts";
import { formatPairs, formatTable, plain } from "../format.ts";
import type { Token } from "../api.ts";
import { offerSkillInstall } from "../skill.ts";

/**
 * Poll POST /auth/token (RFC 8628 semantics): `authorization_pending` keeps
 * polling, `slow_down` adds 5s, `expired_token` / `access_denied` stop.
 * Network errors and 5xx are transient while waiting: keep polling until the
 * code expires.
 */
export async function pollForKey(
  api: Api,
  deviceCode: string,
  intervalSeconds: number,
  opts: {
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
    expiresInSeconds?: number;
  } = {},
): Promise<Token> {
  const sleep = opts.sleep ?? Bun.sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.expiresInSeconds ?? 600) * 1000;
  let interval = intervalSeconds * 1000;
  while (now() < deadline) {
    await sleep(interval);
    try {
      return await api.pollToken(deviceCode);
    } catch (err) {
      if (err instanceof TrayError && err.code === "network") continue;
      if (!(err instanceof ApiFailure)) throw err;
      if (err.code === "authorization_pending" || err.status >= 500) continue;
      if (err.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (err.code === "access_denied")
        throw new TrayError("Login was denied", "access_denied", EXIT.auth);
      if (err.code === "expired_token") break;
      throw err;
    }
  }
  throw new TrayError("Login code expired", "expired_token", EXIT.auth, "Run `tray login` again.");
}

export async function login(
  ctx: Ctx,
  domainArg: string | undefined,
  nameFlag: string | undefined,
): Promise<void> {
  const given = domainArg ?? ctx.domainFlag ?? ctx.env.TRAY_DOMAIN;
  const domain = normalizeDomain(
    given ??
      (await askText(ctx, {
        flag: "<domain>",
        message: "Domain of your tray",
        placeholder: "acme.dev",
      })),
  );
  const api = apiFor(ctx, domain);

  const device = await api.startDevice(nameFlag ?? shortHostname());
  // Built here, not taken from the server, so a bad Worker can't choose what we open.
  const url = apiUrl(domain, ctx.env, `approve?code=${encodeURIComponent(device.userCode)}`);
  // stdout holds only the result; the link goes on stderr (one JSON line with
  // --json) so an agent can relay it while this waits.
  const expiresAt = new Date(Date.now() + device.expiresIn * 1000).toISOString();
  const how = `${url}\n  or on a logged-in machine: tray approve ${device.userCode}`;
  if (ctx.mode.json)
    ctx.stderr(
      JSON.stringify({ pending: { approveUrl: url, userCode: device.userCode, expiresAt } }),
    );
  else if (ctx.mode.interactive && !ctx.noOpen) {
    info(ctx, `Opening ${how}`);
    openBrowser(url);
  } else ctx.stderr(`Open ${how}\nwaiting…`);

  const spin = spinner(ctx);
  spin.start("waiting…");
  let token: Token;
  try {
    token = await pollForKey(api, device.deviceCode, device.interval, {
      expiresInSeconds: device.expiresIn,
      sleep: ctx.sleep,
    });
  } catch (err) {
    spin.error("Login failed");
    throw err;
  }
  spin.stop("Approved");

  await ctx.keyStore.set(domain, token.key);
  const accounts = loadAccounts(ctx.configDir);
  accounts.accounts[domain] = { email: token.email, keyName: token.name };
  accounts.current = domain;
  saveAccounts(ctx.configDir, accounts);
  receipt(ctx, `Logged in as ${token.email} on ${domain}`);
  result(ctx, "", {
    account: { domain, email: token.email, name: token.name },
    outcome: "logged_in",
  });
  await offerSkillInstall(ctx);
}

/**
 * Grants a new device a key for this tray, so a person must decide it: only
 * interactively, never with --yes. Agents and scripts get the browser link.
 */
export async function approve(ctx: Ctx, code: string): Promise<void> {
  const userCode = code.trim().toUpperCase();
  if (!ctx.mode.interactive) {
    const domain = currentDomain(ctx);
    throw new TrayError(
      "tray approve needs a person at a terminal",
      "interactive_required",
      EXIT.usage,
      "Approving gives a device a key to this tray. Approve it in your browser:",
      undefined,
      { next: [apiUrl(domain, ctx.env, `approve?code=${encodeURIComponent(userCode)}`)] },
    );
  }
  const { api } = await authedApi(ctx);
  const pending = await api.getDevice(userCode);
  // Shown before a yes/no that mints a key: never let server text move the cursor or add lines.
  info(ctx, `Device  ${plain(pending.name)}\nIP      ${plain(pending.ip)}`);
  const ok = await confirm(
    { ...ctx, yes: false },
    `Approve the login for ${plain(pending.name)}? It gets its own key for this tray.`,
  );
  if (!ok) throw cancelled();
  await api.approveDevice(userCode);
  receipt(ctx, `Approved ${plain(pending.name)}`);
  result(ctx, "", {
    login: { userCode, name: pending.name, ip: pending.ip },
    outcome: "approved",
  });
}

export async function logout(ctx: Ctx, domainArg: string | undefined): Promise<void> {
  const accounts = loadAccounts(ctx.configDir);
  const domain = domainArg
    ? normalizeDomain(domainArg)
    : resolveDomain(ctx.domainFlag, ctx.env, accounts);
  const key = await ctx.keyStore.get(domain);
  if (!accounts.accounts[domain] && !key) throw notLoggedIn(domain);

  // Revoke this device's key on the server; forget it locally either way.
  if (key) {
    try {
      await apiFor(ctx, domain, key).revokeCurrentKey();
    } catch (err) {
      warn(ctx, `could not revoke the key on ${domain}: ${(err as Error).message}`);
    }
  }
  await ctx.keyStore.delete(domain);
  delete accounts.accounts[domain];
  if (accounts.current === domain) accounts.current = Object.keys(accounts.accounts)[0];
  saveAccounts(ctx.configDir, accounts);
  receipt(ctx, `Logged out of ${domain}`);
  result(ctx, "", { account: { domain }, outcome: "logged_out" });
}

/** `tray whoami`: domain, email, key name, and where the credential came from. Never prompts. */
export async function whoami(ctx: Ctx): Promise<void> {
  const accounts = loadAccounts(ctx.configDir);
  const domain = resolveDomain(ctx.domainFlag, ctx.env, accounts);
  const account = accounts.accounts[domain];
  let source: "env" | "keychain" | "file";
  if (ctx.env.TRAY_API_KEY) source = "env";
  else {
    const saved =
      (await ctx.keyStore.source?.(domain)) ??
      ((await ctx.keyStore.get(domain)) ? "keychain" : null);
    if (!saved) throw notLoggedIn(domain);
    source = saved;
  }
  const where =
    source === "env" ? "TRAY_API_KEY" : source === "keychain" ? "the keychain" : "auth.json";
  // A saved key with no local login record (accounts.json missing or wiped): the key works,
  // but who it belongs to isn't known locally. Say so instead of printing nulls silently.
  const me = {
    domain,
    email: source === "env" ? null : (account?.email ?? null),
    key: source === "env" ? null : (account?.keyName ?? null),
    source,
  };
  if (source !== "env" && !account)
    warn(
      ctx,
      `a key for ${domain} is saved in ${where}, but there's no local login record, so its email and name are unknown. Run \`tray login ${domain}\` to refresh it.`,
      "no_login_record",
    );
  const rows: [string, string][] = [
    ["domain", domain],
    ["email", me.email ?? (source === "env" ? "(API key)" : "unknown")],
    ["key", source === "env" ? "from TRAY_API_KEY" : `${me.key ?? "unknown"} (in ${where})`],
  ];
  result(ctx, formatPairs(rows, ctx.mode.stdoutTTY !== false), { account: me });
}

export async function accountList(ctx: Ctx): Promise<void> {
  const { current, accounts } = loadAccounts(ctx.configDir);
  const data = Object.entries(accounts).map(([domain, a]) => ({
    domain,
    email: a.email,
    name: a.keyName,
    current: domain === current,
  }));
  const headers = ["", "DOMAIN", "EMAIL", "DEVICE"];
  if (!data.length && !ctx.mode.json)
    return empty(ctx, headers, "Not logged in to any tray.", "tray login <DOMAIN>");
  const text = formatTable(
    headers,
    data.map((a) => [a.current ? "*" : "", a.domain, a.email, a.name]),
    ctx.mode.stdoutTTY !== false,
  );
  result(ctx, text, { accounts: data, current: current ?? null });
}

export async function accountSwitch(ctx: Ctx, domainArg: string): Promise<void> {
  const domain = normalizeDomain(domainArg);
  const accounts = loadAccounts(ctx.configDir);
  if (!accounts.accounts[domain]) throw notLoggedIn(domain);
  accounts.current = domain;
  saveAccounts(ctx.configDir, accounts);
  receipt(ctx, `Switched to ${domain}`);
  result(ctx, "", { account: { domain }, outcome: "updated" });
}
