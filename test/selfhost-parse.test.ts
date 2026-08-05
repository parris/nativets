/*
 * Self-hosting — the `NT0001` parse tail.
 *
 * After Stage 36 cleared `NT1013`, the top blocker in `nativets coverage src/*.ts`
 * was `NT0001` ("unparsed statement") ×11 — which is not one feature but a handful
 * of small, concrete gaps, each extracted from a real statement in the compiler's
 * own source:
 *
 *   1. `(expr as T)` in a ternary arm misread as an arrow parameter list  (`ast.ts`)
 *   2. nested template literals — a `` ` `` inside a `${…}` substitution   (`ast.ts`, `codegen.ts`)
 *   3. hex / binary / octal numeric literals (`0x22`)                      (`codegen.ts`)
 *   4. postfix `++`/`--` on a member or index target (`this.pos++`)        (`parser.ts`, `coverage.ts`)
 *   5. `instanceof`                                                        (`cli.ts`)
 *   6. binding patterns in parameters (`([k, v]) => …`)                    (`ownership.ts`)
 *   7. a parenthesized type (`(() => Scope) | null`)                       (`checker.ts`)
 *
 * Each fixture below is an ordinary node-runnable program built from the real
 * statement that failed, so node stays the oracle. Kept out of `test/fixtures/**`
 * so no IR snapshot is minted — differential + curated-expected is the gate.
 *
 * Constructs we deliberately do NOT support get a precise NT code instead of a
 * guess; those are asserted in the rejection block at the bottom.
 */

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "selfhost-parse");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("NT0001 burn-down (parse + run, differential vs node)", () => {
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

describe("what parses is not what is ALLOWED — precise codes, never a guess", () => {
  test("`o.f++` on an immutable object is NT1606, like `o.f = v`", () => {
    expect(codeOf(`const o = { count: 1 }; o.count++; console.log(o.count);`)).toBe("NT1606");
    expect(codeOf(`const o = { count: 1 }; ++o.count; console.log(o.count);`)).toBe("NT1606");
    // Same verdict as the plain assignment it desugars to — consistency is the point.
    expect(codeOf(`const o = { count: 1 }; o.count = 2;`)).toBe("NT1606");
  });

  test("`this.f++` in a METHOD is NT1606 too (only the constructor may write fields)", () => {
    const src = `class C {\n  private n = 0;\n  bump(): number { this.n++; return this.n; }\n}\nconsole.log(new C().bump());\n`;
    expect(codeOf(src)).toBe("NT1606");
  });

  test("`arr[i]++` on an immutable array is NT1606, like `arr[i] = v`", () => {
    expect(codeOf(`const a: number[] = [1, 2]; a[0]++;`)).toBe("NT1606");
    expect(codeOf(`const a: number[] = [1, 2]; a[0] = 9;`)).toBe("NT1606");
  });

  test("`instanceof Error` is NT1021 — nativets models Error structurally, so it cannot decide", () => {
    // `new Error(m)` IS `{message:string}` here (Stage 18), so an Error and a plain
    // record carrying a `message` are the same static type. Answering would be a guess.
    expect(codeOf(`const e = new Error("x"); console.log(e instanceof Error);`)).toBe("NT1021");
    // The suggested discriminant check does compile.
    expect(codeOf(`class E { code: string; constructor(c: string) { this.code = c; } }\nconst e = new E("NT1"); console.log(e.code === "NT1");`)).toBe(null);
  });

  test("`delete o.k` is NT1606 — it is a mutation, named as one instead of 'unparsed'", () => {
    // src/checker.ts's `delete spec.typeParams`. Objects are immutable (Stage 29), so
    // removing a key in place cannot mean what node means; the hint is the rebuild.
    expect(codeOf(`const o = { a: 1, b: 2 }; delete o.a; console.log(o.b);`)).toBe("NT1606");
    expect(codeOf(`const o = { a: 1, b: 2 }; delete o["a"]; console.log(o.b);`)).toBe("NT1606");
  });

  test("`instanceof` against a non-class / computed right operand is NT1021, not a guess", () => {
    expect(codeOf(`const x = 1; console.log(x instanceof Object);`)).toBe("NT1021");
    expect(codeOf(`const x = 1; const C = 2; console.log(x instanceof 3);`)).toBe("NT1021");
    expect(codeOf(`const x = 1; console.log(x instanceof Function);`)).toBe("NT1021");
  });
});
