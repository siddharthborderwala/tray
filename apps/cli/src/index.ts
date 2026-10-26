#!/usr/bin/env bun
import { once } from "node:events";
import { keychainStalled } from "./credentials.ts";
import { EXIT } from "./errors.ts";
import { main } from "./main.ts";

// Ctrl-C anywhere (including mid-upload) exits 130.
process.on("SIGINT", () => process.exit(EXIT.cancelled));

const code = await main(process.argv.slice(2));
process.exitCode = code;

// A keychain call that timed out can still be pending in the OS and keep the
// process alive. Flush what we wrote, then exit.
if (keychainStalled()) {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableNeedDrain) await once(stream, "drain");
  }
  process.exit(code);
}
