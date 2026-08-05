/*
 * Game of Life example test — compile+run `examples/life.ts` as a real nativets
 * binary and assert its output matches the `node` oracle (and the curated
 * `.expected`). Conway's Life on an immutable `number[][]` board is a stress test
 * for the immutable data model: every generation READS the old grid and builds a
 * brand-new one (spread accumulation), never mutating in place.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "life.ts");

describe("examples/life.ts", () => {
  const source = readFileSync(FILE, "utf8");

  test("matches node (differential)", async () => {
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0);
  });

  test("matches curated expected output", async () => {
    const ep = `${FILE}.expected`;
    if (!existsSync(ep)) return;
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(readFileSync(ep, "utf8"));
    expect(ours.exitCode).toBe(0);
  });
});
