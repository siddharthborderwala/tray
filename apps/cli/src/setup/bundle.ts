// The Worker bundle (apps/worker/dist/worker.js), embedded in the binary at
// build time. Imported lazily so commands that don't need it (and tests that
// inject their own) don't require a built Worker.
import source from "@tray-sh/worker/bundle" with { type: "text" };

export const WORKER_SOURCE: string = source;
