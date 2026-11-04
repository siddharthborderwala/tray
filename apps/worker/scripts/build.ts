// Bundles the Worker into one ES module: dist/worker.js. The CLI embeds this
// file and uploads it with the Cloudflare API in `tray setup`.
// Also writes dist/openapi.json (servers templated as https://tray.{domain}/v1),
// which the site publishes at tray.sh/openapi.json.
// Files are overwritten in place (no clearing dist/ first), so `wrangler dev`,
// which runs dist/worker.js, never sees it missing mid-rebuild.
import { openApiDocument } from "../src/app.ts";

const outdir = new URL("../dist/", import.meta.url).pathname;

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
// The toolbar is inlined by a macro (scripts/toolbar.ts). If that ever stops
// happening, fail here rather than ship a Worker without it.
const source = await out.text();
if (!source.includes("TRAY_TOOLBAR_CONFIG") || source.includes("spawnSync")) {
  console.error("dist/worker.js: the toolbar wasn't inlined by its macro");
  process.exit(1);
}
const gzip = Bun.gzipSync(new Uint8Array(await out.arrayBuffer())).byteLength;
console.log(
  `dist/worker.js  ${(out.size / 1024).toFixed(1)} KB  (${(gzip / 1024).toFixed(1)} KB gzip)`,
);

await Bun.write(outdir + "openapi.json", JSON.stringify(openApiDocument(), null, 2) + "\n");
console.log("dist/openapi.json");
