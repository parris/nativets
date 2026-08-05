/*
 * Brainfuck interpreter (examples/brainfuck.ts) — a persistent-array stress test.
 *
 * The interpreter tape is written EXCLUSIVELY through `tape.with(p, v)` (immutable
 * ES2023 update), so the whole run is one long chain of persistent array updates in
 * the current immutable-data subset. We assert our native binary matches the `node`
 * oracle byte-for-byte: for the hardcoded demos (no argv) AND for Brainfuck programs
 * supplied on the command line (Host I/O harness — same argv to `node` and to ours).
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileAndRun,
  runWithNode,
  compileAndRunIO,
  runWithNodeIO,
} from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "..", "examples", "brainfuck.ts"), "utf8");

// Canonical "Hello World!" — the classic differential fixture for any BF interpreter.
const HELLO =
  "++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.";

// A short program exercising a multiply loop + several `.` outputs ("Hi!\n").
const HI =
  "++++++++[>+++++++++<-]>.+++++++++++++++++++++++++++++++++.------------------------------------------------------------------------.-----------------------.";

describe("examples/brainfuck.ts", () => {
  test("hardcoded demos match node (differential)", async () => {
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0);
    // Sanity: the canonical greeting is actually in there.
    expect(ours.stdout).toContain("Hello World!");
  });

  const programs: { name: string; args: string[] }[] = [
    { name: "Hello World! via argv", args: [HELLO] },
    { name: "Hi! via argv", args: [HI] },
    // Nested loops + pointer walk (a small "count/echo" fragment) — echoes 'A'..'C'.
    { name: "alphabet fragment", args: ["++++++[>++++++++++<-]>+++++.+.+."] },
  ];

  for (const { name, args } of programs) {
    test(`argv program matches node (differential): ${name}`, async () => {
      const oracle = runWithNodeIO(source, { args });
      const ours = await compileAndRunIO(source, { args });
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
      expect(ours.exitCode).toBe(0);
    });
  }
});
