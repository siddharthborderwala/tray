// Bundles the Worker into one ES module: dist/worker.js. The CLI embeds this
// file and uploads it with the Cloudflare API in `tray setup`.
import { rm } from "node:fs/promises";

const outdir = new URL("../dist/", import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
  outdir,
  naming: "worker.js",
  target: "browser", // Workers: web-standard APIs, no Node built-ins
  format: "esm",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const out = Bun.file(outdir + "worker.js");
const gzip = Bun.gzipSync(new Uint8Array(await out.arrayBuffer())).byteLength;
console.log(
  `dist/worker.js  ${(out.size / 1024).toFixed(1)} KB  (${(gzip / 1024).toFixed(1)} KB gzip)`,
);
