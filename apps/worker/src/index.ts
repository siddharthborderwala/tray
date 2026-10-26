// Worker entry point (module syntax). Bundled to dist/worker.js by scripts/build.ts.
import { createApp } from "./app.ts";

export type { AppType } from "./app.ts";
export type { Env } from "./env.ts";

export default createApp();
