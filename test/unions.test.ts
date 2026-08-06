/*
 * SH2 — discriminated (tagged) union types.
 *
 * `docs/self-hosting.md` calls this "the crux" of self-hosting: nativets' own AST
 * (`src/ast.ts` `Expr` / `Stmt`) IS a discriminated union, matched by
 * `switch (node.kind)`. Before this lane the ONLY unions the compiler accepted were
 * the two nullable shapes (`T | undefined`, `T | null`); everything else was NT1009.
 *
 * REPRESENTATION (see `src/ast.ts` — `isUnionTy`): a discriminated union value is
 * just the MEMBER OBJECT POINTER. There is no box: the tag already lives in the
 * value, as the discriminant field, and the union is only accepted when that field
 * sits at the SAME slot index in every member. So `s.kind` on an un-narrowed union
 * is an ordinary slot load, narrowing is a pure retype (zero runtime cost), and
 * every object mechanism — literals, slots, drop — is reused unchanged.
 *
 * node erases types, so every case here runs under plain `node` and node stays the
 * byte-for-byte oracle. Cases are borrowed from the TypeScript conformance suite;
 * each fixture cites the file it came from.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "unions");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("discriminated unions (differential vs node)", () => {
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

/** Compile-only; returns the NT diagnostic code (or null when it compiles). */
function codeOf(source: string): string | null {
  try { sourceToIR(source); return null; }
  catch (e) { return e instanceof NTError ? e.diag.code : "NT9001"; }
}
