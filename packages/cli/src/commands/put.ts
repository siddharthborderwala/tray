import { ApiFailure, type Api } from "../api.ts";
import { collect } from "../collect.ts";
import { machineId, setSiteRecord, shortHostname } from "../config.ts";
import { deployFlags, machineLabel, onSiteExists } from "../conflict.ts";
import { authedApi, askText, confirm, info, intro, outro, spinner, step, warn, type Ctx } from "../ctx.ts";
import { EXIT, TrayError, cancelled, usageError } from "../errors.ts";
import { formatBytes, plural } from "../format.ts";
import { buildManifest, checkSize, hashFiles, totalBytes, uploadHashes, uploadMissing, type HashedFile } from "../upload.ts";
import { SiteName, type DeployRequest } from "../wire.ts";

export interface PutArgs {
  path: string;
  site?: string;
  private: boolean;
  spa: boolean;
  replace: boolean;
}

export async function put(ctx: Ctx, args: PutArgs): Promise<void> {
  intro(ctx);

  // 1. Collect, hash, size-check.
  const collected = await collect(args.path);
  if (collected.files.length === 0) throw usageError(`nothing to put: ${args.path} has no files`, "Dotfiles, .git and node_modules are skipped.");
  const site = await siteName(ctx, args.site ?? collected.defaultSite, args.path);
  const files = hashFiles(collected.files);
  checkSize(files);
  const bytes = totalBytes(files);
  step(ctx, `Collected ${plural(files.length, "file")} · ${formatBytes(bytes)}`);
  if (!files.some((f) => f.path === "/index.html")) warn(ctx, "no /index.html; the site root will 404");

  const { api, domain } = await authedApi(ctx);
  const existing = await api.getSite(site);

  // 2. Upload what the Worker doesn't have yet.
  const spin = spinner(ctx);
  spin.start("Uploading");
  let uploaded: number;
  try {
    uploaded = await uploadMissing(api, files, (done, total) => spin.message(`Uploading ${done}/${total}`));
  } catch (err) {
    spin.error("Upload failed");
    throw err;
  }
  spin.stop(uploaded === 0 ? "No changed files" : `Uploaded ${plural(uploaded, "changed file")}`);

  // 3. Deploy. The Worker compares `source` and answers 409 site_exists for a site put from elsewhere.
  const id = machineId(ctx.configDir);
  const base = {
    files: buildManifest(files),
    spa: args.spa,
    source: { path: collected.source, machine: machineLabel(shortHostname(), id) },
  };
  const request = (replace: boolean): DeployRequest => ({ ...base, ...deployFlags({ exists: !!existing, replace, private: args.private }) });
  const addUploaded = (n: number) => (uploaded += n);

  let replace = args.replace;
  let deployed: Awaited<ReturnType<Api["deploy"]>>;
  try {
    deployed = await deployWithBlobRetry(api, site, request(replace), files, addUploaded);
  } catch (err) {
    if (!(err instanceof ApiFailure && err.code === "site_exists")) throw err;
    if (onSiteExists({ interactive: ctx.mode.interactive, replacing: replace }) === "fail") {
      throw new TrayError(err.message, "site_exists", EXIT.failed, "Use --replace to overwrite it, or -s <other> to pick another name.", "site");
    }
    if (!(await confirm({ ...ctx, yes: false }, `${err.message}. Replace?`))) throw cancelled();
    replace = true;
    deployed = await deployWithBlobRetry(api, site, request(replace), files, addUploaded);
  }
  if (existing && !replace && args.private && existing.visibility === "public") {
    warn(ctx, `--private only applies to new sites or with --replace. Use \`tray edit ${site} --visibility private\`.`);
  }
  if (!deployed.created) info(ctx, "Nothing changed: same files as the current deploy.");
  if (collected.source !== "-") setSiteRecord(ctx.configDir, domain, site, { absolutePath: collected.source, machineId: id });

  // 4. Report.
  const live = deployed.site;
  const who = live.visibility === "private" ? audience(live.shareCount) : "public";
  outro(ctx, ctx.mode.interactive ? `${live.url}   (${who})` : live.url, {
    site: live.name,
    url: live.url,
    visibility: live.visibility,
    deploy: deployed.deploy.id,
    files: files.length,
    uploaded,
    bytes,
  });
}

/** POST the deploy; on `409 missing_blobs` upload those blobs and retry once. */
export async function deployWithBlobRetry(api: Api, site: string, req: DeployRequest, files: HashedFile[], onUploaded: (n: number) => void = () => {}) {
  try {
    return await api.deploy(site, req);
  } catch (err) {
    if (!(err instanceof ApiFailure && err.code === "missing_blobs" && err.body?.missing?.length)) throw err;
    onUploaded(await uploadHashes(api, files, new Set(err.body.missing)));
    return api.deploy(site, req);
  }
}

function audience(shareCount: number): string {
  const others = shareCount - 1;
  return others > 0 ? `private · you + ${others}` : "private · you";
}

async function siteName(ctx: Ctx, candidate: string | undefined, path: string): Promise<string> {
  let name = candidate;
  if (!name) {
    if (!ctx.mode.interactive) {
      throw new TrayError(
        path === "-" ? "missing site name for stdin" : `can't derive a site name from ${path}`,
        "missing_input",
        EXIT.usage,
        "Pass -s <site>.",
        "--site",
      );
    }
    name = await askText(ctx, {
      flag: "-s <site>",
      message: "Site name",
      placeholder: "my-site",
      validate: (v) => (SiteName.safeParse(v).success ? undefined : "lowercase letters, digits and dashes"),
    });
  }
  if (!SiteName.safeParse(name).success) {
    throw usageError(`invalid site name: ${name}`, "Use lowercase letters, digits and dashes (max 63), not `tray`.", "--site");
  }
  return name;
}
