import { describe, expect, test } from "bun:test";
import { CHECK_BATCH_SIZE, MAX_DEPLOY_BYTES } from "@tray-sh/schema";
import type { Api } from "../src/api.ts";
import { TrayError } from "../src/errors.ts";
import {
  CHECK_CONCURRENCY,
  UPLOAD_CONCURRENCY,
  buildManifest,
  checkSize,
  chunk,
  findMissing,
  hashFiles,
  mapLimit,
  sha256,
  uploadMissing,
} from "../src/upload.ts";
import { bytes } from "./helpers.ts";

const file = (path: string, content: string | Uint8Array) => ({
  path,
  data: typeof content === "string" ? bytes(content) : content,
  type: "text/plain",
});

describe("hashing", () => {
  test("sha256 hex matches known vectors", () => {
    expect(sha256(bytes(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("manifest maps paths to hash, size and type", () => {
    const m = buildManifest(hashFiles([file("/index.html", "abc")]));
    expect(m).toEqual({
      "/index.html": {
        hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        size: 3,
        type: "text/plain",
      },
    });
  });
});

describe("size limit", () => {
  test("50 MB is allowed, one byte more is not", () => {
    expect(() => checkSize([file("/a", new Uint8Array(MAX_DEPLOY_BYTES))])).not.toThrow();
    const err = (() => {
      try {
        checkSize([file("/big.bin", new Uint8Array(MAX_DEPLOY_BYTES)), file("/small.txt", "x")]);
      } catch (e) {
        return e as TrayError;
      }
    })()!;
    expect(err).toBeInstanceOf(TrayError);
    expect(err.code).toBe("too_large");
    expect(err.exit).toBe(1);
    expect(err.hint).toContain("/big.bin");
    expect(err.hint!.indexOf("/big.bin")).toBeLessThan(err.hint!.indexOf("/small.txt"));
  });
});

describe("batching", () => {
  test("chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  test("mapLimit keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(
      Array.from({ length: 50 }, (_, i) => i),
      8,
      async (n) => {
        peak = Math.max(peak, ++inFlight);
        await Bun.sleep(Math.random() * 3);
        inFlight--;
        return n * 2;
      },
    );
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
    expect(peak).toBe(8);
  });

  test("limits match the spec", () => {
    expect(CHECK_BATCH_SIZE).toBe(512);
    expect(CHECK_CONCURRENCY).toBe(20);
    expect(UPLOAD_CONCURRENCY).toBe(32);
  });

  test("findMissing dedupes and sends batches of CHECK_BATCH_SIZE, at most CHECK_CONCURRENCY at once", async () => {
    const batches: string[][] = [];
    let inFlight = 0;
    let peak = 0;
    const api = {
      async checkBlobs(hashes: string[]) {
        peak = Math.max(peak, ++inFlight);
        batches.push(hashes);
        await Bun.sleep(1);
        inFlight--;
        return { missing: hashes.filter((h) => h.endsWith("0")) };
      },
    } as unknown as Api;
    const total = CHECK_BATCH_SIZE * 25 + 7;
    const hashes = Array.from({ length: total }, (_, i) => i.toString(16).padStart(64, "0"));
    const missing = await findMissing(api, [...hashes, ...hashes.slice(0, 10)]);
    expect(batches.length).toBe(26);
    expect(batches.every((b) => b.length <= CHECK_BATCH_SIZE)).toBe(true);
    expect(batches.flat().length).toBe(total);
    expect(peak).toBe(CHECK_CONCURRENCY);
    expect(missing.size).toBe(hashes.filter((h) => h.endsWith("0")).length);
  });

  test("uploadMissing uploads each missing blob once, at most UPLOAD_CONCURRENCY at once", async () => {
    const files = hashFiles(
      Array.from({ length: 100 }, (_, i) => file(`/f${i}`, `content ${i % 60}`)),
    );
    const present = new Set(files.slice(0, 10).map((f) => f.hash));
    const put: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];
    const api = {
      async checkBlobs(hashes: string[]) {
        return { missing: hashes.filter((h) => !present.has(h)) };
      },
      async putBlob(hash: string) {
        peak = Math.max(peak, ++inFlight);
        put.push(hash);
        await Bun.sleep(1);
        inFlight--;
        return { ok: true };
      },
    } as unknown as Api;
    const n = await uploadMissing(api, files, (done) => progress.push(done));
    expect(n).toBe(50); // 60 distinct contents, 10 already present
    expect(new Set(put).size).toBe(50);
    expect(put.some((h) => present.has(h))).toBe(false);
    expect(peak).toBe(UPLOAD_CONCURRENCY);
    expect(progress.at(-1)).toBe(50);
  });
});
