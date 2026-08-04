/*
 * Ownership test harness — modeled on rustc's `compiletest` UI tests.
 *
 *   //@ check-pass         → the move checker must ACCEPT (zero diagnostics)
 *   //~ ERROR NT1601       → a diagnostic with that code must occur ON THIS LINE,
 *                            and there must be no unexpected diagnostics.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ownershipCheck } from "../src/driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "ownership");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("ownership (linear move checker)", () => {
  for (const file of files) {
    const src = readFileSync(join(DIR, file), "utf8");
    const checkPass = /\/\/@\s*check-pass/.test(src);
    const expected: { line: number; code: string }[] = [];
    src.split("\n").forEach((l, i) => {
      const m = l.match(/\/\/~\s*ERROR\s+(NT\d+)/);
      if (m) expected.push({ line: i + 1, code: m[1]! });
    });

    test(file, () => {
      const diags = ownershipCheck(src);
      if (checkPass) {
        expect(diags).toEqual([]);
        return;
      }
      for (const e of expected) {
        const hits = diags.filter((d) => d.line === e.line && d.code === e.code);
        expect(hits.length, `expected ${e.code} on line ${e.line} of ${file}; got ${JSON.stringify(diags)}`).toBeGreaterThan(0);
      }
      // no unexpected diagnostics
      expect(diags.length).toBe(expected.length);
    });
  }
});
