/*
 * examples/grep.ts — mini-grep, differential vs node (Host I/O FFI).
 *
 * grep reads a substring from process.argv[2] and lines from stdin, printing every
 * matching line prefixed with its 1-based line number (like `grep -n`). The harness
 * feeds identical argv + stdin to `node grep.ts <pattern>` (with the readLine/
 * readStdin polyfill) and to our compiled binary, then asserts stdout + exit code
 * match byte-for-byte.
 *
 * NOTE: readLine() returns "" both for EOF and for a genuinely blank line, so the
 * loop-until-"" idiom cannot see a blank line mid-stream. These cases avoid embedded
 * blank lines (a shared limitation of the readLine EOF sentinel, not of grep).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GREP = join(HERE, "..", "examples", "grep.ts");

interface Case { name: string; io: IOInput; }
const cases: Case[] = [
  // one line matches
  { name: "single match", io: { args: ["foo"], stdin: "foo\nbar\nbaz\n" } },
  // no line matches → empty output
  { name: "no match", io: { args: ["zzz"], stdin: "foo\nbar\nbaz\n" } },
  // several lines match; line numbers count all lines, not just matches
  { name: "multiple matches", io: { args: ["a"], stdin: "alpha\nbeta\ngamma\ndelta\n" } },
  // substring, not whole-line, matching (the "oo" is inside "foobar")
  { name: "substring match", io: { args: ["oo"], stdin: "foo\nbar\nfoobar\n" } },
  // empty stdin → nothing printed, clean exit
  { name: "empty stdin", io: { args: ["foo"], stdin: "" } },
  // no trailing newline on the final line still matches
  { name: "no trailing newline", io: { args: ["z"], stdin: "azb\nqqq\nzed" } },
  // no pattern argument → every line matches
  { name: "empty needle prints all", io: { args: [], stdin: "one\ntwo\nthree\n" } },
];

describe("grep (differential vs node)", () => {
  const source = readFileSync(GREP, "utf8");
  for (const { name, io } of cases) {
    test(`${name} ${JSON.stringify(io)}`, async () => {
      const oracle = runWithNodeIO(source, io);
      const ours = await compileAndRunIO(source, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
