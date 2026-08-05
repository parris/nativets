/*
 * Example-app tests — compile+run each program under `examples/` as a real
 * nativets binary and assert its output matches the `node` oracle (and, when
 * present, the curated `.expected`). These are dogfood apps written in the
 * supported subset (docs/examples.md), so they double as end-to-end coverage.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "examples");

const programs = ["calculator.ts"];

describe("examples", () => {
  for (const name of programs) {
    const file = join(EXAMPLES, name);
    const source = readFileSync(file, "utf8");

    describe(name, () => {
      test("matches node (differential)", async () => {
        const oracle = runWithNode(source);
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
        expect(ours.exitCode).toBe(0);
      });

      test("matches curated expected output", async () => {
        const ep = `${file}.expected`;
        if (!existsSync(ep)) return;
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(readFileSync(ep, "utf8"));
        expect(ours.exitCode).toBe(0);
      });
    });
  }
});
