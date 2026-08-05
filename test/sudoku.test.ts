/*
 * Sudoku example test — compile+run `examples/sudoku.ts` as a real nativets
 * binary and assert its output matches the `node` oracle (and the curated
 * `.expected`). Recursive backtracking over an IMMUTABLE `number[][]` board is a
 * heavy stress test for the immutable data model: placing a digit builds a
 * brand-new board with nested ES2023 `.with` (`board.with(r, board[r].with(c,
 * d))`), and failed branches are simply dropped while the parent board stays
 * intact — exactly the shape backtracking wants.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "sudoku.ts");

describe("examples/sudoku.ts", () => {
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
