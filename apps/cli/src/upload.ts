// Hash, size-check, and upload collected files, then build the deploy manifest.
import { CHECK_BATCH_SIZE, MAX_DEPLOY_BYTES } from "@tray-sh/schema";
import type { Manifest } from "./api.ts";
import type { Api } from "./api.ts";
import type { SiteFile } from "./collect.ts";
import { EXIT, TrayError } from "./errors.ts";
import { formatBytes } from "./format.ts";

/** Parallel POST /check requests. */
export const CHECK_CONCURRENCY = 20;
/** Parallel PUT /blob uploads. */
export const UPLOAD_CONCURRENCY = 32;

export interface HashedFile extends SiteFile {
  hash: string;
}

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export function hashFiles(files: SiteFile[]): HashedFile[] {
  return files.map((f) => ({ ...f, hash: sha256(f.data) }));
}

export function totalBytes(files: SiteFile[]): number {
  return files.reduce((n, f) => n + f.data.byteLength, 0);
}

/** Reject deploys over 50 MB, naming the largest files. */
export function checkSize(files: SiteFile[], limit = MAX_DEPLOY_BYTES): void {
  const total = totalBytes(files);
  if (total <= limit) return;
  const largest = [...files]
    .sort((a, b) => b.data.byteLength - a.data.byteLength)
    .slice(0, 5)
    .map((f) => `  ${formatBytes(f.data.byteLength).padStart(8)}  ${f.path}`)
    .join("\n");
  throw new TrayError(
    `deploy is ${formatBytes(total)}, over the ${formatBytes(limit)} limit`,
    "too_large",
    EXIT.failed,
    `Largest files:\n${largest}`,
  );
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function buildManifest(files: HashedFile[]): Manifest {
  const manifest: Manifest = {};
  for (const f of files) manifest[f.path] = { hash: f.hash, size: f.data.byteLength, type: f.type };
  return manifest;
}

/** Ask the Worker which blobs it lacks (batches of CHECK_BATCH_SIZE, CHECK_CONCURRENCY at a time). */
export async function findMissing(api: Api, hashes: string[]): Promise<Set<string>> {
  const unique = [...new Set(hashes)];
  const batches = await mapLimit(chunk(unique, CHECK_BATCH_SIZE), CHECK_CONCURRENCY, (batch) =>
    api.checkBlobs(batch),
  );
  return new Set(batches.flatMap((b) => b.missing));
}

/** Upload one copy of each file whose hash is in `hashes`, UPLOAD_CONCURRENCY in parallel. Returns the number uploaded. */
export async function uploadHashes(
  api: Api,
  files: HashedFile[],
  hashes: Set<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const todo = [
    ...new Map(files.filter((f) => hashes.has(f.hash)).map((f) => [f.hash, f])).values(),
  ];
  let done = 0;
  await mapLimit(todo, UPLOAD_CONCURRENCY, async (f) => {
    await api.putBlob(f.hash, f.data);
    onProgress?.(++done, todo.length);
  });
  return todo.length;
}

/** Upload every blob the Worker lacks. Returns the number uploaded. */
export async function uploadMissing(
  api: Api,
  files: HashedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const missing = await findMissing(
    api,
    files.map((f) => f.hash),
  );
  return uploadHashes(api, files, missing, onProgress);
}
