// `tray setup [--domain <d>] [--email <e>]`: provision a tray on the user's
// Cloudflare account. Idempotent: re-running updates the Worker and fixes
// whatever is missing; it also issues a fresh key for this machine (recovery).
import * as p from "@clack/prompts";
import { loadAccounts, saveAccounts, shortHostname } from "../config.ts";
import { apiBaseUrl, normalizeDomain } from "../credentials.ts";
import { askText, info, intro, outro, spinner, step, warn, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled } from "../errors.ts";
import {
  type Binding,
  cloudflare,
  ensureAccessApp,
  ensureBucket,
  ensureCustomDomain,
  ensureOtpLogin,
  ensurePolicy,
  ensureRoute,
  ensureWildcardDns,
  findZone,
  subdomainsTakenOver,
  loadWorkerSource,
  TOKEN_PERMISSIONS,
  uploadWorker,
  zeroTrustTeam,
} from "../setup/cloudflare.ts";
import { loadSetups, resourceName, saveSetup, savedToken, saveToken } from "../setup/state.ts";
import { offerSkillInstall } from "../skill.ts";

export { upgrade } from "./upgrade.ts";

export interface SetupDeps {
  /** The Worker bundle; defaults to the one embedded in this binary. */
  workerSource?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `label` padded like the spec's output: `◇  R2 bucket            tray-thts-app`. */
function report(ctx: Ctx, label: string, value: string) {
  if (ctx.mode.interactive) step(ctx, `${label.padEnd(21)}${value}`);
  else ctx.stderr(`${label}: ${value}`);
}

async function askToken(ctx: Ctx, domain: string): Promise<string> {
  const fromEnv = ctx.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const saved = await savedToken(ctx.keyStore, domain);
  if (saved) return saved;
  if (!ctx.mode.interactive) {
    throw new TrayError(
      "missing Cloudflare API token",
      "missing_input",
      EXIT.usage,
      `Set CLOUDFLARE_API_TOKEN. The token needs ${TOKEN_PERMISSIONS}`,
      "CLOUDFLARE_API_TOKEN",
    );
  }
  const answer = await p.password({
    message: "Cloudflare API token (needs: Workers, R2, DNS, Access)",
    validate: (v) => (v?.trim() ? undefined : "required"),
    output: process.stderr,
  });
  if (p.isCancel(answer)) throw cancelled();
  return answer.trim();
}

/** A new API key and the record the Worker stores for it (hash only). */
export async function mintKey(name: string, email: string) {
  const random = crypto.getRandomValues(new Uint8Array(24));
  const key = "tray_k_" + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
  const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
  const record = {
    id: hash.slice(0, 12),
    hash,
    name,
    email,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  return { key, record };
}

export async function setup(
  ctx: Ctx,
  emailFlag: string | undefined,
  deps: SetupDeps = {},
): Promise<void> {
  intro(ctx);
  const domain = normalizeDomain(
    ctx.domainFlag ??
      (await askText(ctx, {
        flag: "--domain",
        message: "Domain for your tray (must be on Cloudflare)",
        placeholder: "thts.app",
      })),
  );
  const token = await askToken(ctx, domain);
  const previous = loadSetups(ctx.configDir)[domain];
  const email = (
    emailFlag ??
    previous?.email ??
    (await askText(ctx, {
      flag: "--email",
      message: "Your email",
      placeholder: "you@example.com",
      validate: (v) => (EMAIL_RE.test(v.trim()) ? undefined : "enter an email"),
    }))
  ).toLowerCase();
  if (!EMAIL_RE.test(email))
    throw new TrayError(
      `invalid email: ${email}`,
      "invalid_usage",
      EXIT.usage,
      undefined,
      "--email",
    );

  const cf = cloudflare(token, ctx.fetch ?? fetch);
  const spin = spinner(ctx);
  const name = previous?.worker ?? resourceName(domain);
  const bucket = previous?.bucket ?? resourceName(domain);
  const api = `tray.${domain}`;

  spin.start("Checking Cloudflare…");
  let accountId: string;
  let zoneId: string;
  let team: string;
  try {
    const zone = await findZone(cf, domain);
    accountId = zone.account.id;
    zoneId = zone.id;
    team = await zeroTrustTeam(cf, accountId);
  } catch (err) {
    spin.error("Cloudflare check failed");
    throw err;
  }
  spin.stop(`Cloudflare account ${accountId} · Zero Trust ${team}`);

  // R2
  spin.start("R2 bucket…");
  await ensureBucket(cf, accountId, bucket).catch((err) => fail(spin, err));
  spin.stop("R2 bucket ready");
  report(ctx, "R2 bucket", bucket);

  // Access: one owner app on /approve, one sign-in app on */.tray/signin. Reusable policies.
  spin.start("Access…");
  const approveUri = `${api}/approve`;
  const signinUri = `*.${domain}/.tray/signin`;
  const { approveApp, signinApp } = await (async () => {
    const otp = await ensureOtpLogin(cf, accountId);
    const ownerPolicy = await ensurePolicy(cf, accountId, `tray owner (${domain})`, [
      { email: { email } },
    ]);
    const anyonePolicy = await ensurePolicy(cf, accountId, `tray sign-in (${domain})`, [
      { everyone: {} },
    ]);
    const approveApp = await ensureAccessApp(cf, accountId, {
      name: `tray approve (${domain})`,
      uris: [approveUri],
      policyId: ownerPolicy,
      idpId: otp,
      sessionDuration: "24h",
    });
    const signinApp = await ensureAccessApp(cf, accountId, {
      name: `tray sign-in (${domain})`,
      uris: [signinUri],
      policyId: anyonePolicy,
      idpId: otp,
      sessionDuration: "168h",
      keepExtra: true, // custom hosts the Worker added
    });
    return { approveApp, signinApp };
  })().catch((err) => fail(spin, err));
  spin.stop("Access ready");

  // Worker, with a fresh key for this machine passed in as a secret (the Worker
  // moves it into R2 on first use).
  spin.start("Uploading the Worker…");
  const machine = shortHostname();
  const { key, record } = await mintKey(machine, email);
  const bindings: Binding[] = [
    { type: "r2_bucket", name: "BUCKET", bucket_name: bucket },
    { type: "plain_text", name: "DOMAIN", text: domain },
    { type: "plain_text", name: "OWNER_EMAIL", text: email },
    { type: "plain_text", name: "WORKER_NAME", text: name },
    { type: "plain_text", name: "ACCESS_TEAM_DOMAIN", text: team },
    { type: "plain_text", name: "ACCESS_APPROVE_AUD", text: approveApp.aud },
    { type: "plain_text", name: "ACCESS_SIGNIN_AUD", text: signinApp.aud },
    { type: "plain_text", name: "ACCESS_SIGNIN_APP_ID", text: signinApp.id },
    { type: "plain_text", name: "CF_ACCOUNT_ID", text: accountId },
    { type: "secret_text", name: "CF_API_TOKEN", text: token },
    { type: "secret_text", name: "TRAY_SETUP_KEY", text: JSON.stringify(record) },
  ];
  const source = deps.workerSource ?? (await loadWorkerSource());
  await uploadWorker(cf, accountId, name, source, bindings).catch((err) => fail(spin, err));
  spin.stop("Worker uploaded");
  report(ctx, "Worker", name);

  // Routes + DNS: tray.<domain> as a Custom Domain (Cloudflare adds DNS + TLS),
  // *.<domain>/* as a route with a proxied wildcard record.
  spin.start("Routes + DNS…");
  const dnsWarning = await (async () => {
    await ensureCustomDomain(cf, accountId, zoneId, api, name);
    await ensureRoute(cf, zoneId, `*.${domain}/*`, name);
    return ensureWildcardDns(cf, zoneId, domain);
  })().catch((err) => fail(spin, err));
  spin.stop("Routes + DNS ready");
  report(ctx, "Routes + DNS", `*.${domain}, ${api}`);
  if (dnsWarning) warn(ctx, dnsWarning);
  const takenOver = await subdomainsTakenOver(cf, zoneId, domain);
  if (takenOver.length) {
    warn(
      ctx,
      `*.${domain}/* now sends ${takenOver.join(", ")} to Tray, so they show the Tray 404. Tray works best on a domain of its own.`,
    );
  }
  report(ctx, "Access", `${approveUri} → ${email}`);
  report(ctx, "Sign-in", `${signinUri} (email code)`);

  // Remember everything for re-runs and `tray upgrade`; log this machine in.
  saveSetup(ctx.configDir, domain, { accountId, zoneId, worker: name, bucket, email });
  await saveToken(ctx.keyStore, domain, token);
  const oldKey = await ctx.keyStore.get(domain);
  await ctx.keyStore.set(domain, key);
  const accounts = loadAccounts(ctx.configDir);
  accounts.accounts[domain] = { email, keyName: machine };
  accounts.current = domain;
  saveAccounts(ctx.configDir, accounts);

  spin.start(`Waiting for https://${api}…`);
  const live = await waitForWorker(ctx, domain, key);
  if (live) {
    spin.stop(`${api} is live`);
    // A re-run replaced this machine's key; retire the old one (best effort).
    if (oldKey && oldKey !== key) await revoke(ctx, domain, oldKey);
  } else {
    spin.stop(`${api} isn't answering yet`);
    warn(
      ctx,
      `New DNS and certificates can take a few minutes. Check with \`tray whoami\` or \`tray list\` shortly.`,
    );
  }
  info(
    ctx,
    "Each person who signs in to view a private site uses a Zero Trust seat (Free plan: 50).",
  );

  await offerSkillInstall(ctx);
  outro(ctx, `Your tray is ready at ${domain}. This machine is logged in.`, {
    domain,
    email,
    api: `https://${api}/v1`,
    worker: name,
    bucket,
    accountId,
    key: machine,
    live,
  });
}

function fail(spin: { error(msg: string): void }, err: unknown): never {
  spin.error("Failed");
  throw err;
}

async function revoke(ctx: Ctx, domain: string, key: string) {
  try {
    await (ctx.fetch ?? fetch)(`${apiBaseUrl(domain, ctx.env)}/v1/keys/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
  } catch {}
}

/** Use the new key once: proves the Worker is up and moves the key into R2. */
async function waitForWorker(ctx: Ctx, domain: string, key: string): Promise<boolean> {
  const sleep = ctx.sleep ?? Bun.sleep;
  const url = `${apiBaseUrl(domain, ctx.env)}/v1/keys`;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await (ctx.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${key}` } });
      if (res.ok) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}
