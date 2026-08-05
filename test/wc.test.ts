/*
 * examples/wc.ts — a `wc`-like tool (lines / words / chars from stdin).
 *
 * Differential vs node: the SAME stdin is fed to `node wc.ts` (with the harness's
 * readStdin polyfill) and to our compiled binary; stdout + exit code must match
 * byte-for-byte. Exercises the immutable subset over Host I/O stdin.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "examples", "wc.ts"), "utf8");

const cases: { name: string; io: IOInput }[] = [
  { name: "empty stdin", io: { stdin: "" } },
  { name: "one line, no trailing newline", io: { stdin: "hello world" } },
  { name: "one line, trailing newline", io: { stdin: "hello world\n" } },
  { name: "multi-line with trailing newline", io: { stdin: "one two\nthree\nfour five six\n" } },
  { name: "multi-line without trailing newline", io: { stdin: "one\ntwo\nthree\nfour" } },
  { name: "leading/trailing/dup whitespace + tabs", io: { stdin: "  alpha\t beta \n\n  gamma  \n" } },
  { name: "only whitespace", io: { stdin: "   \n\t\n  " } },
  { name: "blank lines between words", io: { stdin: "a\n\n\nb\n" } },
];

describe("examples/wc.ts (differential vs node)", () => {
  for (const { name, io } of cases) {
    test(name, async () => {
      const oracle = runWithNodeIO(SOURCE, io);
      const ours = await compileAndRunIO(SOURCE, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
