/*
 * `\xHH` hex string escapes — needed so ANSI escape sequences (ESC = \x1b) can be
 * written as ordinary string literals for the TUI (docs/examples.md C-c). node
 * supports \xHH natively, so it stays the oracle. Differential via inline source
 * (not a test/fixtures/ case, to avoid touching IR snapshots).
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

const cases: string[] = [
  // ESC + "[K" (erase-to-end-of-line) — the core TUI redraw sequence. Print its
  // char codes so the comparison doesn't depend on the terminal interpreting it.
  'const s: string = "\\x1b[K"; console.log(s.length); console.log("" + (s.charAt(0) === "\\x1b"));',
  // A red "hi" via SGR, then reset — length is stable regardless of rendering.
  'console.log("\\x1b[31mhi\\x1b[0m".length);',
  // Mixed known escapes + hex; \x41 === "A".
  'console.log("a\\x41b\\tc".length); console.log("\\x41");',
];

describe("\\xHH hex escapes (differential vs node)", () => {
  for (const src of cases) {
    test(src.slice(0, 40), async () => {
      const oracle = runWithNode(src);
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
