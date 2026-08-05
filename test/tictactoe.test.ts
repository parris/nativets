/*
 * Tic-tac-toe minimax example test — compile+run `examples/tictactoe.ts` as a
 * real nativets binary and assert its output matches the `node` oracle (and the
 * curated `.expected`). Minimax over an immutable `string[]` board is a stress
 * test for the immutable data model + recursion: every trial move builds a
 * brand-new board with `board.with(i, mark)` (copy-on-write) and recurses, never
 * mutating in place. The search is deterministic (fixed position + fixed
 * self-play game, ties broken by lowest index), so it is fully node-differential.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "tictactoe.ts");

describe("examples/tictactoe.ts", () => {
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
