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
  // `.diag`, NOT the NTError. `formatDiagnostic` takes a `Diagnostic`; handed the
  // error it renders `error[undefined]: …` and SILENTLY DROPS THE HINT. The code
  // assertion below passed anyway, purely because `NTError.message` happens to embed
  // `[NT1031]` — so this helper looked healthy while it could never have checked a
  // hint. Every other test file already spells it `.diag`; this was the one holdout.
  const text = formatDiagnostic((err as NTError).diag);
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

  // The original of this case wrote `x` from an ARROW. That program is now refused
  // EARLIER, by NT1029: a closure cannot write a binding anything outside it still uses,
  // because our captures are by value (test/capture-write.test.ts). The narrowing rule
  // it was written for is unchanged and still live for a named `function`, which is not
  // a closure and gets no capture analysis — so the case is carried over in that form,
  // and the arrow spelling is kept below as the interaction it now is.
  test("a name assigned inside a FUNCTION called in between is never narrowed", () => {
    expectRejected(`
let x: number | undefined = 1;
function clear(): void { x = undefined; }
if (x !== undefined) {
  clear();
  console.log(x + 1);
}
`, "NT2001", "?Unumber");
  });

  test("the arrow spelling of the same program is refused first, by NT1029", () => {
    expectRejected(`
let x: number | undefined = 1;
const clear = () => { x = undefined; };
if (x !== undefined) {
  clear();
  console.log(x + 1);
}
`, "NT1031", "captured binding");
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

  // The mixed-precedence shape: `&&` binds tighter than `||`, so the fact established by
  // the `&&`'s left operand covers its right operand and STOPS at the `||`. TypeScript:
  // controlFlowBinaryAndExpression.ts + controlFlowBinaryOrExpression.ts composed, which
  // is the `a && a.b || c` idiom.
  test("`a && a.b || c` — the `&&` fact reaches `a.b` and stops at the `||`", async () => {
    await expectNode(`
function pick(a: { b: number } | undefined, c: boolean): boolean {
  return !!a && a.b > 0 || c;
}
let a: { b: number } | undefined = { b: 5 };
console.log(pick(a, false));
a = { b: -5 };
console.log(pick(a, false));
console.log(pick(a, true));
a = undefined;
console.log(pick(a, false));
console.log(pick(a, true));
`);
  });

  // SOUNDNESS. Narrowing a dotted name is only safe because the object cannot be
  // rewritten in place; a `@@mutable` record can be, so it gets no path fact and the
  // read is still refused. (An unsound narrowing here would hand codegen a bare value
  // where a nullish box is sitting — the silent wrong answer the prime directive bans.)
  test("a `@@mutable` record's field is NEVER narrowed", () => {
    expectRejected(`
@@mutable
type Cell = { n: number[] | undefined };
const c: Cell = { n: [1, 2] };
if (c.n) {
  c.n = undefined;
  console.log(c.n.length);
}
`, "NT2001", "'c.n' is possibly undefined");
  });

  // SOUNDNESS. TypeScript: typeGuardsInRightOperandOfOrOrOperator.ts `foo2`/`foo3`
  // ("modify x in right hand operand" — the narrowing stops). Here the assignment sits in
  // a MIDDLE term of the chain, so it runs between the proof and the use: at `x.length`
  // the binding holds `y`, not the value `!x` was about. node throws a TypeError on that
  // line, so a narrowing here would be a proof of something false.
  test("an assignment anywhere in the guard chain invalidates the narrowing", () => {
    expectRejected(`
let x: number[] | undefined = [1, 2];
const y: number[] | undefined = undefined;
console.log(!x || (x = y) !== undefined || x.length === 0);
`, "NT2001", "'x' is possibly undefined");
  });

  // SOUNDNESS. The `||` direction, for a dotted name: the right operand runs when the
  // left was FALSE, i.e. exactly when `d.spans` IS nullish. Narrowing there is the
  // opposite of the truth. (The identifier form of this is pinned in "narrowing 3".)
  test("`||` does NOT carry the POSITIVE fact to a dotted name", () => {
    expectRejected(`
function f(d: { spans: number[] | undefined }): boolean {
  return d.spans !== undefined || d.spans.length === 0;
}
`, "NT2001", "'d.spans' is possibly undefined");
  });

  // SOUNDNESS. TypeScript: controlFlowTruthiness.ts `f1` — the ELSE branch keeps
  // `string | undefined`. Truthiness is one-way: `0`, `""` and `false` are falsy while
  // perfectly present, so a false test proves nothing about the tag.
  test("truthiness narrows the TAKEN branch only", () => {
    expectRejected(`
let xs: number[] | undefined = [1];
if (xs) {
  console.log(xs.length);
} else {
  console.log(xs.length);
}
`, "NT2001", "'xs' is possibly undefined");
  });

  // A known LIMIT, pinned so it stays a refusal rather than becoming a wrong answer: the
  // narrowing reaches `a.b`, but nativets' `&&`/`||` still require matching
  // boolean/number/string operands, so the VALUE-returning `a && a.b` (node: `undefined`
  // or a number) has no type here yet. Reject, never miscompile.
  test("the value-returning `a && a.b` is still refused (matching-operand rule)", () => {
    expectRejected(`
let a: { b: number } | undefined = { b: 2 };
console.log(a && a.b);
`, "NT2001", "operands must be matching");
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

/*
 * TRUTHINESS of an A2 nullable box (`if (x)`, `x ? … : …`, `while (x)`, `!x`).
 *
 * `truthyOf` in src/codegen.ts was type-directed for boolean and number and then
 * fell through to "treat it as a string and call js_str_len". A nullable is a
 * POINTER to a 2-slot [tag, value] block, so that read hit the box itself: every
 * nullable came out truthy regardless of what it held. Measured against node,
 * 6 of the 8 shapes below were wrong, and only `undefined` was accidentally right.
 *
 * The rule has TWO halves and the second is the one that bites: a nullish arm is
 * falsy, AND a PRESENT `0` / `NaN` / `""` / `false` is falsy too. Each is pinned
 * separately rather than as one aggregate assertion.
 *
 * Cases are DERIVED (no test262/conformance checkout on this machine); node is the
 * oracle for every one.
 */
describe("truthiness of a nullable box — the tag, then the VALUE", () => {
  const cases: [string, string, string][] = [
    ["present 0",     `const x: number | undefined = [0].at(0);`,     "F"],
    ["present NaN",   `const x: number | undefined = [NaN].at(0);`,   "F"],
    ["present 1",     `const x: number | undefined = [1].at(0);`,     "T"],
    ["present \"\"",  `const x: string | undefined = [""].at(0);`,    "F"],
    ["present \"a\"", `const x: string | undefined = ["a"].at(0);`,   "T"],
    ["present false", `const x: boolean | undefined = [false].at(0);`,"F"],
    ["present true",  `const x: boolean | undefined = [true].at(0);`, "T"],
    ["undefined",     `const x: number | undefined = [1].at(5);`,     "F"],
    ["null",          `let x: string | null = null;`,                 "F"],
  ];
  for (const [name, decl, want] of cases) {
    test(`${name} is ${want === "T" ? "truthy" : "FALSY"}`, async () => {
      const src = `${decl}\nconsole.log(x ? "T" : "F");\n`;
      const oracle = runWithNode(src);
      expect(oracle.stdout).toBe(`${want}\n`); // node is the oracle; assert it first
      const ours = await compileAndRun(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  test("`!x` and `while (x)` agree with `if (x)` — every condition position", async () => {
    const src = `const z: number | undefined = [0].at(0);
console.log(!z, !!z);
let n = 0;
while (z) { n = n + 1; break; }
console.log(n);
`;
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe("true false\n0\n");
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * The same `truthyOf` fall-through, on the OTHER types it silently reached. These are
 * not nullables, but they are the same defect and the same one-line fix, so they are
 * pinned here rather than left for the next person to rediscover.
 */
describe("truthiness of the other types the string fall-through was reaching", () => {
  test("an object is ALWAYS truthy — including an empty array and an empty record", async () => {
    // node: `[]` and `{}` are truthy (a common JS gotcha). We answered FALSE for both.
    const src = `const e: number[] = [];
const a: number[] = [1];
const o: { k: number } = { k: 1 };
console.log(e ? "T" : "F", a ? "T" : "F", o ? "T" : "F");
`;
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe("T T T\n");
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a Dyn's truthiness is its JSON tag's — `JSON.parse(\"0\")` is falsy", async () => {
    const src = `console.log(JSON.parse("0") ? "T" : "F", JSON.parse("1") ? "T" : "F");
console.log(JSON.parse("\\"\\"") ? "T" : "F", JSON.parse("[]") ? "T" : "F", JSON.parse("null") ? "T" : "F");
`;
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe("F T\nF T F\n"); // [] is truthy, "" and null are not
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * JSON.stringify of a nullable box.
 *
 * `genJsonStringify` is a type-directed walk that ends in `return "null"` for any type
 * it does not recognize — and a nullable was one of those, so EVERY nullable serialized
 * as the literal `null` no matter what it held. Silent.
 *
 * node's rules here are genuinely subtle and were MEASURED, not reasoned out:
 *   JSON.stringify(7)            -> "7"
 *   JSON.stringify(null)         -> "null"
 *   JSON.stringify(undefined)    -> the VALUE undefined, not any string
 *   JSON.stringify({k: null})    -> {"k":null}
 *   JSON.stringify({k: undefined}) -> {}          <- the key is OMITTED
 * The two `undefined` shapes are handled separately (see the next describe); this one
 * pins the half that is unambiguous.
 */
describe("JSON.stringify of a nullable renders the VALUE, not the box", () => {
  const cases: [string, string, string][] = [
    ["root, present number", `let x: number | null = 7;\nconsole.log(JSON.stringify(x));`, "7"],
    ["root, present string", `let x: string | null = "a";\nconsole.log(JSON.stringify(x));`, `"a"`],
    ["root, null arm",       `let x: string | null = null;\nconsole.log(JSON.stringify(x));`, "null"],
    ["nested, present",      `const p: number | undefined = [7].at(0);\nconsole.log(JSON.stringify({ k: p }));`, `{"k":7}`],
    ["nested, null arm",     `let n: string | null = null;\nconsole.log(JSON.stringify({ k: n }));`, `{"k":null}`],
  ];
  for (const [name, src, want] of cases) {
    test(name, async () => {
      const full = `${src}\n`;
      const oracle = runWithNode(full);
      expect(oracle.stdout).toBe(`${want}\n`); // node first — the oracle, not our guess
      const ours = await compileAndRun(full);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});

/*
 * The two `undefined` shapes JSON.stringify cannot express here. Both were silently
 * wrong (each rendered the literal `null`); both are now refused with the fix named.
 *
 *   JSON.stringify(x)      where x is `T | undefined` and absent
 *       node returns the VALUE `undefined` — not a string at all. Our JSON.stringify
 *       is typed `string`, so there is nothing correct to return.
 *   JSON.stringify({k: x}) where x is `T | undefined` and absent
 *       node OMITS the key entirely (`{}`, not `{"k":null}`), which needs the key and
 *       its separator decided at runtime.
 *
 * A `T | null` is unaffected in both positions — `null` is exactly what node emits.
 */
describe("the `undefined` shapes JSON.stringify cannot express are REFUSED, not guessed", () => {
  const codeOf = (source: string): string | null => {
    try { sourceToIR(source); return null; }
    catch (e) { return e instanceof NTError ? e.diag.code : "NT9001"; }
  };
  const messageOf = (source: string): string => {
    try { sourceToIR(source); return ""; }
    catch (e) { return e instanceof NTError ? e.diag.message : String(e); }
  };

  test("a `T | undefined` at the ROOT is refused", () => {
    const src = `const a: number | undefined = [7].at(9);\nconsole.log(JSON.stringify(a));\n`;
    expect(codeOf(src)).toBe("NT1005");
    expect(messageOf(src)).toContain("?? ");
  });

  test("a `T | undefined` FIELD is NOT refused — the key is OMITTED, as node does", async () => {
    const src = `const p: number | undefined = [7].at(0);
const a: number | undefined = [7].at(9);
console.log(JSON.stringify({ k: a }));
console.log(JSON.stringify({ k: p }));
console.log(JSON.stringify({ a: a, b: 1 }));
console.log(JSON.stringify({ a: 1, b: a }));
console.log(JSON.stringify({ a: a, b: a }));
`;
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe(`{}\n{"k":7}\n{"b":1}\n{"a":1}\n{}\n`); // node: the key vanishes, commas close up
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("key omission also works PRETTY-PRINTED, where the separator carries a newline+indent", async () => {
    const src = `const p: number | undefined = [7].at(0);
const a: number | undefined = [7].at(9);
console.log(JSON.stringify({ a: a, b: 1, c: p }, null, 2));
console.log(JSON.stringify({ x: a }, null, 2));
console.log(JSON.stringify({ o: { k: a }, q: 3 }, null, 2));
`;
    const oracle = runWithNode(src);
    // an emptied object is `{}` with NO newline inside it, even under an indent
    expect(oracle.stdout).toBe(`{\n  "b": 1,\n  "c": 7\n}\n{}\n{\n  "o": {},\n  "q": 3\n}\n`);
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("...but a `T | null` is fine in BOTH positions — `null` is what node emits", () => {
    expect(codeOf(`let n: string | null = null;\nconsole.log(JSON.stringify(n));\n`)).toBe(null);
    expect(codeOf(`let n: string | null = null;\nconsole.log(JSON.stringify({ k: n }));\n`)).toBe(null);
  });
});

/*
 * `${x}` and `"" + x` on a nullable box.
 *
 * The template form emitted INVALID IR (a clang error — loud, never a wrong answer)
 * and concatenation was refused outright by an earlier lane, on the reasoning that
 * `?? "…"` is "the only spelling whose output is unambiguous". node disagrees, and
 * node is the specification: String(undefined) is "undefined" and String(null) is
 * "null", exactly and without ambiguity. Both forms now match it.
 */
describe("string coercion of a nullable — `${x}` and `\"\" + x` match node", () => {
  test("every arm, both spellings", async () => {
    const src = `const p: number | undefined = [7].at(0);
const a: number | undefined = [7].at(9);
const s: string | undefined = ["hi"].at(0);
let n: string | null = null;
console.log(\`\${p}|\${a}|\${s}|\${n}\`);
console.log("" + p, "" + a, "" + s, "" + n);
`;
    const oracle = runWithNode(src);
    expect(oracle.stdout).toBe("7|undefined|hi|null\n7 undefined hi null\n");
    const ours = await compileAndRun(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

/*
 * PRE-EXISTING SILENT WRONG ANSWER, found while sizing the `.set`-chain rewrite of
 * `src/ownership.ts`'s `clone` (whose test compares two `Map.get` results).
 *
 * `===` between TWO nullable boxes is the missing member of the family this file
 * already documents. `refuseUnboxedUnion` (src/checker.ts) lists the four ways a
 * tagged box goes wrong for a GENERAL union — "truthiness tested the box POINTER,
 * `===` compared TAGS, JSON.stringify rendered the literal `null`, concatenation
 * emitted invalid IR" — and three of the four were fixed for the NULLABLE box in the
 * blocks above. The fourth never was, and there was no refusal in front of it:
 *
 *     const p: number | undefined = 1;
 *     const q: number | undefined = 2;
 *     console.log(p === q);        // node: false     nativets: TRUE, exit 0
 *
 * The cause is a DEFAULT ARM, the same shape as the `.join()` bug the nullable-element
 * lane found. `genExpr`'s FCMP chain dispatches on `number` / `boolean` / array+object
 * / relational-string and then falls through to `js_str_eq` on the two operands — for
 * a nullable that is `strcmp` over the `[tag, value]` BLOCK, which stops at the first
 * NUL byte of the i64 tag, so every present box equals every other present box
 * regardless of what it carries. `?Nstring` is wrong the same way ("a" === "b").
 *
 * Fixed the way this project fixes a miscompile it cannot yet lower: REFUSED. A
 * correct lowering is a tag dispatch (`both nullish -> true; both present -> compare
 * the unwrapped bases; else false`), which needs a branch per base type and belongs to
 * the lane that takes it. `nullable === undefined` / `=== null` is untouched — that is
 * a TAG comparison and it is the one this really is.
 */
describe("`===` between two nullable boxes is refused, not answered from the TAG", () => {
  const NEEDLE = "tagged box";
  test("the shape that came back `true` for 1 === 2", () => {
    expectRejected(
      `const p: number | undefined = 1;\nconst q: number | undefined = 2;\nconsole.log(p === q);`,
      "NT1009", NEEDLE);
  });

  test("`!==`, and the string base, are the same refusal", () => {
    expectRejected(
      `const p: number | undefined = 1;\nconst q: number | undefined = 2;\nconsole.log(p !== q);`,
      "NT1009", NEEDLE);
    expectRejected(
      `const a: string | null = "a";\nconst b: string | null = "b";\nconsole.log(a === b);`,
      "NT1009", NEEDLE);
  });

  test("comparing a nullable to `undefined` / `null` still WORKS — it really is a tag test", async () => {
    await expectNode(`const p: number | undefined = [7].at(0);
const a: number | undefined = [7].at(9);
console.log(p === undefined, a === undefined, p !== undefined, undefined === a);
const n: string | null = null;
console.log(n === null, n !== null);`);
  });

  test("the NARROWED comparison is the fix the hint hands back, and it matches node", async () => {
    await expectNode(`const p: number | undefined = [1].at(0);
const q: number | undefined = [2].at(0);
if (p !== undefined && q !== undefined) console.log(p === q, p !== q);
console.log((p ?? -1) === (q ?? -1));`);
  });
});

/*
 * A NAME'S NARROWING IS NOT POISONED BY AN UNRELATED FUNCTION'S OWN LOCAL.
 *
 * `Checker.closureAssigned` is the program-wide set of names assigned inside some
 * function/arrow body — a name in it is never narrowed anywhere, which is
 * TypeScript's rule for a CAPTURED binding (`narrowingPastLastAssignment.ts`): the
 * closure may run after the narrowing was established.
 *
 * The set was keyed by bare NAME and took EVERY assignment inside every function
 * body, including ones to bindings that function declares itself. A private
 * `let a = 0` in one function therefore made `a` unnarrowable in every other
 * function in the program — an over-refusal on code node runs, and one that gets
 * likelier the bigger the program is. On the compiler's own source it was the first
 * blocker for eight of the twelve modules: `let a = 0` in `src/lexer.ts`'s
 * `pragmaName` unnarrowed `a` in `src/ast.ts`'s `unifyTypeParams`, two modules away.
 *
 * The rule now: an inner function's assignment counts only if it can actually reach
 * an outer binding, i.e. the name is not one of that function's parameters or its
 * body's top-level declarations.
 */
describe("closure-assignment poisoning is scoped to real captures", () => {
  test("another function's own local does not block narrowing here", async () => {
    await expectNode(`
function use(s: string): number { return s.length; }
function f(xs: string[]): number {
  const a = xs.at(0);
  if (a !== undefined) return use(a);
  return -1;
}
function other(): number { let a = 0; a = a + 1; return a; }
console.log(f(["hi"]), other());
`);
  });

  test("...nor does another function's PARAMETER of the same name", async () => {
    await expectNode(`
function use(s: string): number { return s.length; }
function f(xs: string[]): number {
  const a = xs.at(0);
  if (a !== undefined) return use(a);
  return -1;
}
function other(a: number): number { a = a + 1; return a; }
console.log(f(["hey"]), other(1));
`);
  });

  test("...nor an ARROW's own local", async () => {
    await expectNode(`
function use(s: string): number { return s.length; }
const bump = (): number => { let a = 0; a = a + 2; return a; };
function f(xs: string[]): number {
  const a = xs.at(0);
  if (a !== undefined) return use(a);
  return -1;
}
console.log(f(["abcd"]), bump());
`);
  });

  /*
   * ...and the rule it exists to enforce still holds: a genuine CAPTURE — an inner
   * function assigning a binding it does NOT declare — is still refused. Note WHICH
   * refusal arrives: a captured WRITE is `NT1031` in its own right (closures capture by
   * value here), and that fires before the narrowing question is ever asked. So on this
   * shape `closureAssigned` is a second line of defence rather than the only one — which
   * is exactly why loosening it is safe, and why the test asserts the refusal that the
   * user actually sees instead of one the compiler happens to reach first today.
   */
  test("REFUSED: a real captured assignment is still rejected", () => {
    expectRejected(`
function use(s: string): number { return s.length; }
let a: string | undefined = "hi";
const clear = (): void => { a = undefined; };
if (a !== undefined) console.log(use(a));
clear();
`, "NT1031", "captured binding");
  });

  /*
   * STILL OPEN, pinned so it is a known refusal rather than a surprise. The subtraction
   * covers a function's parameters and its body's TOP-LEVEL declarations only. A `let a`
   * declared in an inner BLOCK (here a `switch` case, which is exactly the shape at
   * src/checker.ts:2207) is not subtracted, so it still poisons the name program-wide.
   * Closing it means resolving the assignment against a real scope chain rather than
   * matching names, which is a bigger change than this one and belongs on its own.
   */
  test("REFUSED, still: a block-scoped local in another function poisons the name", () => {
    expectRejected(`
function use(s: string): number { return s.length; }
function f(xs: string[]): number {
  const a = xs.at(0);
  if (a !== undefined) return use(a);
  return -1;
}
function other(k: number): number {
  switch (k) {
    case 1: { let a = 0; a = a + 1; return a; }
    default: return 0;
  }
}
console.log(f(["hi"]), other(1));
`, "NT2001", "got ?Ustring");
  });
});
