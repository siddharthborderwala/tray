// Bundles the toolbar (src/toolbar-client.ts, which runs in visitors' pages)
// for the browser. A Bun macro: src/toolbar.ts imports it with
// `{ type: "macro" }`, so Bun runs it while compiling the Worker (in tests and
// in the production build alike) and inlines the result as a string. Nothing
// is generated into the repo.

const CLIENT = new URL("../src/toolbar-client.ts", import.meta.url).pathname;

/** The toolbar as one minified browser script, pure ASCII. */
export function toolbarBundle(): string {
  // Synchronous on purpose: a macro's return value is inlined as-is.
  const r = Bun.spawnSync(
    [process.execPath, "build", CLIENT, "--target=browser", "--format=esm", "--minify"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`toolbar bundle failed:\n${r.stderr.toString()}`);
  // \uXXXX escapes, so the script reads the same whatever charset a browser
  // decodes it with.
  return r.stdout
    .toString()
    .trim()
    .replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
