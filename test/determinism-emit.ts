/*
 * The child half of test/determinism.test.ts's CROSS-PROCESS check.
 *
 * Compiles one file to LLVM IR and writes the bytes to stdout, nothing else. It has
 * to be a separate process — an in-process "compile it twice" can only see a value
 * that drifts DURING a run (a `Date.now()` read twice), and is blind to anything
 * seeded ONCE per process: a module-level `Date.now()`, a PID, an address, a
 * `Math.random()` cached in a top-level `const`. Those are byte-identical in one
 * process and different in the next, which is exactly the shape SH7 cannot tolerate.
 *
 * Not named `*.test.ts`, so `bun test` does not pick it up.
 */
import { readFileSync } from "node:fs";
import { sourceToIR } from "../src/driver.ts";

const path = process.argv[2]!;
process.stdout.write(sourceToIR(readFileSync(path, "utf8"), path));
