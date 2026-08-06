/*
 * Control-flow narrowing of nullable BINDINGS (A2 follow-on).
 *
 * `expr!` already narrowed the EXPRESSION (`src/codegen.ts`, `NonNullExpr`) — it
 * unwraps the tagged pair right there. What was missing is narrowing the BINDING:
 * having proved on this path that `x` is not nullish, every LATER read of `x` on
 * that path should see the base type, not the `?U`/`?N` box.
 *
 * Reference cases mined from `microsoft/TypeScript`:
 *   - tests/cases/conformance/expressions/typeGuards/nullOrUndefinedTypeGuardIsOrderIndependent.ts
 *     (`if (undefined !== strOrUndefined)`, `if (null === strOrNull)`, both operand orders)
 *   - tests/cases/conformance/controlFlow/controlFlowIfStatement.ts  (function `a`:
 *     a branch that `return`s narrows the binding for the REST of the block)
 *   - tests/cases/compiler/narrowingWithNonNullExpression.ts  (`m! && m[0]` — the
 *     assertion narrows `m` for the rest of the expression)
 *   - tests/cases/compiler/narrowingPastLastAssignment.ts  (a narrowing is invalidated
 *     by an assignment; not preserved into inner function declarations)
 *
 * node erases the type layer entirely, so every case here is node-differential:
 * node IS the oracle for what the program means.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Assert the source is REFUSED, with the given diagnostic code. */
function expectRejected(source: string, code: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  expect(formatDiagnostic(err as NTError)).toContain(code);
}

describe("narrowing 1 — `if (x !== undefined)` / `!== null`", () => {
  // TypeScript: conformance/expressions/typeGuards/nullOrUndefinedTypeGuardIsOrderIndependent.ts
  test("`!== undefined` narrows the binding inside the consequent", async () => {
    await expectNode(`
let x: number | undefined = 41;
if (x !== undefined) {
  console.log(x + 1);
}
x = undefined;
if (x !== undefined) {
  console.log(x + 1);
} else {
  console.log("none");
}
`);
  });

  test("`!== null` narrows a `T | null` binding", async () => {
    await expectNode(`
let s: string | null = "abc";
if (s !== null) {
  console.log(s.length, s.toUpperCase());
}
s = null;
if (s !== null) {
  console.log(s.length);
} else {
  console.log("nothing");
}
`);
  });

  // The reference test asserts BOTH operand orders narrow ("order independent").
  test("the yoda order (`undefined !== x`) narrows too", async () => {
    await expectNode(`
let x: number | undefined = 7;
if (undefined !== x) {
  console.log(x * 2);
}
let s: string | null = "hi";
if (null === s) {
  console.log("null");
} else {
  console.log(s + "!");
}
`);
  });

  test("`===` narrows the ELSE branch", async () => {
    await expectNode(`
let x: number | undefined = 5;
if (x === undefined) {
  console.log("none");
} else {
  console.log(x - 1);
}
`);
  });

  test("the narrowing does NOT leak past the if", async () => {
    // Outside the consequent `x` is still `number | undefined`, so arithmetic on it
    // must still be refused — narrowing is a per-path fact, not a retype.
    expectRejected(`
let x: number | undefined = 1;
if (x !== undefined) { console.log(x + 1); }
console.log(x + 1);
`, "NT2001");
  });

  test("an object binding narrows for field access", async () => {
    await expectNode(`
let o: { a: number, b: string } | undefined = { a: 1, b: "z" };
if (o !== undefined) {
  console.log(o.a, o.b);
}
`);
  });

  // TypeScript: compiler/narrowingPastLastAssignment.ts — a narrowing is invalidated
  // by an assignment to the same binding.
  test("an assignment inside the region invalidates the narrowing", () => {
    expectRejected(`
let x: number | undefined = 1;
if (x !== undefined) {
  x = undefined;
  console.log(x + 1);
}
`, "NT2001");
  });
});
