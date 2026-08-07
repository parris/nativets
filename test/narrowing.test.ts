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

/**
 * Assert the source is REFUSED with the given code — and that the message mentions
 * `needle`, so a case meant to prove "this is NOT narrowed" cannot pass by being
 * rejected for some unrelated reason.
 */
function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic(err as NTError);
  expect(text).toContain(code);
  expect(text).toContain(needle);
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
`, "NT2001", "?Unumber");
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
`, "NT2001", "?Unumber");
  });
});

describe("narrowing 2 — a guard whose branch EXITS narrows the rest of the block", () => {
  // TypeScript: conformance/controlFlow/controlFlowIfStatement.ts (function `a`) — the
  // branch that `return`s leaves only the narrowed path for the statements below.
  test("`if (x === undefined) return;` narrows for the rest of the function", async () => {
    await expectNode(`
function f(x: number | undefined): string {
  if (x === undefined) return "none";
  return "n=" + (x + 1);
}
let a: number | undefined = 41;
console.log(f(a));
a = undefined;
console.log(f(a));
`);
  });

  // A `throw` is lexical here (Stage 18), so the handler lives in the same function.
  test("`throw` exits too", async () => {
    await expectNode(`
function len(s: string | null): number {
  try {
    if (s === null) throw "null";
    return s.length;
  } catch (e) {
    return -1;
  }
}
let v: string | null = "abcd";
console.log(len(v));
v = null;
console.log(len(v));
`);
  });

  test("the negated guard exits (`if (x !== undefined) return;` leaves the NULLISH path)", () => {
    // Below such a guard `x` is definitely nullish, NOT narrowed — arithmetic on it
    // must still be refused.
    expectRejected(`
function f(x: number | undefined): number {
  if (x !== undefined) return x;
  return x + 1;
}
`, "NT2001", "?Unumber");
  });

  test("an `else` that exits narrows after the if", async () => {
    await expectNode(`
function f(x: string | undefined): string {
  if (x !== undefined) {
    console.log("have one");
  } else {
    return "none";
  }
  return x.toUpperCase();
}
let s: string | undefined = "hi";
console.log(f(s));
s = undefined;
console.log(f(s));
`);
  });

  test("`continue` exits the iteration, so the rest of the loop body is narrowed", async () => {
    await expectNode(`
const xs = [10, 20, 30];
let total = 0;
for (let i = 0; i < 5; i++) {
  const x = xs.at(i); // number | undefined — undefined past the end
  if (x === undefined) continue;
  total += x;
}
console.log(total);
`);
  });

  test("an assignment below the guard invalidates the narrowing", () => {
    expectRejected(`
function f(x: number | undefined): number {
  if (x === undefined) return 0;
  x = undefined;
  return x + 1;
}
`, "NT2001", "?Unumber");
  });
});

describe("narrowing 3 — the fact persists to the right of `&&`", () => {
  // TypeScript: compiler/narrowingWithNonNullExpression.ts — `m! && m[0]`, where the
  // SECOND `m` is narrowed by the assertion in the first. Its own `''.match('')` needs
  // RegExp, so the case is transposed onto the operand types our `&&` accepts; the
  // shape (assert, then use the bare binding to the right) is the same.
  test("`x! && x` — the assertion narrows the right operand", async () => {
    await expectNode(`
const s: string | undefined = "abc";
console.log(s! && s);
const n: number | undefined = 5;
console.log(n! && n + 1);
`);
  });

  test("an assertion nested in the left operand narrows too", async () => {
    await expectNode(`
const m: string | undefined = "hello";
console.log(m!.length > 0 && m.length > 1);
console.log(m!.length > 99 && m.length > 1);
`);
  });

  test("`x !== undefined && <use>` — the guard narrows the right operand", async () => {
    await expectNode(`
let x: number | undefined = 10;
console.log(x !== undefined && x > 3);
x = 1;
console.log(x !== undefined && x > 3);
x = undefined;
console.log(x !== undefined && x > 3);
`);
  });

  test("`x === undefined || <use>` narrows the right operand (the dual)", async () => {
    await expectNode(`
let x: number | undefined = 10;
console.log(x === undefined || x > 3);
x = 1;
console.log(x === undefined || x > 3);
x = undefined;
console.log(x === undefined || x > 3);
`);
  });

  test("a narrowing guard as an `if` test narrows the body", async () => {
    await expectNode(`
let x: number | undefined = 9;
if (x !== undefined && x > 3) {
  console.log("big", x);
}
`);
  });

  test("a `?:` arm is narrowed by its test", async () => {
    await expectNode(`
let s: string | undefined = "hi";
console.log(s !== undefined ? s.toUpperCase() : "-");
s = undefined;
console.log(s !== undefined ? s.toUpperCase() : "-");
`);
  });

  test("`||` does NOT carry the positive fact to its right operand", () => {
    // The right operand of `||` runs when the left was FALSE, i.e. when `x` IS
    // nullish — narrowing there would be exactly wrong.
    expectRejected(`
function f(x: number | undefined): boolean {
  return x !== undefined || x + 1 > 3;
}
`, "NT2001", "?Unumber");
  });

  // TypeScript: compiler/narrowingPastLastAssignment.ts — narrowings are not preserved
  // into an inner function for a `let` (it may run after a later assignment); a `const`
  // cannot be invalidated, so it is.
  test("a `const` narrowing crosses into a closure; a `let` one does not", async () => {
    await expectNode(`
const c: number | undefined = 4;
if (c !== undefined) {
  const f = () => c + 1;
  console.log(f());
}
`);
    expectRejected(`
let m: number | undefined = 4;
if (m !== undefined) {
  const f = () => m + 1;
  console.log(f());
}
`, "NT2001", "?Unumber");
  });

  test("a name assigned inside ANY arrow is never narrowed", () => {
    expectRejected(`
let x: number | undefined = 1;
const clear = () => { x = undefined; };
if (x !== undefined) {
  clear();
  console.log(x + 1);
}
`, "NT2001", "?Unumber");
  });

  test("`??` does NOT carry a guard fact to its right operand", () => {
    expectRejected(`
let x: number | undefined = 1;
let y: number | undefined = 2;
console.log((y !== undefined ? 1 : 2) ?? (x + 1));
`, "NT2001", "?Unumber");
  });
});

/*
 * narrowing 4 — TRUTHINESS, and the fact carried across a `||` / `&&` CHAIN.
 *
 * Reference cases mined from `microsoft/TypeScript`:
 *   - tests/cases/conformance/controlFlow/controlFlowTruthiness.ts  (function `f1`:
 *     `let x = foo(); if (x) { x /* string *\/ }` — a bare truthiness test narrows
 *     `string | undefined` to `string`)
 *   - tests/cases/conformance/expressions/typeGuards/typeGuardsInRightOperandOfOrOrOperator.ts
 *     (its header states the rule: "In the right operand of a || operation, the type of a
 *     variable or parameter is narrowed by any type guard in the left operand WHEN FALSE,
 *     provided the right operand contains no assignments to the variable". `foo`:
 *     `typeof x !== "string" || x.length === 10`; `foo4`: a three-term chain; `foo2`: an
 *     assignment in the right operand stops the narrowing)
 *   - tests/cases/conformance/expressions/typeGuards/typeGuardsInRightOperandOfAndAndOperator.ts
 *     (the dual, "narrowed by any type guard in the left operand WHEN TRUE")
 *   - tests/cases/compiler/discriminantPropertyCheck.ts  (functions `foo1`/`foo2`:
 *     `x.bar && x.foo !== undefined` then `x.foo.length` — the narrowed thing is a
 *     DOTTED NAME, not a bare identifier)
 *   - tests/cases/conformance/controlFlow/controlFlowBinaryOrExpression.ts and
 *     controlFlowBinaryAndExpression.ts  (the value-returning `a && b` / `a || b` forms)
 *
 * `typeof x === "string"` guards a UNION we do not have, so each borrowed case is
 * transposed onto the nullable (`?U`/`?N`) box, which is the same "prove it, then use it"
 * shape. node erases types entirely, so every case is node-differential.
 */
describe("narrowing 4 — truthiness across `||` and `&&`", () => {
  // TypeScript: controlFlowTruthiness.ts `f1` + typeGuardsInRightOperandOfOrOrOperator.ts
  // `foo` — `!xs` is false exactly where `xs` is present, so the right operand sees it.
  test("`!xs || xs.length === 0` — a nullish array narrows in the right operand", async () => {
    await expectNode(`
function isEmpty(xs: number[] | undefined): boolean {
  return !xs || xs.length === 0;
}
const none: number[] = [];
let a: number[] | undefined = [1, 2, 3];
console.log(isEmpty(a));
a = none;
console.log(isEmpty(a));
a = undefined;
console.log(isEmpty(a));
`);
  });

  // TypeScript: typeGuardsInRightOperandOfAndAndOperator.ts `foo` — the dual rule, and
  // discriminantPropertyCheck.ts `foo2` for the object receiver.
  test("`!!o && o.a > 0` — a nullish object narrows in the right operand", async () => {
    await expectNode(`
function hasPositive(o: { a: number } | undefined): boolean {
  return !!o && o.a > 0;
}
let o: { a: number } | undefined = { a: 7 };
console.log(hasPositive(o));
o = { a: -1 };
console.log(hasPositive(o));
o = undefined;
console.log(hasPositive(o));
`);
  });

  // TypeScript: compiler/discriminantPropertyCheck.ts (`foo1`: `x.bar && x.foo !== undefined`
  // then `x.foo.length`) — the narrowed thing is a DOTTED NAME. This is the exact shape
  // `src/diagnostics.ts` (`formatDiagnostic`) is written in, so it is also the
  // self-hosting case.
  test("a dotted name narrows: `!d.spans || d.spans.length === 0`", async () => {
    await expectNode(`
function isEmpty(d: { spans: number[] | undefined }): boolean {
  return !d.spans || d.spans.length === 0;
}
const some: { spans: number[] | undefined } = { spans: [1, 2] };
const empty: number[] = [];
const zero: { spans: number[] | undefined } = { spans: empty };
const none: { spans: number[] | undefined } = { spans: undefined };
console.log(isEmpty(some));
console.log(isEmpty(zero));
console.log(isEmpty(none));
`);
  });

  // TypeScript: typeGuardsInRightOperandOfOrOrOperator.ts `foo4` — a chain of three
  // guards, where each term is narrowed by EVERY term to its left. Written as
  // `src/diagnostics.ts`'s own `formatDiagnostic` guard, which is the case that blocks
  // self-hosting: `if (!diag.spans || diag.spans.length === 0 || !source) return …`,
  // then both `diag.spans` and `source` are narrowed below the guard.
  test("a three-term `||` chain composes left to right, and narrows past the guard", async () => {
    await expectNode(`
function render(d: { spans: number[] | undefined }, source: string | undefined): string {
  if (!d.spans || d.spans.length === 0 || !source) {
    return "compact";
  }
  return source.toUpperCase() + "/" + d.spans.length;
}
const some: { spans: number[] | undefined } = { spans: [1, 2] };
const empty: number[] = [];
const zero: { spans: number[] | undefined } = { spans: empty };
const none: { spans: number[] | undefined } = { spans: undefined };
const src: string | undefined = "abc";
const nosrc: string | undefined = undefined;
console.log(render(some, src));
console.log(render(some, nosrc));
console.log(render(zero, src));
console.log(render(none, src));
`);
  });
});

/*
 * narrowing 5 — the refusal itself.
 *
 * When narrowing legitimately does NOT apply, NT2001 has to be findable. Two defects made
 * it the opposite: `typeError` attached no span, so the diagnostic had no location at all;
 * and the message read the object's `.name`, which only exists on an Identifier, so every
 * dotted receiver was reported as the fabricated word `value` — a name that appears
 * nowhere in the program.
 */
describe("narrowing 5 — an un-narrowed read says WHAT and WHERE", () => {
  test("the message names the dotted path and carries its line:col", () => {
    const source = `
function f(d: { spans: number[] | undefined }): number {
  return d.spans.length;
}
const d: { spans: number[] | undefined } = { spans: undefined };
console.log(f(d));
`;
    let err: unknown;
    try { sourceToIR(source); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    const diag = (err as NTError).diag;
    expect(diag.code).toBe("NT2001");
    // `d.spans`, not `value` — and the `.` of the offending `.length` read.
    expect(diag.message).toBe("'d.spans' is possibly undefined at 3:17");
    expect(diag.hint).toContain("?.");
    expect(diag.spans).toEqual([{ line: 3, label: "this read is not proved non-nullish", primary: true }]);
    // With the source in hand it renders rustc-style, pointing at the actual line.
    expect(formatDiagnostic(diag, source)).toContain("return d.spans.length;");
  });
});
