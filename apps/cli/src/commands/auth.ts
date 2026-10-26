import { ApiFailure, type Api } from "../api.ts";
import { loadAccounts, saveAccounts, shortHostname } from "../config.ts";
import { normalizeDomain, resolveDomain } from "../credentials.ts";
import {
  apiFor,
  askText,
  authedApi,
  confirm,
  info,
  openBrowser,
  result,
  spinner,
  warn,
  type Ctx,
} from "../ctx.ts";
import { EXIT, TrayError, cancelled, notLoggedIn } from "../errors.ts";
import { formatTable, toJson } from "../format.ts";
import type { Token } from "../api.ts";
import { offerSkillInstall } from "../skill.ts";

/**
 * Poll POST /auth/token (RFC 8628 semantics): `authorization_pending` keeps
 * polling, `slow_down` adds 5s, `expired_token` / `access_denied` stop.
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
      if (!(err instanceof ApiFailure)) throw err;
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (err.code === "access_denied")
        throw new TrayError("login was denied", "access_denied", EXIT.auth);
      if (err.code === "expired_token") break;
      throw err;
    }
  }
  throw new TrayError("login code expired", "expired_token", EXIT.auth, "Run `tray login` again.");
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
        placeholder: "thts.app",
      })),
  );
  const api = apiFor(ctx, domain);

  const device = await api.startDevice(nameFlag ?? shortHostname());
  const url = device.verificationUriComplete;
  if (ctx.mode.json)
    ctx.stdout(toJson({ approveUrl: url, userCode: device.userCode }, ctx.mode.prettyJson));
  const how = `${url}\n  or on a logged-in machine: tray approve ${device.userCode}`;
  if (ctx.mode.interactive) {
    info(ctx, `Opening ${how}`);
    openBrowser(url);
  } else {
    ctx.stderr(`Open ${how}\nwaiting…`);
  }

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
  result(ctx, `✓ Logged in as ${token.email} on ${domain}`, {
    domain,
    email: token.email,
    name: token.name,
  });
  await offerSkillInstall(ctx);
}

export async function approve(ctx: Ctx, code: string): Promise<void> {
  const { api } = await authedApi(ctx);
  const userCode = code.trim().toUpperCase();
  const pending = await api.getDevice(userCode);
  info(ctx, `Device: ${pending.name}\nIP:     ${pending.ip}`);
  if (!(await confirm(ctx, "Approve?"))) throw cancelled();
  await api.approveDevice(userCode);
  result(ctx, `✓ Approved ${pending.name}`, {
    userCode,
    name: pending.name,
    ip: pending.ip,
    approved: true,
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
  result(ctx, `Logged out of ${domain}`, { domain, loggedOut: true });
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
  const me = {
    domain,
    email: source === "env" ? null : (account?.email ?? null),
    key: source === "env" ? "TRAY_API_KEY" : (account?.keyName ?? null),
    source,
  };
  const text = [
    `${me.email ?? "(API key)"} on ${domain}`,
    `key: ${me.key ?? "unknown"} (${source === "env" ? "TRAY_API_KEY" : source})`,
  ].join("\n");
  result(ctx, text, me);
}

export async function accountList(ctx: Ctx): Promise<void> {
  const { current, accounts } = loadAccounts(ctx.configDir);
  const data = Object.entries(accounts).map(([domain, a]) => ({
    domain,
    email: a.email,
    name: a.keyName,
    current: domain === current,
  }));
  const text = data.length
    ? formatTable(
        ["", "DOMAIN", "EMAIL", "DEVICE"],
        data.map((a) => [a.current ? "*" : "", a.domain, a.email, a.name]),
      )
    : "Not logged in to any tray. Run `tray login <domain>`.";
  result(ctx, text, { current: current ?? null, data });
}

export async function accountSwitch(ctx: Ctx, domainArg: string): Promise<void> {
  const domain = normalizeDomain(domainArg);
  const accounts = loadAccounts(ctx.configDir);
  if (!accounts.accounts[domain]) throw notLoggedIn(domain);
  accounts.current = domain;
  saveAccounts(ctx.configDir, accounts);
  result(ctx, `Switched to ${domain}`, { current: domain });
}
