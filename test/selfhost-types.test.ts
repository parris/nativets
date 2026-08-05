/*
 * Self-hosting SH2 — type-level surface that PARSES + ERASES.
 *
 * The compiler's own source leans on type-level constructs that carry no runtime:
 * `type`/`interface` aliases, string-literal-union types, optional params (`x?: T`),
 * array-destructure elision holes, and inline `import("m").T` type refs. Teaching the
 * real parser to accept and erase these shrinks the self-host blocker histogram's
 * NT0001 bucket (measured separately via `coverage src/*.ts`).
 *
 * These are ordinary programs that exercise each construct at runtime where it is
 * observable (a string-literal-union value, an omitted optional param, a destructured
 * hole) or purely compile-time where it is not (a `type`/`interface` used in an
 * annotation). node stays the oracle. Kept out of `test/fixtures/**` so no IR snapshot
 * is minted — the differential + curated-expected checks are the correctness gate.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "selfhost-types");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("SH2 type-level erasure (parse + run, differential vs node)", () => {
  for (const name of files) {
    const source = readFileSync(join(DIR, name), "utf8");
    describe(name, () => {
      test("matches node (differential)", async () => {
        const oracle = runWithNode(source);
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(oracle.stdout);
        expect(ours.exitCode).toBe(oracle.exitCode);
      });

      test("matches curated expected output", async () => {
        const expected = readFileSync(join(DIR, `${name}.expected`), "utf8");
        const ours = await compileAndRun(source);
        expect(ours.stdout).toBe(expected);
        expect(ours.exitCode).toBe(0);
      });
    });
  }
});
