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

/*
 * narrowing 2b — the same guard, in a body whose RETURN TYPE IS INFERRED.
 *
 * `checkBlock` has done early-exit narrowing since SH2. It is not the only walk over a
 * statement list: `inferBlockReturn` runs FIRST over the same statements, to find the
 * first top-level `return` and read the body's type off it, and it checked every
 * statement on the way with a hand-rolled loop that had no narrowing at all. Its
 * diagnostic wins because it is raised first, so the guard-clause idiom was refused in
 * every body that reaches it — and `checkBlock`, which would have accepted the identical
 * code, never ran.
 *
 * Which bodies reach it: every BLOCK-BODIED ARROW (`typeArrowReturn` calls it whether or
 * not the arrow is annotated) and every UNANNOTATED `function`. An annotated `function`
 * does not, which is why `narrowing 2` above never caught this — every case there is a
 * `function` with a return type written on it.
 *
 * node is the oracle for all of them: the type layer is erased, so each of these programs
 * simply runs.
 */
describe("narrowing 2b — an early-exit guard in an INFERRED-return body", () => {
  test("an inlined `forEach` arrow: `if (el.name === null) return;` narrows the rest", async () => {
    await expectNode(`
const elems: { name: string | null }[] = [{ name: null }, { name: "b" }];
elems.forEach((el, i) => {
  if (el.name === null) return;
  console.log(i, el.name.length);
});
`);
  });

  // The A/B pair this was found as: the two spellings of one loop, which differed only
  // in `return`-in-an-arrow vs `continue`-in-a-`for`. The `for` half always compiled.
  test("the `forEach`/`return` and `for`/`continue` spellings now agree", async () => {
    const body = (loop: string) => `
const elems: { name: string | null }[] = [{ name: null }, { name: "b" }];
//@@mutable
let out: { name: string }[] = [];
${loop}
console.log(out.length, out[0].name);
`;
    await expectNode(body(`elems.forEach((el, i) => {
  if (el.name === null) return;
  out.push({ name: el.name });
});`));
    await expectNode(body(`for (const el of elems) {
  if (el.name === null) continue;
  out.push({ name: el.name });
}`));
  });

  // An UNANNOTATED `function` reaches the same pre-pass (`inferReturnType`), so this was
  // never about arrows. Annotating this exact function made it compile.
  test("an unannotated `function` — the read is INSIDE the inferred return", async () => {
    await expectNode(`
function go(el: { name: string | null }) {
  if (el.name === null) return 0;
  return el.name.length;
}
console.log(go({ name: null }), go({ name: "bcd" }));
`);
  });

  // A `: void` arrow reaches it too — `typeArrowReturn` calls the pre-pass whether or not
  // the arrow is annotated, and treats `void` as "no declared type".
  test("a `: void`-annotated arrow narrows as well", async () => {
    await expectNode(`
const f = (el: { name: string | null }): void => {
  if (el.name === null) return;
  console.log(el.name.length);
};
f({ name: null });
f({ name: "xyz" });
`);
  });

  // WHY THE RETURN TAKES THE WIDER READING. The guard proves nothing about the `return`
  // nested inside it, and the pre-pass's answer is the type BOTH are checked against.
  // Narrowing the top-level read to `string` refuses the `return null` above it — this
  // program compiles and matches node, and must keep doing so.
  test("a `return` nested in the guard still fits: the body's type stays the wide one", async () => {
    await expectNode(`
const elems: { name: string | null }[] = [{ name: null }, { name: "b" }];
const r = elems.map((el) => {
  if (el.name === null) return null;
  return el.name;
});
console.log(r.length, r[0], r[1]);
`);
  });

  // MUTATION 1. The guard must actually DIVERGE. Drop the `return` and the statements
  // below it are reachable on the nullish path, so nothing is proved — still refused.
  test("REFUSED: the guard body does not exit, so the rest is NOT narrowed", () => {
    expectRejected(`
const elems: { name: string | null }[] = [{ name: null }, { name: "b" }];
elems.forEach((el, i) => {
  if (el.name === null) { console.log("skip", i); }
  console.log(el.name.length);
});
`, "NT2001", "'el.name' is possibly null");
  });

  // MUTATION 2. The proof only survives while the object cannot be rewritten between the
  // guard and the read. `accessPath` declines a `@@mutable` receiver for exactly this, and
  // that decline is load-bearing — narrowing here would read a bare value out of a slot
  // still holding a nullish box. The pre-pass must not have become a way around it.
  test("REFUSED: a `@@mutable` field, guarded then invalidated by a call in between", () => {
    expectRejected(`
@@mutable
type Cell = { def: string | null };
function clear(c: Cell): void { c.def = null; }
const cells: Cell[] = [{ def: "a" }];
cells.forEach((c) => {
  if (c.def === null) return;
  clear(c);
  console.log(c.def.length);
});
`, "NT2001", "'c.def' is possibly null");
  });

  // MUTATION 3. Same rule as `narrowing 2`'s "an assignment below the guard invalidates
  // the narrowing", now that this walk records facts at all: the region filter has to be
  // live here too, or a reassigned root would keep a proof about the previous value.
  test("REFUSED: the root is reassigned below the guard", () => {
    expectRejected(`
const f = (x: number | undefined) => {
  if (x === undefined) return 0;
  x = undefined;
  return x + 1;
};
console.log(f(1));
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
    // `col`/`file` are the span's location fields: a span carries the FILE its line number
    // indexes, because `linkProgram` merges the import graph into one Program while each
    // module keeps its own numbering. `file` is undefined here — `sourceToIR(source)` with
    // no path parses anonymously — which is exactly the single-file case that must keep
    // rendering against the one `source` below.
    expect(diag.spans).toEqual([{ line: 3, col: 17, file: undefined, label: "this read is not proved non-nullish", primary: true }]);
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

  /*
   * The MIXED case — one box, one raw value — is the same refusal for the same reason,
   * and it arrived with NO hint at all:
   *
   *     const a: string = "x";
   *     const b: string | undefined = "x";
   *     console.log(a === b);
   *     error[NT2001]: Cannot compare string with ?Ustring        (no `= help:` line)
   *
   * The refusal is right — a raw `string` and a `[tag, value]` block have no bit pattern
   * in common — but `T === T | undefined` is ordinary, correct JavaScript, so a reader
   * who wrote it needs the rewrite, not just the two type names. The two-nullable case
   * one block up has carried that advice all along; this is the same sentence for the
   * other arity.
   *
   * The rewrite it hands back is EXACT for `===`, not merely compilable: node answers
   * `false` whenever the nullable is absent, and so does `b !== undefined && a === b`,
   * because an absent value can never equal a present one. Both spellings are compiled
   * against node below.
   */
  test("the MIXED comparison (`T === T | undefined`) says how to rewrite it", () => {
    let err: unknown;
    try {
      sourceToIR(`const a: string = "x";\nconst b: string | undefined = "x";\nconsole.log(a === b);`);
    } catch (e) { err = e; }
    const text = formatDiagnostic((err as NTError).diag);
    expect(text).toContain("NT2001");
    expect(text).toContain("Cannot compare string with ?Ustring");
    expect(text).toContain("= help:");            // there WAS no help line at all
    expect(text).toContain("b !== undefined && a === b");
  });

  test("the mixed hint's rewrite compiles and matches node — present AND absent", async () => {
    await expectNode(`const a: string = "x";
const b: string | undefined = ["x"].at(0);
const c: string | undefined = ["x"].at(9);
console.log(b !== undefined && a === b, c !== undefined && a === c);
console.log(b === undefined || a !== b, c === undefined || a !== c);`);
  });

  // The `| null` base renders `null` throughout — the tag it prescribes has to be the
  // one the box actually carries, or the line it hands back does not even compile.
  test("the `| null` base gets the `null` spelling, and it too matches node", async () => {
    let err: unknown;
    try { sourceToIR(`const a: number = 1;\nconst b: number | null = 1;\nconsole.log(a !== b);`); } catch (e) { err = e; }
    const text = formatDiagnostic((err as NTError).diag);
    expect(text).toContain("b === null || a !== b");
    expect(text).not.toContain("undefined");
    await expectNode(`const a: number = 1;
const b: number | null = [1].at(0) ?? null;
const c: number | null = null;
console.log(b === null || a !== b, c === null || a !== c);`);
  });

  // The mutation guard: a mismatch that is NOT nullable-vs-its-own-base gets no advice,
  // because there is none to give. Widen the hint to every `l !== r` and this fails.
  test("an unrelated type mismatch keeps the bare message", () => {
    let err: unknown;
    try { sourceToIR(`const a: string = "x";\nconst n: number = 1;\nconsole.log(a === n);`); } catch (e) { err = e; }
    const text = formatDiagnostic((err as NTError).diag);
    expect(text).toContain("Cannot compare string with number");
    expect(text).not.toContain("= help:");
  });
});

/*
 * THE REST OF THE SAME FALL-THROUGH.
 *
 * The equality chain in `genExpr`'s `BinaryExpr` (src/codegen.ts) dispatched on `number`,
 * `boolean` and array/object POINTER IDENTITY, and then ended in a bare `else` that called
 * `js_str_eq(ptr, ptr)`. That `else` was the default arm, not the string arm, so any type
 * whose representation is NOT a pointer reached it and handed a `double` or an `i8` to a
 * `ptr` parameter. clang rejected the module, so neither of these was ever a MISCOMPILE —
 * but both reached the user as a raw clang error naming an SSA register, with no `NT****`
 * code and no hint, which is the one thing the diagnostics contract promises never happens:
 *
 *     const a = new Date(1000); const b = new Date(2000); a === b;
 *     error: '%t2' defined with type 'double' but expected 'ptr'
 *
 *     const a = null; const b = null; a === b;      // node: true
 *     error: '%t0' defined with type 'i8' but expected 'ptr'
 *
 * They get OPPOSITE answers, because the two questions are different.
 *
 * `null === null` is answerable: `null` and `undefined` are unit types, so every value of
 * one is the same value, and node's answer is a constant `true` (`false` for `!==`). It is
 * now computed as that constant.
 *
 * `date === date` is NOT answerable. node compares Date IDENTITY — two distinct Dates are
 * `false` however equal their instants, and an Invalid Date IS `===` itself even though
 * `NaN !== NaN` — and nativets represents a Date AS its time value, so there is no identity
 * left to compare. Both plausible codegens are wrong for a program somebody writes, so it
 * is REFUSED with a code that names the workaround instead. The hint's spelling is
 * compiled against node below rather than asserted, because a hint that hands back a
 * DIFFERENT answer is worse than no hint.
 */
describe("`===` on the types the js_str_eq fall-through was reaching", () => {
  test("`null === null` is node's `true`, not a clang error", async () => {
    await expectNode(`const a = null;
const b = null;
console.log(a === b, a !== b);
const u = undefined;
const v = undefined;
console.log(u === v, u !== v);`);
  });

  test("`date === date` is refused with a CODE — never a bare clang error", () => {
    expectRejected(
      `const a = new Date(1000);\nconst b = new Date(2000);\nconsole.log(a === b);`,
      "NT1024", "identity");
  });

  test("`!==` between Dates is the same refusal", () => {
    expectRejected(
      `const a = new Date(1000);\nconst b = new Date(2000);\nconsole.log(a !== b);`,
      "NT1024", "identity");
  });

  /*
   * The hint says to compare `.getTime()`, and warns that it is a VALUE comparison rather
   * than node's identity one. Both halves of that warning are compiled here: two distinct
   * Dates at the same instant are `true` by time value where node's `===` is `false`, and
   * an Invalid Date is `false` against itself where node's `===` is `true`. If the hint
   * ever stops saying so, this is the test that notices.
   */
  test("the hint's `.getTime()` spelling compiles, and its caveat is node-true", async () => {
    // Half one: the spelling the hint hands back really compiles here, and agrees with node.
    await expectNode(`const a = new Date(1000);
const b = new Date(1000);
const inv = new Date(NaN);
console.log(a.getTime() === b.getTime());
console.log(inv.getTime() === inv.getTime());`);
    // Half two: node's IDENTITY answers for the same two pairs — `false` where the time
    // values are equal, `true` where they are both NaN. Exactly the inversion the hint
    // warns about, so the warning is measured rather than asserted. (node only: the
    // construct is refused here, which is what this whole block is about.)
    expect(runWithNode(`const a = new Date(1000);
const b = new Date(1000);
const inv = new Date(NaN);
console.log(a === b);
console.log(inv === inv);`).stdout).toBe("false\ntrue\n");
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
  test("a block-scoped local in another function does not poison the name either", async () => {
    // WAS a pinned open refusal: the subtraction covered a function's parameters and its
    // body's TOP-LEVEL declarations only, so a `let a` declared in an inner BLOCK (here a
    // `switch` case, the shape at src/checker.ts:2207) still poisoned `a` program-wide.
    // Scoping the question to the body that DECLARES the narrowed binding closes it from
    // the other side: `a` in `f` is `f`'s own, so only arrows in `f` can matter, and
    // `other`'s locals — block-scoped or not — are no longer part of the question.
    await expectNode(`
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
`);
  });

  /*
   * ...and the same question asked of an ARROW'S OWN PARAMETER.
   *
   * `closureAssigned` was consulted for EVERY fact by bare name, so it fired even when
   * the narrowed binding was the parameter of the very arrow being typed — nothing any
   * closure could possibly reach. That is `src/coverage-preprocess.ts`'s
   * `const isP = (t: Tok | undefined, v: string) => !!t && t.kind === …`, which compiled
   * standalone and did not compile once the module graph was linked, because some other
   * module's arrow assigns a `t`.
   */
  test("an arrow's OWN PARAMETER narrows, whatever other arrows in the program assign", async () => {
    await expectNode(`
interface Tok { kind: string; value: string }
let t: number = 0;
const nums: number[] = [1, 2, 3];
const doubled: number[] = nums.map((x: number) => { t = t + x; return x * 2; });
const isP = (t: Tok | undefined, v: string): boolean => !!t && t.kind === "punct" && t.value === v;
console.log(isP({ kind: "punct", value: "+" }, "+"), isP(undefined, "+"), t, doubled[2]);
`);
  });

  /*
   * ...and the same question asked of a LOOP binding — the shape that gates most of the
   * compiler's own source.
   *
   * `ownBindings` models a body's parameters and its TOP-LEVEL declarations, so it sees a
   * `for (const s of …)` variable from NEITHER side: the producer side leaks it (a `let s`
   * in a BLOCK of `other` below escapes into the program-wide set, exactly as
   * src/lexer.ts's `lex` leaks its `let s = ""` from inside the number-literal branch),
   * and the consumer side cannot localize it (`bindingFrame` finds no body that binds `s`
   * and falls back to the whole program). Both halves have to miss for the bug to bite,
   * and on `s` they do: it was the FIRST BLOCKER of five of the twelve compiler modules,
   * at src/parser.ts's `valueReturns` — `case "ReturnStmt": if (s.argument) …`.
   */
  test("a loop binding narrows, though a block-scoped local elsewhere shares its name", async () => {
    await expectNode(`
function use(s: string): number { return s.length; }
function other(k: number): number {
  if (k > 0) { let s = 0; s = s + 1; return s; }
  return 0;
}
function f(xs: (string | undefined)[]): number {
  let n = 0;
  for (const s of xs) { if (s !== undefined) n = n + use(s); }
  return n;
}
console.log(f(["ab", undefined, "c"]), other(1));
`);
  });

  /*
   * ...and the two halves of the loop-binding rule that keep it sound. A block or loop
   * binding covers only its block, so localizing to the body that contains it is correct
   * only when nothing OUTSIDE that body could be the `name` being read.
   *
   * Both were proved by mutation, not by argument. Dropping the enclosing-frame check
   * below compiles the first case, and node THROWS on it (`Cannot read properties of
   * undefined`); dropping it accidentally — `blockBindings` seeded from the frame's own
   * `binds`, where `Set.add` mutates under bun though it is persistent in the subset this
   * compiler compiles itself in — did exactly that for one build here.
   */
  test("REFUSED: an OUTER binding of the same name is still judged program-wide", () => {
    expectRejected(`
let s: string | undefined = "hi";
function clear(): void { s = undefined; }
function f(xs: number[]): number {
  let seen = 0;
  for (const s of xs) { seen = seen + s; }
  if (s !== undefined) { clear(); return s.length + seen; }
  return -1;
}
console.log(f([1, 2]));
`, "NT2001", "'s' is possibly undefined");
  });

  test("REFUSED: an arrow in the SAME body that assigns the loop binding", () => {
    expectRejected(`
function use(t: string): number { return t.length; }
function f(xs: (string | undefined)[]): number {
  let n = 0;
  for (let s of xs) {
    const clear = (): void => { s = undefined; };
    if (s !== undefined) { clear(); n = n + use(s); }
  }
  return n;
}
console.log(f(["ab", undefined]));
`, "NT1031", "captured binding");
  });

  /*
   * The safe direction, pinned: a MODULE-LEVEL binding is still judged against the whole
   * program, because any arrow anywhere in it can reach one.
   */
  test("REFUSED, still: a module-level binding an arrow elsewhere assigns", () => {
    expectRejected(`
function use(s: string): number { return s.length; }
let a: string | undefined = "hi";
function later(): void { const clear = (): void => { a = undefined; }; clear(); }
function f(): number {
  if (a !== undefined) return use(a);
  return -1;
}
console.log(f());
later();
`, "NT1031", "captured binding");
  });
});

/*
 * ============================================================================
 * narrowing 6 — a `while` CONDITION narrows the loop body.
 *
 * `if`, `switch`, `&&`/`||`, an early-exit guard and `?:` all route through the one
 * mechanism (`factsFor` + `narrowTagsWith` → `narrowInto`/`narrowPathInto`); `while` was
 * simply never wired to it, so `while (x !== undefined) { x.length }` was refused while
 * the identical `if` was accepted. It is the same call site shape as `IfStmt`'s, with the
 * loop BODY as the region.
 *
 * The region choice is what makes the back edge safe, and it is the whole risk here: a
 * fact is dropped when the region assigns its root anywhere (`unstableNames`), and the
 * loop body IS the region — so the classic `while (s !== undefined) { …; s = next(); }`
 * keeps its refusal rather than carrying a stale proof across the back edge. A plain NAME
 * is shadowed CONST by `narrowInto`, so an assignment to it inside the body is refused
 * outright by the same rule an `if` arm uses.
 *
 * Reference cases mined from `microsoft/TypeScript`:
 *   - tests/cases/conformance/controlFlow/controlFlowWhileStatement.ts
 *   - tests/cases/conformance/controlFlow/controlFlowIfStatement.ts (the `if` twin each
 *     case below is checked against)
 *   - tests/cases/conformance/types/typeRelationships/typeGuards/
 *     narrowingPastLastAssignment.ts (the back-edge refusals)
 * ============================================================================
 */
describe("narrowing 6 — a `while` condition narrows the loop body", () => {
  test("`!== undefined` narrows the binding inside the body", async () => {
    await expectNode(`
let x: number | undefined = 3;
let n = 0;
while (x !== undefined) {
  n = n + x;
  if (n > 2) break;
}
console.log(n, x === undefined);
`);
  });

  test("a truthiness test narrows, and the loop still terminates", async () => {
    await expectNode(`
const words: string[] = ["alpha", "beta"];
let i = 0;
let out = "";
const s: string | undefined = words[0];
while (s) {
  out = out + s.toUpperCase();
  i = i + 1;
  if (i === 2) break;
}
console.log(out, i);
`);
  });

  test("a TAG test narrows the union in the body", async () => {
    await expectNode(`
type Node = { kind: "num"; value: number } | { kind: "str"; text: string } | { kind: "nil" };
const n: Node = { kind: "num", value: 7 };
let total = 0;
while (n.kind === "num") {
  total = total + n.value;
  if (total > 6) break;
}
console.log(total);
`);
  });

  test("a DOTTED PATH tag test narrows the body", async () => {
    await expectNode(`
type Leaf = { kind: "num"; value: number } | { kind: "nil" };
interface Box { leaf: Leaf }
const b: Box = { leaf: { kind: "num", value: 4 } };
let seen = 0;
while (b.leaf.kind === "num") {
  seen = seen + b.leaf.value;
  if (seen > 3) break;
}
console.log(seen);
`);
  });

  test("the `else` polarity is NOT proved: the body of `while (x === undefined)` sees the box", () => {
    expectRejected(`
function pick(i: number): number | undefined { return i > 0 ? i : undefined; }
let x: number | undefined = pick(0);
let i = 0;
while (x === undefined) {
  console.log(x + 1);
  i = i + 1;
  if (i > 1) break;
}
`, "NT2001", "?Unumber + number");
  });

  /*
   * THE BACK EDGE. Each of these three assigns the proven root inside the body, so the
   * proof does not survive to the next iteration. All three were refused before this
   * lane and must stay refused: a stale narrowing here hands codegen a slot layout the
   * value no longer has, which is the silent-wrong-answer shape this project has hit six
   * times (`n2.1622591016e-314` — a string pointer read as a double).
   */
  test("REFUSED: the body reassigns the narrowed nullable (loop back edge)", () => {
    expectRejected(`
function pick(i: number): string | undefined { return i < 2 ? "x" : undefined; }
let i = 0;
let s: string | undefined = pick(i);
while (s !== undefined) {
  console.log(s.length);
  i = i + 1;
  s = pick(i);
}
`, "NT2001", "possibly undefined");
  });

  /*
   * The plain-NAME back edge. `narrowNameInto` declines to narrow a name the body
   * reassigns, so the read below is refused as un-narrowed rather than the assignment
   * being refused as narrowed-const — and the hint names the assignment, because the
   * author DID write the test one line up. Loosening the region filter here is what
   * mutation-testing showed prints `2.1630537015e-314` for a string read as a double.
   */
  test("REFUSED: the body reassigns a TAG-narrowed binding", () => {
    expectRejected(`
type Node = { kind: "wrap"; inner: Node } | { kind: "nil" };
let root: Node = { kind: "wrap", inner: { kind: "nil" } };
while (root.kind === "wrap") {
  root = root.inner;
}
console.log(root.kind);
`, "NT2001", "'root' is assigned between it and this read");
  });

  /*
   * ...and the half that must NOT be refused, which is why `narrowNameInto` declines
   * instead of shadowing CONST: a body that reassigns the name and never reads a narrowed
   * field compiled before `while` narrowed anything, and still does.
   */
  test("a body that reassigns the name WITHOUT reading a narrowed field still compiles", async () => {
    await expectNode(`
type Node = { kind: "num"; value: number } | { kind: "str"; text: string };
function mkStr(): Node { const l: Node = { kind: "str", text: "hello" }; return l; }
let n: Node = { kind: "num", value: 4 };
let count = 0;
while (n.kind === "num") {
  count = count + 1;
  n = mkStr();
}
console.log(count, n.kind);
`);
  });

  test("REFUSED: the body reassigns the ROOT of a narrowed dotted path", () => {
    expectRejected(`
type Leaf = { kind: "num"; value: number } | { kind: "nil" };
interface Box { leaf: Leaf }
function next(): Box { return { leaf: { kind: "nil" } }; }
let b: Box = { leaf: { kind: "num", value: 4 } };
while (b.leaf.kind === "num") {
  console.log(b.leaf.value);
  b = next();
}
`, "NT2001", "does not exist on");
  });

  test("REFUSED: a read of the narrowed name AFTER the loop", () => {
    expectRejected(`
let x: number | undefined = 3;
let n = 0;
while (x !== undefined) { n = n + x; if (n > 2) break; }
console.log(x + 1);
`, "NT2001", "?Unumber + number");
  });

  test("REFUSED: the WRONG member's field, proved by the condition", () => {
    expectRejected(`
type Node = { kind: "num"; value: number } | { kind: "str"; text: string };
const n: Node = { kind: "num", value: 7 };
let seen = 0;
while (n.kind === "num") {
  console.log(n.text);
  seen = seen + 1;
  if (seen > 1) break;
}
`, "NT2001", "does not exist on");
  });

  test("REFUSED: a `do`/`while` condition proves nothing about the body it already ran", () => {
    expectRejected(`
let x: number | undefined = 3;
let n = 0;
do {
  n = n + x;
  if (n > 2) break;
} while (x !== undefined);
`, "NT2001", "number + ?Unumber");
  });
});

/*
 * narrowing 7 — the SWITCH arm, which had been left out of the reassignment filter.
 *
 * `narrowNameInto` takes a `blocked` set so a region that rebinds the name DECLINES to
 * narrow rather than shadowing the name CONST and turning the rebind into an error (see
 * "narrowing 6"). Every condition form routes through it — `if`, `while`, `&&`/`||`, the
 * early-exit guard — except one: `checkStmt`'s `SwitchStmt` arm called `narrowInto`
 * DIRECTLY, and computed its `blocked` set only for a dotted-path discriminant
 * (`d.p.path !== ""`), leaving a plain NAME discriminant with `null`.
 *
 * So the identical program compiled as an `if` and was REFUSED as a `switch` — and
 * `switch (x.kind)` is both the more idiomatic form over a discriminated union and the
 * one `src/` itself is written in throughout (`src/ast.ts` documents the house style).
 *
 * The region a NAME shadow has to be stable over is NOT every case body, which is what
 * the dotted-path set uses. It is the arm's own body plus every arm reachable from it by
 * FALL-THROUGH — the same reachability `carry` already computes with `leavesBlock`. Using
 * the blunt all-bodies set instead would refuse `case "a": read; break; default: assign;`,
 * which node runs and nothing about it is unsound.
 */
describe("narrowing 7 — a `switch` arm that reassigns the discriminant", () => {
  /*
   * The half that must NOT be refused, and the direct analogue of narrowing 6's
   * "a body that reassigns the name WITHOUT reading a narrowed field still compiles".
   * Before the fix this was `cannot assign to 'cur' here: it is NARROWED to …`.
   */
  test("an arm that reassigns the name WITHOUT reading a narrowed field compiles", async () => {
    await expectNode(`
type N = { kind: "a"; x: number } | { kind: "b"; s: string };
let cur: N = { kind: "a", x: 1 };
switch (cur.kind) {
  case "a":
    cur = { kind: "b", s: "swapped" };
    break;
  case "b":
    break;
}
console.log("done");
`);
  });

  /*
   * The precision that makes the per-arm region worth computing: one arm rebinds, a
   * DIFFERENT arm reads a narrowed field, and neither can reach the other (both `break`).
   * The all-bodies filter would refuse both reads; only the fall-through-aware one keeps
   * this compiling, which is what node does.
   */
  test("a SIBLING arm still narrows when the rebinding arm cannot reach it", async () => {
    await expectNode(`
type N = { kind: "a"; x: number } | { kind: "b"; s: string };
let cur: N = { kind: "b", s: "hello" };
switch (cur.kind) {
  case "a":
    cur = { kind: "b", s: "swapped" };
    break;
  case "b":
    console.log(cur.s);
    break;
}
`);
  });

  /*
   * ...and the same shape with the rebinding arm LAST, so the narrowed read is the one
   * that comes first. `default:` takes the tags no `case` listed, so it is shadowed too —
   * this was refused at the assignment before the fix (proved by mutation).
   */
  test("a narrowed read in an earlier arm survives a rebinding `default:`", async () => {
    await expectNode(`
type N = { kind: "a"; x: number } | { kind: "b"; s: string };
let cur: N = { kind: "a", x: 3 };
switch (cur.kind) {
  case "a":
    console.log(cur.x);
    break;
  default:
    cur = { kind: "a", x: 9 };
    break;
}
console.log("end");
`);
  });

  /* ---------------------------------------------------------------- refusals
   * The set that must NOT move. Each of these is a stale narrowing if the arm is allowed
   * to keep its shadow, which is the silent wrong answer this project has hit seven times
   * (a string pointer read as a double, at exit 0). Each was verified by MUTATION: with
   * the fall-through term dropped from the region, the first prints `2.1219957915e-314`
   * where node prints `swapped`.
   */

  /*
   * FALL-THROUGH. The rebinding arm does not `break`, so control reaches the next arm
   * carrying a value the next arm's tags no longer describe. `leavesBlock` is what sees
   * this — exactly as it already does for `carry`.
   */
  test("REFUSED: an arm rebinds and FALLS THROOUGH into an arm that reads a narrowed field", () => {
    expectRejected(`
type N = { kind: "a"; x: number } | { kind: "b"; s: string };
let cur: N = { kind: "a", x: 3 };
switch (cur.kind) {
  case "a":
    cur = { kind: "b", s: "swapped" };
  case "b":
    console.log(cur.s);
    break;
}
`, "NT2001", "does not exist on");
  });

  /*
   * The arm rebinds and then reads a narrowed field ITSELF. The read is refused as
   * un-narrowed rather than the assignment being refused as narrowed-const — the same
   * trade `narrowNameInto` already makes, and the hint names the assignment. (node prints
   * `undefined` here; `tsc --strict` errors, so refusing is the agreeing answer.)
   */
  test("REFUSED: an arm rebinds and then reads the narrowed field", () => {
    expectRejected(`
type N = { kind: "a"; x: number } | { kind: "b"; s: string };
let cur: N = { kind: "a", x: 3 };
switch (cur.kind) {
  case "a":
    cur = { kind: "b", s: "swapped" };
    console.log(cur.x);
    break;
  case "b":
    break;
}
`, "NT2001", "does not exist on");
  });

  /*
   * The SUB-UNION fall-through, and the case that proves the `flow` term is load-bearing
   * rather than subsumed by `carry`. `carry` unions the tags, so a fall-through arm is
   * never narrowed to ONE member — but with three members it can still be narrowed to a
   * two-member SUB-union, and `unionCommonField`'s same-slot rule then admits `.v`, which
   * `a` and `b` both carry at slot 1. The rebind in `case "a"` stores a `c`, whose slot 1
   * is a string pointer.
   *
   * MUTATION: with `flow` never accumulating (`flow = []`), this compiles and prints
   *   2.124223034e-314   at exit 0, where node prints `undefined`.
   * That is this project's signature silent wrong answer — a string pointer read as a
   * double — for the eighth recorded time, and it is one `case` from the accepting path.
   */
  /*
   * THE MISCOMPILE THIS LANE ACTUALLY FOUND — live on main at 9c9477f, not hypothetical.
   * Base tree prints
   *   2.157443986e-314   at exit 0, where node prints `undefined`.
   *
   * A NON-LITERAL case test (`case pick:` — legal, only its TYPE is checked against the
   * discriminant) contributes no tags, so `tags` is empty, `restrictUnion` answers
   * `undefined` and `narrowInto` declares NO shadow for that arm. The CONST shadow is what
   * had been standing in for a reassignment filter on every other arm, so with it absent
   * the arm's `cur = { kind: "c", … }` was simply allowed — and the arm falls through into
   * `case "b"`, which `carry` narrows to the `{a,b}` SUB-union, where `unionCommonField`'s
   * same-slot rule admits `.v` because `a` and `b` both carry a number at slot 1. The value
   * actually there is a `c`, whose slot 1 is a string pointer. Read as a double: 2.15e-314.
   *
   * The `flow` term is what closes it: the arm rebinds and does not leave, so its successor
   * declines to narrow and the read is refused. Nothing else in the switch path could —
   * `carry` tracks TAGS, and the tags were right; it was the VALUE that had moved.
   */
  test("REFUSED: a non-literal case arm rebinds and falls through (was a MISCOMPILE)", () => {
    expectRejected(`
type N = { kind: "a"; v: number } | { kind: "b"; v: number } | { kind: "c"; s: string };
function f(pick: string): void {
  let cur: N = { kind: "a", v: 1 };
  switch (cur.kind) {
    case pick:
      cur = { kind: "c", s: "boom" };
    case "b":
      console.log(cur.v);
      break;
    case "c":
      break;
  }
}
f("a");
`, "NT2001", "does not exist on");
  });

  test("REFUSED: a fall-through arm narrowed to a SUB-union the predecessor rebound", () => {
    expectRejected(`
type N = { kind: "a"; v: number } | { kind: "b"; v: number } | { kind: "c"; s: string };
let cur: N = { kind: "a", v: 1 };
switch (cur.kind) {
  case "a":
    cur = { kind: "c", s: "boom" };
  case "b":
    console.log(cur.v);
    break;
  case "c":
    break;
}
`, "NT2001", "does not exist on");
  });
});

/*
 * Narrowing a nullable FUNCTION-typed binding, and then CALLING it.
 *
 * This was reported as the closure gap — NT1003 "call to 'f' (function values / unknown
 * callee) is not supported yet", whose hint sends the reader at "captured environments".
 * The diagnostic is wrong about its own cause. Function values are fully implemented:
 * a REQUIRED `f: (x: number) => number` parameter compiles, is called through
 * `genCallValueFrom`, and prints the right answer. So does the identical program with the
 * narrowed value first rebound to a `const` of function type — which is the same value,
 * the same closure, and the same call, proving codegen was never the missing part.
 *
 * The one thing missing was NARROWING. `?U(number)=>number` is not `isFuncTy` (that
 * wants a leading `(`), and the call path read the binding's DECLARED type straight out
 * of the scope instead of the type proved on this path — the only read of a binding in
 * the checker that skipped `narrowedTy`. So `if (f !== undefined) f(n)` fell past the
 * function-value case to the unknown-name case and blamed closures.
 *
 * That is what blocks `src/ast.ts`'s `onAssign?: (name, at) => never` — the compiler's
 * own frontier — and it is a narrowing bug, not a missing feature.
 *
 * node erases the type layer entirely, so every case here is node-differential.
 */
describe("narrowing 12 — a nullable FUNCTION-typed binding is callable once narrowed", () => {
  test("`f !== undefined` narrows an optional callback parameter enough to call it", async () => {
    await expectNode(`
function apply(n: number, f?: (x: number) => number): number {
  if (f !== undefined) return f(n);
  return n;
}
console.log(apply(21, (x: number): number => x * 2));
console.log(apply(7));
`);
  });

  // Same program with the `if` deleted. tsc refuses this too (TS2722, "cannot invoke an
  // object which is possibly 'undefined'"), so refusing is right — what was wrong is that
  // it was refused as the CLOSURE gap, telling the reader to wait for a feature that had
  // already shipped when the fix is one `if`. The boundary is the point of the test: the
  // narrowing must be what admits the call, not the function type alone.
  test("REFUSED: calling the same optional callback WITHOUT narrowing it", () => {
    expectRejected(`
function apply(n: number, f?: (x: number) => number): number {
  return f(n);
}
console.log(apply(21, (x: number): number => x * 2));
`, "NT2001", "possibly undefined");
  });

  // The `else` arm proves the fact is POLARITY-correct: on the branch where `f` IS
  // nullish the call must still be refused, or the narrowing would be unsound in the
  // one direction that produces a null dereference rather than a diagnostic.
  test("REFUSED: calling it on the branch where the guard proved it ABSENT", () => {
    expectRejected(`
function apply(n: number, f?: (x: number) => number): number {
  if (f !== undefined) { return n; } else { return f(n); }
}
console.log(apply(21));
`, "NT2001", "possibly undefined");
  });
});


/*
 * THE SECOND CIRCULAR HINT — a MODULE-LEVEL binding some function assigns.
 *
 * `closureMayAssign` drops every fact about a name that any nested function body assigns,
 * because a call between the proof and the read can rebind it (`docs/divergences.md`
 * records the case and the reasoning). The refusal is right. What was wrong was the hint:
 *
 *     let g: string | undefined = "abc";
 *     function clear(): void { g = undefined; }
 *     function f(): void { if (g) { console.log(g.length); } }
 *
 *     error[NT2001]: 'g' is possibly undefined
 *       = help: … or prove it non-nullish first — `if (g) { … }`, an early `return`, or `!`
 *
 * The guard it asks for is on the same line. `docs/divergences.md` flagged this as "read
 * as circular twice, in two different bugs" and left it open; `mutable-narrowing` closed
 * the OTHER one (a `@@mutable` receiver) with truthful wording. This is the same fix on
 * the same message, for the root-name half rather than the dotted half.
 *
 * The spellings it now recommends are COMPILED against node below. That matters
 * especially here: the bound local and the guard are NOT the same program under mutation
 * — `const v = g` reads `g` once, before any call can change it — so the advice has to be
 * checked against the oracle, not reasoned about.
 */
describe("narrowing — a module-level binding a function assigns", () => {
  const WRITTEN_ELSEWHERE = `
let g: string | undefined = "abc";
function clear(): void { g = undefined; }
function f(): void { if (g) { console.log(g.length); } else { console.log("absent"); } }
f(); clear(); f();
`;

  test("REFUSED — the guard records nothing, because a call could rebind it", () => {
    expectRejected(WRITTEN_ELSEWHERE, "NT2001", "'g' is possibly undefined");
  });

  test("the hint no longer recommends the guard that is already written", () => {
    let err: unknown;
    try { sourceToIR(WRITTEN_ELSEWHERE); } catch (e) { err = e; }
    const hint = (err as NTError).diag.hint ?? "";
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toContain("prove it non-nullish first");
    // It says WHY, names the writer it found, and gives a line that builds.
    expect(hint).toContain("clear");
    expect(hint).toContain("const v = g;");
  });

  test("the hint's `bind it first` spelling compiles and matches node", async () => {
    await expectNode(`
let g: string | undefined = "abc";
function clear(): void { g = undefined; }
function f(): void {
  const v = g;
  if (v) { console.log(v.length); } else { console.log("absent"); }
}
f(); clear(); f();
`);
  });

  test("the hint's `?.` spelling compiles and matches node", async () => {
    await expectNode(`
let g: string | undefined = "abc";
function clear(): void { g = undefined; }
function f(): void { console.log(g?.length ?? -1); }
f(); clear(); f();
`);
  });

  // The mutation guard. A module-level binding NOTHING assigns narrows normally, and
  // there the original hint is the right one — widen the new wording to every nullable
  // read and this fails.
  test("a binding no function assigns narrows as usual (and keeps the original hint)", async () => {
    await expectNode(`
let g: string | undefined = "abc";
function f(): void { if (g) { console.log(g.length); } else { console.log("absent"); } }
f();
`);
    let err: unknown;
    try { sourceToIR(`
let g: string | undefined = "abc";
function f(): void { console.log(g.length); }
f();
`); } catch (e) { err = e; }
    const hint = (err as NTError).diag.hint ?? "";
    expect(hint).toContain("prove it non-nullish first");
  });
});

/*
 * THE THIRD CIRCULAR HINT — `bind \`const v = n;\`` where `n` is a `const`.
 *
 * The union-field advice ends with a clause about the OTHER way a written tag test can
 * fail to narrow: the root is reassigned between the test and the read, which drops the
 * fact. That is real, and when it applies the wording is the right one. It was appended
 * to EVERY stable receiver, though, including ones nothing can possibly reassign:
 *
 *     const n: Node = { kind: "num", value: 1 };
 *     console.log(n.value);
 *
 *     … — and if that test is already written, 'n' is assigned between it and this read
 *     …; bind `const v = n;` before the test and narrow `v`
 *
 * `n` is a `const`. It is not assigned anywhere, it cannot be, and `const v = n;` is a
 * rename of a binding that already has the property the advice is asking for. The clause
 * states a cause that is impossible and prescribes a no-op — the shape this file already
 * closed twice, in `narrowing 5` and in the module-level-binding block above.
 *
 * A `const` root is the exact predicate: the fact-dropping rules that clause describes
 * (`unstableNames`, `closureMayAssign`) both key on ASSIGNMENT, and neither can fire for
 * a binding no assignment is legal on. So the clause is dropped there and kept everywhere
 * else. What remains is compiled against node below — the reason the clause was worth
 * removing is that the advice above it is already correct and complete.
 */
describe("narrowing — the union-field hint does not blame a `const` for being reassigned", () => {
  const CONST_ROOT = `
type Node = { kind: "num"; value: number } | { kind: "str"; text: string };
const n: Node = { kind: "num", value: 1 };
console.log(n.value);
`;

  test("REFUSED — an un-narrowed union field read is still an error", () => {
    expectRejected(CONST_ROOT, "NT2001", "Property 'value' does not exist");
  });

  test("the hint does not claim the `const` is assigned, and does not prescribe `const v = n;`", () => {
    let err: unknown;
    try { sourceToIR(CONST_ROOT); } catch (e) { err = e; }
    const text = formatDiagnostic((err as NTError).diag);
    expect(text).toContain("narrow it first");
    expect(text).not.toContain("is assigned between it and this read");
    expect(text).not.toContain("const v = n;");
  });

  test("the advice it DOES give compiles and matches node", async () => {
    await expectNode(`
type Node = { kind: "num"; value: number } | { kind: "str"; text: string };
const n: Node = { kind: "num", value: 1 };
if (n.kind === "num") { console.log(n.value); } else { console.log(n.text); }
`);
  });

  // The mutation guard. A `let` root really can be reassigned between the test and the
  // read, so the clause is TRUE there and must survive — narrow this to "never say it"
  // and this fails.
  test("a `let` root still gets the reassignment clause", () => {
    let err: unknown;
    try { sourceToIR(`
type Node = { kind: "num"; value: number } | { kind: "str"; text: string };
let n: Node = { kind: "num", value: 1 };
console.log(n.value);
`); } catch (e) { err = e; }
    const text = formatDiagnostic((err as NTError).diag);
    expect(text).toContain("is assigned between it and this read");
    expect(text).toContain("const v = n;");
  });
});
