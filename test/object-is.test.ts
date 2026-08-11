/*
 * `Object.is` — SameValue (ECMA-262 7.2.10), the OTHER equality.
 *
 * There are three equalities in the language and they differ at exactly two pairs:
 *
 *              NaN vs NaN     +0 vs -0
 *   ===          false          true
 *   SameValueZero  true         true      <- Array#includes, Set/Map keys
 *   SameValue      true         false     <- Object.is
 *
 * So `Object.is` is NOT `Array#includes`'s comparator with a different spelling; the two
 * disagree on signed zero, in opposite directions. `test/array-includes.test.ts` pins the
 * SameValueZero side ("+0 and -0 are the same value"); this file pins SameValue, and the
 * cross-check at the bottom asserts the two answer DIFFERENTLY on the same pair. Getting
 * that backwards is the obvious failure mode and it would be silent.
 *
 * Before this, `Object.is` was refused as `NT1002` with the hint "object literals need the
 * heap value model" — which is not true of a STATIC method taking two primitives. No
 * object literal is involved. `Object.is` is also the natural `-0` probe, so its absence
 * pushed tests onto the clumsier `1 / x === -Infinity`.
 *
 * Cases mined from test262 test/built-ins/Object/is/.
 * Every case is differential against node, the specification.
 */

import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** Compile+run ours and assert stdout AND exit code match `node` on the same source. */
async function matchesNode(src: string): Promise<string> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

describe("Object.is is SameValue", () => {
  // THE HALF `===` GETS WRONG. test262: built-ins/Object/is/comparison-with-NaN.js
  test("NaN is SameValue with NaN, where === says false", async () => {
    expect(await matchesNode([
      "console.log(Object.is(NaN, NaN));",
      "console.log(NaN === NaN);",
      "console.log(Object.is(0 / 0, Number.NaN));",
      'console.log(Object.is(Number("x"), NaN));',
      "console.log(Object.is(NaN, 0), Object.is(0, NaN));",
      "",
    ].join("\n"))).toBe("true\nfalse\ntrue\ntrue\nfalse false\n");
  });

  /*
   * THE HALF `===` GETS RIGHT AND SameValueZero GETS "WRONG".
   * test262: built-ins/Object/is/comparison-with-zeroes.js. This is the one that makes
   * `Object.is` worth having: it is the only equality here that can SEE a negative zero.
   */
  test("+0 is NOT -0, in both argument orders", async () => {
    expect(await matchesNode([
      "console.log(Object.is(0, -0), Object.is(-0, 0));",
      "console.log(Object.is(0, 0), Object.is(-0, -0));",
      "console.log(0 === -0);",
      "console.log(Object.is(-0, 0 * -1), Object.is(0, 0 * -1));",
      "",
    ].join("\n"))).toBe("false false\ntrue true\ntrue\ntrue false\n");
  });

  // Ordinary numbers: SameValue agrees with `===` everywhere else, infinities included.
  test("every other number agrees with ===", async () => {
    expect(await matchesNode([
      "console.log(Object.is(1, 1), Object.is(1, 2), Object.is(-1, -1));",
      "console.log(Object.is(Infinity, Infinity), Object.is(Infinity, -Infinity));",
      "console.log(Object.is(-Infinity, -Infinity), Object.is(Infinity, 0));",
      "console.log(Object.is(0.1 + 0.2, 0.3), Object.is(0.1 + 0.2, 0.30000000000000004));",
      "",
    ].join("\n"))).toBe("true false true\ntrue false\ntrue false\nfalse true\n");
  });

  // Strings compare by VALUE, not by pointer — an interned literal and a built string are
  // the same value. test262: built-ins/Object/is/comparison-with-string.js
  test("strings compare by value, including a built one", async () => {
    expect(await matchesNode([
      'console.log(Object.is("a", "a"), Object.is("a", "b"), Object.is("", ""));',
      'const built = "a" + "b";',
      'console.log(Object.is(built, "ab"), Object.is(built, "ba"));',
      'console.log(Object.is("NaN", "NaN"));',
      "",
    ].join("\n"))).toBe("true false true\ntrue false\ntrue\n");
  });

  test("booleans", async () => {
    expect(await matchesNode([
      "console.log(Object.is(true, true), Object.is(false, false));",
      "console.log(Object.is(true, false), Object.is(false, true));",
      "console.log(Object.is(1 > 0, 2 > 1));",
      "",
    ].join("\n"))).toBe("true true\nfalse false\ntrue\n");
  });

  // Different TYPES are never SameValue — and notably `Object.is` does NOT coerce, so
  // `Object.is(0, false)` is false where `0 == false` is true.
  // test262: built-ins/Object/is/comparison-different-types.js
  test("different types are never SameValue, and nothing is coerced", async () => {
    expect(await matchesNode([
      'console.log(Object.is(1, "1"), Object.is("1", 1));',
      "console.log(Object.is(0, false), Object.is(false, 0));",
      "console.log(Object.is(1, true), Object.is(true, 1));",
      'console.log(Object.is("", false));',
      "",
    ].join("\n"))).toBe("false false\nfalse false\nfalse false\nfalse\n");
  });

  /*
   * THE CROSS-CHECK. `Object.is` and `Array#includes` are the two comparators in this
   * compiler that both "handle NaN", and they must NOT be unified: they agree on NaN and
   * DISAGREE on signed zero. If a later edit routes one through the other, this line
   * flips.
   */
  test("SameValue and SameValueZero agree on NaN and disagree on signed zero", async () => {
    expect(await matchesNode([
      "console.log([NaN].includes(NaN), Object.is(NaN, NaN));",  // agree:    true  true
      "console.log([0].includes(-0), Object.is(0, -0));",        // DISAGREE: true  false
      "console.log([-0].includes(0), Object.is(-0, 0));",        // DISAGREE: true  false
      "console.log([NaN].indexOf(NaN), [0].indexOf(-0));",       // ===:      -1    0
      "",
    ].join("\n"))).toBe("true true\ntrue false\ntrue false\n-1 0\n");
  });

  // It is a value, so it composes: a condition, a variable, an argument.
  test("the result is an ordinary boolean", async () => {
    expect(await matchesNode([
      "const negZero = -0;",
      "if (Object.is(negZero, -0)) { console.log('is -0'); } else { console.log('not'); }",
      "const b: boolean = Object.is(negZero, 0);",
      "console.log(b, !b);",
      "console.log([true, false].includes(Object.is(1, 1)));",
      "",
    ].join("\n"))).toBe("is -0\nfalse true\ntrue\n");
  });

  /*
   * REFUSED, and the hint must say the true reason. On a non-primitive node's SameValue is
   * REFERENCE IDENTITY, which this value model does not carry — the same reason
   * `.includes` refuses a `number[][]`. The old blanket hint claimed "object literals need
   * the heap value model", which is false for a static method over two primitives; that
   * wording is exactly what this asserts is gone.
   */
  test("a non-primitive argument is refused, with a hint that names identity", () => {
    const r = rejectionOf([
      "const a: number[] = [1];",
      "const b: number[] = [1];",
      "console.log(Object.is(a, b));",
      "",
    ].join("\n"));
    expect(r?.code).toBe("NT1002");
    expect(r?.message).toContain("Object.is");
    // The hint must describe reference identity, not object literals.
    expect((r?.hint ?? "").includes("identity")).toBe(true);
    expect((r?.hint ?? "").includes("object literals need the heap value model")).toBe(false);
  });

  // node runs the refused program fine, so the refusal is a real gap and not a node bug.
  test("node answers the refused program (so the refusal is ours, deliberately)", () => {
    const r = runWithNode([
      "const a: number[] = [1];",
      "const b: number[] = [1];",
      "console.log(Object.is(a, b), Object.is(a, a));",
      "",
    ].join("\n"));
    expect([r.exitCode, r.stdout]).toEqual([0, "false true\n"]);
  });
});
