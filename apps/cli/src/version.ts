// One version for the whole project (SPEC §6), read from this package at
// build time. test/version.test.ts checks the Worker and the skill agree.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
