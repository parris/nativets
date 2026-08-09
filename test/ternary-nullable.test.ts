/*
 * THE TERNARY JOIN with a nullish arm — `cond ? x : undefined`.
 *
 * `Checker.type`'s `ConditionalExpr` case required the two arms to have the
 * IDENTICAL type (`if (a !== b) throw`). That is not TypeScript's rule: the
 * conditional operator's type is the UNION of its branch types, so
 * `cond ? tag : undefined` is `string | undefined` — which nativets already has a
 * representation for (`?Ustring`, the A2 [tag,value] box).
 *
 * This is the single most-cited blocker in docs/self-hosting.md's frontier table:
 * `src/ast.ts:244`
 *
 *     export function classTag(t: Ty): string | undefined {
 *       ...
 *       return isIdentifier(tag) ? tag : undefined;
 *     }
 *
 * blocked NINE of the twelve compiler modules through the whole-program link.
 *
 * PROVENANCE. There is no `microsoft/TypeScript` checkout on this machine (five
 * lanes have confirmed it), so the TS-TYPING cases below are DERIVED from the
 * specification rule rather than mined from `tests/cases/conformance/expressions/
 * conditonalOperator/`. Every RUNTIME assertion is differential against node, which
 * is the oracle for stdout AND exit code. test262 has no coverage to borrow here:
 * its conditional-operator tests (`language/expressions/conditional/`) are about
 * evaluation order and coercion of the TEST, both of which already pass — the join
 * is a static-type question test262 does not ask.
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

function rejection(source: string): string {
  let err: unknown;
  try { sourceToIR(source); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NTError);
  return formatDiagnostic((err as NTError).diag, source);
}

function expectRejected(source: string, code: string, needle: string): void {
  const text = rejection(source);
  expect(text).toContain(code);
  expect(text).toContain(needle);
}

describe("1 — a present arm joins with `undefined`", () => {
  /*
   * THE ACCEPTANCE GATE, minimized from `src/ast.ts:244` (`classTag`). Written so
   * node can run it unchanged: the join's result flows straight into the declared
   * `string | undefined` return type, which the nullable-assignability lane already
   * accepts once the join produces a type at all.
   */
  test("`b ? s : undefined` is `string | undefined` — the ast.ts:244 shape", async () => {
    await expectNode(`
function classTag(t: string): string | undefined {
  const tag = t.slice(0, 3);
  return tag === "Pnt" ? tag : undefined;
}
const a = classTag("Pnt{x:number}");
const b = classTag("{x:number}");
console.log(a === undefined ? "none" : a, b === undefined ? "none" : b);
`);
  });

  // The arms the other way round — the join is symmetric, and `undefined` first is
  // the spelling a guard clause produces (`x === "" ? undefined : x`).
  test("`b ? undefined : s` joins the same way", async () => {
    await expectNode(`
function f(b: boolean): string | undefined { return b ? undefined : "yes"; }
const a = f(true);
const c = f(false);
console.log(a === undefined ? "none" : a, c === undefined ? "none" : c);
`);
  });

  test("the join works for `number` and for `boolean` too", async () => {
    await expectNode(`
function n(b: boolean): number | undefined { return b ? 41 + 1 : undefined; }
function t(b: boolean): boolean | undefined { return b ? false : undefined; }
const x = n(true), y = n(false), p = t(true), q = t(false);
console.log(x === undefined ? -1 : x, y === undefined ? -1 : y);
console.log(p === undefined ? "none" : (p ? "T" : "F"), q === undefined ? "none" : (q ? "T" : "F"));
`);
  });
});

describe("2 — a present arm joins with `null`", () => {
  test("`b ? s : null` is `string | null`", async () => {
    await expectNode(`
function f(b: boolean): string | null { return b ? "yes" : null; }
const a = f(true);
const c = f(false);
console.log(a === null ? "none" : a, c === null ? "none" : c);
`);
  });

  // The nullish arm decides WHICH encoding (`?N` vs `?U`), so the two must not be
  // interchangeable: a `?N` result compared against `undefined` stays refused.
  test("the `null` arm produces a `?N`, not a `?U`", () => {
    expectRejected(`
function f(b: boolean): string | undefined { return b ? "yes" : null; }
console.log(f(true));
`, "NT2001", "null");
  });
});

describe("3 — an ALREADY-nullable arm absorbs its own nullish literal", () => {
  test("`?Ustring` joined with `undefined` stays `?Ustring`", async () => {
    await expectNode(`
function g(b: boolean): string | undefined { return b ? "hi" : undefined; }
function f(b: boolean, c: boolean): string | undefined { return c ? g(b) : undefined; }
const a = f(true, true), z = f(true, false);
console.log(a === undefined ? "none" : a, z === undefined ? "none" : z);
`);
  });

  /*
   * ...but only its OWN. `?Nstring` joined with `undefined` is `string | null |
   * undefined` — three arms, which the two-slot [tag,value] encoding cannot carry,
   * and which `parseType` refuses in its written form too. Refused, not guessed at.
   */
  test("REFUSED: a `?N` arm joined with `undefined` is a three-arm union", () => {
    expectRejected(`
function g(b: boolean): string | null { return b ? "hi" : null; }
function f(b: boolean, c: boolean): string | null { return c ? g(b) : undefined; }
console.log(f(true, true));
`, "NT2001", "Ternary branches differ");
  });
});

describe("4 — the join does NOT over-accept", () => {
  // The identity check this replaced existed to refuse unrepresentable unions. Every
  // refusal it was carrying has to survive, or the join is a silent wrong answer.
  test("two unrelated present arms are still refused", () => {
    expectRejected(`const x: number = true ? 1 : "s";`, "NT2001", "Ternary branches differ: number vs string");
  });

  test("`undefined` joined with `null` is still refused", () => {
    expectRejected(`
function f(b: boolean): string | undefined { return b ? undefined : null; }
console.log(f(true));
`, "NT2001", "Ternary branches differ: undefined vs null");
  });

  /*
   * DELIBERATELY still refused: `T` and `?U T`. It is a legal TypeScript union, but it
   * is also the exact pair `thisNarrowHint` detects, and that hint is the carrier of the
   * "narrowing does not reach a field of `this`" diagnostic (test/nullable-assign.test.ts
   * describe 4). Joining it here would replace a targeted, actionable refusal with a
   * return-type mismatch three lines later. Widening to it means relocating that hint
   * first — a separate behavior, not this one.
   */
  test("REFUSED, deliberately: a present arm joined with an already-nullable arm", () => {
    expectRejected(`
function g(b: boolean): string | undefined { return b ? "hi" : undefined; }
function f(b: boolean): string { return b ? g(b) : "none"; }
console.log(f(true));
`, "NT2001", "Ternary branches differ");
  });

  test("and the `this`-narrowing hint it carries still fires", () => {
    expectRejected(`
class C {
  s?: string;
  get(): string { return this.s === undefined ? "none" : this.s; }
}
console.log(new C().get());
`, "NT2001", "narrowing does not reach a field of \`this\`");
  });
});

describe("5 — the joined value is a first-class nullable", () => {
  // The join's result has to be usable everywhere a nullable is, not just at a
  // `return`: bound to a `const`, passed as an argument, narrowed by a guard.
  test("the result binds, passes as an argument, and narrows", async () => {
    await expectNode(`
function show(s: string | undefined): string { return s === undefined ? "none" : s.toUpperCase(); }
const b = true;
const a = b ? "abc" : undefined;
const c = b ? undefined : "abc";
console.log(show(a), show(c));
`);
  });

  /*
   * ...and it lands in the RIGHT refusal where one exists. Widening a join makes more
   * nullables flow into more expressions, and one of the places they can flow is `===`
   * between two of them — which codegen has no arm for, and which was refused
   * (`NT1009`) precisely because comparing the two [tag,value] boxes compared PRESENCE
   * and answered `true` for `1 === 2`. Pinned here because this lane is what makes that
   * shape easy to reach without ever writing a nullable annotation.
   */
  test("two joined nullables compared with `===` hit NT1009, not a wrong answer", () => {
    expectRejected(`
const b = true;
const p = b ? "x" : undefined;
const q = b ? "y" : undefined;
console.log(p === q);
`, "NT1009", "would compare PRESENCE");
  });

  // An OBJECT arm: the present value is a heap pointer, so the box carries a pointer
  // slot rather than a double. Same `coerce`, different `toSlot`.
  test("an object arm boxes into a nullable object", async () => {
    await expectNode(`
interface P { v: number }
function f(b: boolean): P | undefined { return b ? { v: 7 } : undefined; }
const a = f(true), z = f(false);
console.log(a === undefined ? -1 : a.v, z === undefined ? -1 : z.v);
`);
  });
});
