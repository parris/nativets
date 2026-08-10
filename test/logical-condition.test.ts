/*
 * `&&` / `||` IN TRUTHINESS POSITION — mismatched operand types.
 *
 * `Checker.infer`'s `LogicalExpr` case ends with
 *
 *     if (l === "boolean" && r === "boolean") return "boolean";
 *     if (l === r && (l === "number" || l === "string")) return l;
 *     throw typeError(`'${e.op}' operands must be matching boolean/number/string`);
 *
 * which is the right rule for a VALUE: `b && s` on a `boolean` and a `string | undefined`
 * is `false | string | undefined` in TypeScript, and there is no representation for that
 * three-arm union here. But in a CONDITION the value is never materialized — only its
 * truthiness is — and
 *
 *     Boolean(a && b) === (Boolean(a) && Boolean(b))
 *     Boolean(a || b) === (Boolean(a) || Boolean(b))
 *
 * identically, for every pair of JS values. So the join that has no representation is
 * also the join nobody asked for. `!x` already accepts an operand of any type for exactly
 * this reason; this extends the same reasoning to the short-circuit pair.
 *
 * WHY IT MATTERS HERE. Five of the compiler's own functions are refused by this rule and
 * by nothing else — `src/coverage.ts`'s `renderCoverage` (`!r.compiles && r.firstError`),
 * `src/driver.ts`'s `buildBinary`, and three more — all of them ordinary `if` conditions
 * that node runs and `tsc` accepts.
 *
 * PROVENANCE. test262 `language/expressions/logical-and/` and `logical-or/` fix the
 * evaluation-order and short-circuit semantics asserted in describe 3 (the right operand
 * must not be evaluated when the left decides); the TYPING half is derived from the
 * TypeScript rule (`&&` is `L-falsy | R`) rather than mined, since there is no
 * `microsoft/TypeScript` checkout on this machine. Every runtime assertion is
 * differential against node.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError, formatDiagnostic } from "../src/diagnostics.ts";

async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

function expectRejected(source: string, code: string, needle: string): void {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  const text = formatDiagnostic((err as NTError).diag, source);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

describe("1 — mismatched operands are fine in an `if` condition", () => {
  test("`b && s` on a boolean and a `string | undefined`", async () => {
    await expectNode(`
function f(b: boolean, s: string | undefined): string {
  if (b && s) return "both";
  return "no";
}
console.log(f(true, "x"), f(true, undefined), f(false, "x"), f(false, undefined));
`);
  });

  // `src/coverage.ts:64` — `if (p.imports?.length || p.textImports?.length)`. Both
  // operands are `number | undefined`, which the value rule rejects even though they
  // MATCH, because a nullable is not one of the three named types.
  test("`n || m` on two `number | undefined`s — the coverage.ts:64 shape", async () => {
    await expectNode(`
function pick(a: number | undefined, b: number | undefined): string {
  if (a || b) return "some";
  return "none";
}
console.log(pick(1, undefined), pick(undefined, 2), pick(0, undefined), pick(undefined, undefined), pick(0, 0));
`);
  });

  // An OBJECT-typed operand: always truthy, and the falsy case is the absent box.
  // `src/coverage.ts:238` is this shape (`!report.compiles && report.firstError`).
  test("`!b && obj` on a boolean and an optional object", async () => {
    await expectNode(`
interface E { code: string }
function f(compiles: boolean, err: E | undefined): string {
  if (!compiles && err) return "err";
  return "ok";
}
console.log(f(false, { code: "NT1" }), f(true, { code: "NT1" }), f(false, undefined));
`);
  });
});

describe("2 — it composes, and reaches every truthiness position", () => {
  test("nested: `a && (b || c)` and `(a || b) && c`", async () => {
    await expectNode(`
function f(a: boolean, b: string | undefined, c: number | undefined): string {
  if (a && (b || c)) return "L";
  if ((b || c) && a) return "R";
  return "-";
}
console.log(f(true, "x", undefined), f(true, undefined, 5), f(true, undefined, undefined), f(false, "x", undefined));
`);
  });

  test("`while`, `for`, `?:` and `!` all take the same rule", async () => {
    await expectNode(`
function f(n: number, s: string | undefined): string {
  let i = 0;
  while (i < n && s) { i = i + 1; }
  for (let j = 0; j < n && s; j = j + 1) { i = i + 10; }
  const t = (n > 0 && s) ? "y" : "n";
  const u = !(n > 0 && s);
  return i + " " + t + " " + u;
}
console.log(f(2, "x"), f(2, undefined), f(0, "x"));
`);
  });
});

describe("3 — short-circuit evaluation is unchanged", () => {
  /*
   * test262 `language/expressions/logical-and/S11.11.1_A3_T*.js` and
   * `logical-or/S11.11.2_A3_T*.js`: the right operand is evaluated only when the left
   * does not decide. Pinned because the new path calls `truthyOf` on the right operand,
   * and calling it eagerly (outside the branch) would be a visible side-effect change,
   * not a typing one.
   */
  test("the right operand does not run when the left decides", async () => {
    await expectNode(`
let calls = 0;
function bump(): string | undefined { calls = calls + 1; return "x"; }
function f(b: boolean): string { if (b && bump()) return "T"; return "F"; }
function g(b: boolean): string { if (b || bump()) return "T"; return "F"; }
console.log(f(false), calls);
console.log(f(true), calls);
console.log(g(true), calls);
console.log(g(false), calls);
`);
  });
});

describe("4 — the VALUE rule is untouched", () => {
  // The whole soundness argument is that nothing reads the value. Outside a condition
  // the un-representable join is still refused, with the same message.
  test("REFUSED in value position: `const x = b && s`", () => {
    expectRejected(`
function f(b: boolean, s: string | undefined): boolean { const x = b && s; return !!x; }
console.log(f(true, "x"));
`, "NT2001", "'&&' operands must be matching boolean/number/string");
  });

  test("REFUSED as a returned value too", () => {
    expectRejected(`
function f(b: boolean, s: string | undefined): string { return b && s; }
console.log(f(true, "x"));
`, "NT2001", "operands must be matching boolean/number/string");
  });

  // `a || b` on two numbers still yields the NUMBER, not a boolean — the JS
  // value-returning rule — even in a condition, because that join is representable and
  // widening it to `boolean` would be a silent change of meaning for `const n = a || b`.
  test("matching number operands still produce a number", async () => {
    await expectNode(`
function f(a: number, b: number): number { const n = a || b; return n; }
console.log(f(0, 5), f(7, 5));
`);
  });

  /*
   * The one refusal the new path has to carry ITSELF. `refuseUnboxedUnion` at the `if`
   * now sees this node's `boolean`, not the operand's type, so the operands are checked
   * inside the join — otherwise a general union's truthiness would read its [tag,value]
   * box as the value, which is a wrong answer (`0` and `""` are falsy; the box is not).
   */
  test("REFUSED: an un-narrowed general union operand", () => {
    expectRejected(`
function f(b: boolean, u: string | number): string { if (b && u) return "y"; return "n"; }
console.log(f(true, "x"));
`, "NT1009", "un-narrowed union");
  });

  /*
   * ...and the OTHER one, which this lane briefly broke and is pinned so it cannot come
   * back. A non-nullable `Map`/`Set` handle is truthy for every input, and our `.delete`
   * returns the new collection where node returns a boolean — so
   *
   *     if (flag && m.delete("zz")) { … } else { … }
   *
   * printed THEN where node prints ELSE. `rejectVacuousCollectionTest` is what stops
   * that, and the `if` call site passes it the WHOLE condition — whose type is now
   * `boolean`, so it sees nothing. Widening the position without moving the guard down
   * to the operands re-opened a silent wrong answer that the VALUE rule had been
   * accidentally covering. Measured on the real binary before the fix, not reasoned about.
   */
  test("REFUSED: a `Map` handle as an operand — node takes the other arm", () => {
    expectRejected(`
const m = new Map<string, number>().set("a", 1);
const flag = true;
if (flag && m.delete("zz")) { console.log("THEN"); } else { console.log("ELSE"); }
`, "NT1606", "returns a NEW map, not a boolean");
  });

  test("REFUSED: a bare non-nullable Set handle as an operand is vacuous", () => {
    expectRejected(`
const s = new Set<number>().add(1);
const flag = true;
if (flag && s) { console.log("y"); }
`, "NT1606", "always truthy");
  });

  // `??` is a VALUE operator, not a truthiness test, so a condition does not license a
  // mismatched join for it.
  test("REFUSED: `??` in a condition keeps its own rule", () => {
    expectRejected(`
function f(a: string | undefined, b: number): string { if (a ?? b) return "y"; return "n"; }
console.log(f(undefined, 1));
`, "NT2001", "?? branches differ");
  });
});

describe("5 — narrowing across the short circuit still holds", () => {
  // The right operand is typed under the left's facts, and the CONSEQUENT under both.
  // That plumbing is shared with the value path; this pins that routing a condition
  // through `typeCond` did not bypass it.
  test("`s !== undefined && s.length > 0` still narrows `s` in the branch", async () => {
    await expectNode(`
function f(s: string | undefined): string {
  if (s !== undefined && s.length > 0) return s.toUpperCase();
  return "-";
}
console.log(f("hi"), f(""), f(undefined));
`);
  });

  /*
   * THE SHAPE docs/divergences.md CALLED OUT AS "still refused, on purpose": a bare
   * nullable as a `&&` operand, `if (e && e.kind === "A")`. Its reason was the VALUE
   * ("node's `a && b` evaluates to `a` when `a` is falsy, so the expression's type is a
   * general union"), which is true and is exactly the thing a condition never asks for —
   * so the refusal was wider than its own justification. Both spellings the doc names are
   * pinned here, and both agree with node.
   */
  test("`if (e && e.kind === \"A\")` — the idiomatic guard, on a nullable union", async () => {
    await expectNode(`
interface A { kind: "A"; n: number }
interface B { kind: "B"; s: string }
type E = A | B;
function f(e: E | undefined): string {
  if (e && e.kind === "A") return "A" + e.n;
  return "-";
}
console.log(f({ kind: "A", n: 3 }), f({ kind: "B", s: "x" }), f(undefined));
`);
  });

  test("`if (o && o.n > 1)` — the same on a nullable RECORD", async () => {
    await expectNode(`
interface R { n: number }
function g(o: R | undefined): string {
  if (o && o.n > 1) return "big";
  return "-";
}
console.log(g({ n: 5 }), g({ n: 0 }), g(undefined));
`);
  });

  test("a nullable operand narrows the branch it guards", async () => {
    await expectNode(`
function f(b: boolean, s: string | undefined): string {
  if (b && s) return s.toUpperCase();
  return "-";
}
console.log(f(true, "hi"), f(true, undefined), f(false, "hi"));
`);
  });
});
