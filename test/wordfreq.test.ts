/*
 * examples/wordfreq.ts — a word-frequency counter (Host I/O tier).
 *
 * Differential vs node: the SAME stdin is fed to `node wordfreq.ts` (with the
 * harness's readStdin polyfill) and to our compiled binary; stdout + exit code
 * must match byte-for-byte. Exercises the immutable subset over Host I/O stdin,
 * leaning on the generic `Map<string, number>` for counting.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "examples", "wordfreq.ts"), "utf8");
const EXPECTED = readFileSync(join(HERE, "..", "examples", "wordfreq.ts.expected"), "utf8");

const cases: { name: string; io: IOInput }[] = [
  { name: "empty stdin → default paragraph", io: { stdin: "" } },
  { name: "only whitespace → default paragraph", io: { stdin: "  \n\t \n" } },
  { name: "single word", io: { stdin: "hello" } },
  { name: "repeated word, mixed case", io: { stdin: "The cat the DOG the, cat!" } },
  { name: "punctuation and digits as separators/words", io: { stdin: "a1 a1 b2, b2. a1; c3-c3 c3" } },
  { name: "count-tie broken alphabetically", io: { stdin: "banana apple cherry apple banana cherry" } },
  { name: "fewer distinct words than TOP_N", io: { stdin: "one two two three three three" } },
  { name: "more distinct words than TOP_N", io: { stdin: "g f e d c b a a b c d e f g x" } },
  { name: "newlines and tabs as separators", io: { stdin: "alpha\tbeta\nalpha  beta\tgamma\n" } },
  { name: "leading/trailing separators", io: { stdin: "  ...foo, bar; foo...  " } },
];

describe("examples/wordfreq.ts (differential vs node)", () => {
  for (const { name, io } of cases) {
    test(name, async () => {
      const oracle = runWithNodeIO(SOURCE, io);
      const ours = await compileAndRunIO(SOURCE, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  test("default run matches the curated .expected file", async () => {
    const ours = await compileAndRunIO(SOURCE, { stdin: "" });
    expect(ours.stdout).toBe(EXPECTED);
    expect(ours.exitCode).toBe(0);
  });
});
