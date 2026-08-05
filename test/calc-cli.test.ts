/*
 * CLI calculator (examples/calc-cli.ts) — reads the expression from argv, so it
 * uses the Host I/O differential harness (same args passed to `node` and to our
 * binary). Proves the first real cross-platform CLI app end-to-end.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "calc-cli.ts"), "utf8");

const cases: string[][] = [
  ["2", "+", "3", "*", "4"], // multi-arg -> joined
  ["2 * (3 + 4) - 1"], // single quoted arg
  ["10", "/", "4"], // decimal result
  ["-(2 + 3)"], // unary + parens
  ["100 / 8 / 2"], // left-assoc
  [], // no args -> usage
];

describe("examples/calc-cli.ts (argv-driven)", () => {
  for (const args of cases) {
    test(`args: [${args.join(" ")}]`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
