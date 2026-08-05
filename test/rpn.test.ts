/*
 * RPN calculator (examples/rpn.ts) — reads the expression from argv, so it uses
 * the Host I/O differential harness (identical args to `node` and to our binary).
 * Exercises the immutable-array subset end to end: the stack is a `number[]`
 * rebuilt with `[...stack, v]` / `stack.slice(0, ...)`, tokens come from
 * `process.argv.slice(2)` (or a single string `.split(" ")`), evaluated with
 * `parseFloat` + `+ - * /`. Every case must match `node` byte-for-byte.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "rpn.ts"), "utf8");

const cases: string[][] = [
  [], // no args -> hardcoded default (3 4 + 5 *) = 35
  ["3", "4", "+", "5", "*"], // pre-split tokens = 35
  ["3 4 + 5 *"], // single string -> split(" ") = 35
  ["10", "2", "/", "3", "-"], // division then subtraction = 2
  ["2", "3", "4", "*", "+"], // nested = 14
  ["7", "2", "/"], // fractional result = 3.5
  ["1.5 2.5 +"], // decimal operands (single string) = 4
  ["100", "5", "-", "2", "/"], // = 47.5
  ["6", "2", "-", "3", "*"], // = 12
];

describe("examples/rpn.ts (argv-driven RPN)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
