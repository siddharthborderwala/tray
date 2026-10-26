// `tray upgrade`: replace this binary with the latest release, then (running
// as the new binary) refresh installed skill copies and redeploy the Worker on
// every tray this machine set up whose Worker is older, keeping its bindings.
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { apiBaseUrl } from "../credentials.ts";
import { info, result, spinner, success, warn, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, type ExitCode } from "../errors.ts";
import { cloudflare, loadWorkerSource, updateWorkerCode } from "../setup/cloudflare.ts";
import {
  detectTarget,
  fetchBinary,
  latestVersion,
  olderThan,
  replaceableBinary,
} from "../setup/release.ts";
import { loadSetups, savedToken } from "../setup/state.ts";
import { refreshInstalledSkills } from "../skill.ts";
import { VERSION } from "../version.ts";

export interface UpgradeDeps {
  execPath?: string;
  target?: string;
  /** Runs the new binary's `tray upgrade`; returns its exit code. */
  runNew?: (execPath: string, args: string[], env: Record<string, string>) => Promise<number>;
  workerSource?: string;
  /** Overrides the CLI version (tests). */
  version?: string;
}

const UPGRADED_FROM = "TRAY_UPGRADED_FROM";

async function runNewBinary(
  execPath: string,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  const child = Bun.spawn([execPath, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  return child.exited;
}

/** Write the new binary next to the old one and swap it in. */
function replaceBinary(execPath: string, binary: Uint8Array) {
  const next = `${execPath}.new`;
  writeFileSync(next, binary);
  chmodSync(next, 0o755);
  if (process.platform === "win32") {
    // A running .exe can't be overwritten, but it can be renamed.
    rmSync(`${execPath}.old`, { force: true });
    renameSync(execPath, `${execPath}.old`);
  }
  renameSync(next, execPath);
}

export async function upgrade(ctx: Ctx, deps: UpgradeDeps = {}): Promise<void> {
  const version = deps.version ?? VERSION;
  const fetchImpl = ctx.fetch ?? fetch;
  const execPath = deps.execPath ?? process.execPath;

  // Step 1 (old binary): fetch the newer release and hand over to it.
  if (!ctx.env[UPGRADED_FROM]) {
    const spin = spinner(ctx);
    spin.start("Checking for a new release…");
    const latest = await latestVersion(fetchImpl).catch((err) => {
      spin.error("Release check failed");
      throw err;
    });
    if (olderThan(version, latest)) {
      if (!replaceableBinary(execPath)) {
        spin.stop(`tray ${latest} is available`);
        throw new TrayError(
          `can't replace ${execPath} in place`,
          "not_standalone",
          EXIT.failed,
          /node_modules/.test(execPath)
            ? "Installed with npm: run `npm i -g @tray-sh/cli@latest`."
            : "Reinstall with: curl -fsSL tray.sh/install | sh",
        );
      }
      spin.message(`Downloading tray ${latest}…`);
      const target = deps.target ?? detectTarget();
      const binary = await fetchBinary(fetchImpl, latest, target).catch((err) => {
        spin.error("Download failed");
        throw err;
      });
      replaceBinary(execPath, binary);
      spin.stop(`tray ${version} → ${latest}`);

      const args = [
        "upgrade",
        ...(ctx.mode.json ? ["--json"] : []),
        ...(ctx.mode.interactive ? [] : ["--non-interactive"]),
        ...(ctx.yes ? ["--yes"] : []),
      ];
      const code = await (deps.runNew ?? runNewBinary)(execPath, args, {
        [UPGRADED_FROM]: version,
      });
      if (code !== 0)
        throw new TrayError(
          `the new tray exited with code ${code}`,
          "upgrade_failed",
          code as ExitCode,
        );
      return;
    }
    spin.stop(`tray ${version} is the latest`);
  }

  // Step 2 (new binary, or already up to date): skills + Workers.
  const home = ctx.env.HOME || homedir();
  const skills = refreshInstalledSkills(home, process.cwd());
  if (skills.length)
    success(
      ctx,
      `Refreshed the Tray skill in ${skills.length} place${skills.length === 1 ? "" : "s"}`,
    );

  const workers = [];
  for (const [domain, record] of Object.entries(loadSetups(ctx.configDir))) {
    workers.push(await redeployIfOlder(ctx, domain, record, version, deps));
  }

  const from = ctx.env[UPGRADED_FROM];
  const summary = from ? `Upgraded tray ${from} → ${version}` : `tray ${version} is up to date`;
  result(ctx, summary, { version, upgradedFrom: from ?? null, skills, workers });
}

async function workerVersion(ctx: Ctx, domain: string): Promise<string | null> {
  try {
    const res = await (ctx.fetch ?? fetch)(`${apiBaseUrl(domain, ctx.env)}/v1/openapi.json`);
    return res.headers.get("tray-version");
  } catch {
    return null;
  }
}

async function redeployIfOlder(
  ctx: Ctx,
  domain: string,
  record: { accountId: string; worker: string },
  version: string,
  deps: UpgradeDeps,
) {
  const current = await workerVersion(ctx, domain);
  if (current && !olderThan(current, version)) {
    info(ctx, `${domain}: Worker ${current} is current`);
    return { domain, from: current, to: current, redeployed: false };
  }
  const token = ctx.env.CLOUDFLARE_API_TOKEN?.trim() || (await savedToken(ctx.keyStore, domain));
  if (!token) {
    warn(
      ctx,
      `${domain}: Worker is ${current ?? "unreachable"}; set CLOUDFLARE_API_TOKEN (or re-run \`tray setup\`) to redeploy it`,
    );
    return { domain, from: current, to: current, redeployed: false };
  }
  const spin = spinner(ctx);
  spin.start(`${domain}: deploying Worker ${version}…`);
  const source = deps.workerSource ?? (await loadWorkerSource());
  try {
    await updateWorkerCode(
      cloudflare(token, ctx.fetch ?? fetch),
      record.accountId,
      record.worker,
      source,
    );
  } catch (err) {
    spin.error(`${domain}: Worker deploy failed`);
    throw err;
  }
  spin.stop(`${domain}: Worker ${current ?? "?"} → ${version}`);
  return { domain, from: current, to: version, redeployed: true };
}
