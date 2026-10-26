#!/usr/bin/env bun
import { EXIT } from "./errors.ts";
import { main } from "./main.ts";

// Ctrl-C anywhere (including mid-upload) exits 130.
process.on("SIGINT", () => process.exit(EXIT.cancelled));

process.exitCode = await main(process.argv.slice(2));
