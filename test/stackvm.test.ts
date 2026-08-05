/*
 * Tiny stack-based bytecode VM (examples/stackvm.ts).
 *
 * Exercises the immutable-data subset end to end: the operand stack is a `number[]`
 * that is NEVER mutated in place — push is `[...stack, v]`, pop is
 * `stack.slice(0, stack.length - 1)`. The program counter is a plain mutable
 * `number` local. Instructions come from `program.split(" ")`, operands via
 * `parseFloat`, output accumulated with string `+=`. Three hardcoded demo
 * programs (arithmetic expression, DUP/SWAP, and a JMP/JZ loop computing
 * factorial(5)) — every one must match the `node` oracle byte-for-byte, and the
 * curated `.expected` snapshot.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "stackvm.ts"), "utf8");
const expected = readFileSync(
  join(HERE, "..", "examples", "stackvm.ts.expected"),
  "utf8",
);

describe("examples/stackvm.ts", () => {
  test("hardcoded demos match node (differential)", async () => {
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0);
  });

  test("output matches the curated .expected snapshot", async () => {
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(expected);
    // Sanity: the three computed results are actually present.
    expect(ours.stdout).toContain("29"); // (3+4)*5-6
    expect(ours.stdout).toContain("-18"); // swap/sub
    expect(ours.stdout).toContain("120"); // factorial(5)
  });
});
