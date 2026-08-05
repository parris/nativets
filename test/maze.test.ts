/*
 * Maze BFS example test — compile+run `examples/maze.ts` as a real nativets
 * binary and assert its output matches the `node` oracle (and the curated
 * `.expected`). Breadth-first shortest-path search is a stress test for the
 * immutable data model: the BFS QUEUE is a `number[]` grown by spread (never
 * `.push`) with a moving `head` index, and visited/distance/parent state are
 * PERSISTENT Map/Set keyed by `"r,c"` (each `.add`/`.set` returns a new handle).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "examples", "maze.ts");

describe("examples/maze.ts", () => {
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
