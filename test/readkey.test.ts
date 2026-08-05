/*
 * readKey / rawMode — the raw single-key input primitive (docs/examples.md C-c).
 *
 * readKey() returns the next single keypress ("" at EOF). rawMode(on) toggles the
 * terminal in/out of non-canonical, no-echo mode (termios). When stdin is NOT a
 * tty (piped, as in these tests) rawMode is a graceful no-op and readKey degrades
 * to a byte-at-a-time read of the shared stdin buffer — so a piped keystroke
 * script is deterministic and differential-testable against node (which gets
 * readKey/rawMode via the harness polyfill prelude).
 *
 * Lives OUTSIDE test/fixtures/ on purpose: the generic fixtures harness runs every
 * case with no stdin, which is wrong for a program that reads keys.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRunIO, runWithNodeIO, type IOInput } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "hostio", "read-keys.ts"), "utf8");

const inputs: IOInput[] = [
  { stdin: "ab\n" }, // three keys: 'a', 'b', '\n'
  { stdin: "" }, // EOF immediately → just "done"
  { stdin: "2+3=q" }, // a calculator-ish keystroke script (no trailing newline)
  { stdin: "(1.5)" }, // punctuation keys
];

describe("readKey / rawMode (piped-stdin differential vs node)", () => {
  for (const io of inputs) {
    test(`stdin: ${JSON.stringify(io.stdin)}`, async () => {
      const oracle = runWithNodeIO(source, io);
      const ours = await compileAndRunIO(source, io);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
