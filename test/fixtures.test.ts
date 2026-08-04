/*
 * Fixture tests — for every .ts under test/fixtures/**, assert all test types:
 *   1. Differential vs node   2. Curated .expected   3. IR snapshot
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { emitIR, compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

const files = collect(ROOT);

describe("fixtures", () => {
  for (const file of files) {
    const name = relative(ROOT, file);
    const source = readFileSync(file, "utf8");

    describe(name, () => {
      test("matches node (differential)", async () => {
        const oracle = runWithNode(source);
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });

      test("matches curated expected output", async () => {
        const ep = `${file}.expected`;
        if (!existsSync(ep)) return;
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(readFileSync(ep, "utf8"));
        expect(ours.exitCode).toBe(0);
      });

      test("emits stable LLVM IR (snapshot)", () => {
        expect(emitIR(source)).toMatchSnapshot();
      });
    });
  }
});
