/*
 * examples/markdown.ts — a tiny Markdown → HTML converter (stdin → HTML).
 *
 * Differential vs node: the SAME Markdown is fed to `node markdown.ts` (with the
 * harness's readStdin polyfill) and to our compiled binary; stdout + exit code
 * must match byte-for-byte. Exercises the immutable subset (string slicing,
 * recursion, `String#slice`/`indexOf`/`charAt`/`split`) over Host I/O stdin.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "examples", "markdown.ts"), "utf8");

const cases: { name: string; io: IOInput }[] = [
  { name: "empty stdin → hardcoded demo doc", io: { stdin: "" } },
  { name: "single h1 heading", io: { stdin: "# Title\n" } },
  { name: "all three heading levels", io: { stdin: "# One\n## Two\n### Three\n" } },
  { name: "simple paragraph", io: { stdin: "just some text\n" } },
  {
    name: "wrapped paragraph lines join with a space",
    io: { stdin: "line one\nline two\nline three\n" },
  },
  { name: "two paragraphs separated by a blank line", io: { stdin: "first para\n\nsecond para\n" } },
  { name: "bullet list", io: { stdin: "- apple\n- banana\n- cherry\n" } },
  {
    name: "list then paragraph then list",
    io: { stdin: "- a\n- b\n\ntext between\n\n- c\n" },
  },
  { name: "inline bold, italic, and code", io: { stdin: "a **bold** and *italic* and `code` word\n" } },
  { name: "nested italic inside bold", io: { stdin: "**bold with *italic* inside**\n" } },
  { name: "html special chars are escaped", io: { stdin: "1 < 2 && 3 > 2 & done\n" } },
  { name: "code span keeps literal chars, escaped", io: { stdin: "use `a < b && c` here\n" } },
  { name: "unclosed delimiters are literal", io: { stdin: "a * b and ** c and ` d\n" } },
  { name: "heading with inline formatting", io: { stdin: "## The **big** `news`\n" } },
  {
    name: "mixed document",
    io: {
      stdin:
        "# nativets\n\nA **memory-safe** compiler.\n\n## Goals\n\n- fast `native` binaries\n- *tiny* output\n\nThe end.\n",
    },
  },
  { name: "no trailing newline", io: { stdin: "# No newline at EOF" } },
];

describe("examples/markdown.ts (differential vs node)", () => {
  for (const { name, io } of cases) {
    test(name, async () => {
      const oracle = runWithNodeIO(SOURCE, io);
      const ours = await compileAndRunIO(SOURCE, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
