/*
 * Infix calculator (examples/infixcalc.ts) — reads the expression from argv, so
 * it uses the Host I/O differential harness (identical args to `node` and to our
 * binary). Exercises the immutable-array subset end to end: a full shunting-yard
 * pipeline (tokenize -> RPN -> evaluate) where every stack/queue is a `string[]`/
 * `number[]` rebuilt with `[...xs, v]` / `xs.slice(0, ...)` (no `.push`, no
 * `arr[i] = v`). Covers operator precedence, parentheses, and unary minus. Each
 * case must match `node` byte-for-byte; the no-args case runs the hardcoded demo.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "infixcalc.ts"), "utf8");

const cases: string[][] = [
  [], // no args -> hardcoded demo set
  ["3 + 4 * 5"], // precedence: * before + = 23
  ["(3 + 4) * 5"], // parentheses override precedence = 35
  ["-3 + 4"], // leading unary minus = 1
  ["2 * -(1 + 2)"], // unary minus on a parenthesized group = -6
  ["10 / 4 - 1"], // fractional intermediate = 1.5
  ["1 + 2 + 3 + 4 + 5"], // left-assoc chain = 15
  ["2 * 3 + 4 * 5"], // two products then a sum = 26
  ["((1 + 2) * (3 + 4))"], // nested parens = 21
  ["8", "/", "2", "/", "2"], // shell-split tokens (joined) left-assoc = 2
  ["-(-5)"], // stacked unary minus = 5
];

describe("examples/infixcalc.ts (argv-driven shunting-yard calculator)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
