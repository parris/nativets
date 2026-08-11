/*
 * WHERE THE RESOLVED RETURN TYPE COMES FROM — every path, in one differential program.
 *
 * `FuncDecl.returnTy` used to be a second copy of `Sig.ret`, written onto the AST node in
 * place at four sites (two in `check`, two in `monomorphize`). Each write is `NT1606` when
 * this compiler checks its own source — records are immutable since Stage 29 — and the
 * two in `check` were the LINKED first blocker of checker.ts, codegen.ts and ownership.ts.
 * The field is gone: `Checker.checkFunction` and codegen's `genFunction` read `Sig.ret`
 * from the signature table, which both already had in hand at the point they read it.
 *
 * That deletion is only safe if `Sig.ret` agrees with the old `fn.returnTy ?? "number"` on
 * EVERY path that produced one, and nothing pinned that — the field was written in four
 * places and read in three, with no test naming the correspondence. The paths:
 *
 *   1. an ANNOTATED top-level function          `check` pass 1
 *   2. an UNANNOTATED top-level function        `check` pass 2 (return-type inference)
 *   3. an ANNOTATED generic specialization      `monomorphize`, provisional sig
 *   4. an UNANNOTATED generic specialization    `monomorphize`, sig replaced after inference
 *   5. an unannotated function returning a CLOSURE — the case pass 2 exists for
 *   6. class METHODS, annotated and not (they are `FuncDecl`s named `C.m`)
 *   7. SELF-RECURSION through an unannotated generic — the one place the provisional
 *      `ret` is observable, because the recursive call resolves through the table while
 *      inference is still running
 *
 * A wrong answer here is not a compile error: it is a function emitted with the wrong LLVM
 * return type, so node is the oracle and the exit code is half the assertion.
 */

import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNode } from "./harness.ts";

const PROGRAM = `
function annotated(a: number, b: number): string {
  return \`\${a + b}\`;
}

function inferred(a: number) {
  return a * 2;
}

function identity<T>(x: T): T {
  return x;
}

function pairUp<T>(x: T) {
  return [x, x];
}

function makeAdder(n: number) {
  return (x: number) => x + n;
}

function countdown<T>(xs: T[], i: number) {
  if (i <= 0) return 0;
  return 1 + countdown(xs, i - 1);
}

class Acc {
  total: number;
  constructor(total: number) { this.total = total; }
  plusAnnotated(n: number): number { return this.total + n; }
  plusInferred(n: number) { return this.total + n; }
}

const add5 = makeAdder(5);
const a = new Acc(10);

console.log(annotated(1, 2));
console.log(inferred(21));
console.log(identity<string>("id"), identity<number>(7));
console.log(pairUp<number>(3).join(","), pairUp<string>("s").join(","));
console.log(add5(2));
console.log(countdown<number>([1, 2, 3], 4));
console.log(a.plusAnnotated(1), a.plusInferred(2));
`;

describe("the resolved return type has ONE home (Sig.ret)", () => {
  test("all seven paths match node, stdout and exit code", async () => {
    const oracle = runWithNode(PROGRAM);
    const ours = await compileAndRun(PROGRAM);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    // The oracle itself must have run — an empty match is not a match.
    expect(oracle.exitCode).toBe(0);
    expect(oracle.stdout.split("\n").filter((l) => l.length > 0).length).toBe(7);
  });

  // A string return is the one that actually distinguishes `Sig.ret` from the old
  // `fn.returnTy ?? "number"` fallback: get it wrong and the function is emitted with a
  // `double` return type around a `ptr`, which clang either rejects or miscompiles.
  test("an unannotated function returning a STRING is not defaulted to number", async () => {
    const src = `
function greet(who: string) {
  return \`hello \${who}\`;
}
console.log(greet("world").length, greet("world"));
`;
    const oracle = runWithNode(src);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.stdout).toBe("11 hello world\n");
  });
});
