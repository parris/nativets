/*
 * Optional ELEMENT access — `a?.[i]`.
 *
 * The sibling of optional member access (`a?.b`, which already worked). Both are pure
 * JS semantics, so node is the oracle for every runtime-visible case here — nothing
 * below was reasoned out; each expected value was read off `node` first (scratch probe,
 * this lane) and is then re-asserted differentially by `expectNode`.
 *
 * The behavior list was MINED from test262 `test/language/expressions/optional-chaining/`
 * (tc39/test262 @ main), not invented. Each borrowed case cites its source file below.
 * The files drawn on:
 *
 *   short-circuiting.js                  — `a?.[++x]` leaves `x` alone
 *   member-expression.js                 — `[1,2]?.[1]`, `` `hello`?.[0] ``, `arr[i]?.a`
 *   optional-expression.js               — recursive `obj?.a?.b`
 *   static-semantics-simple-assignment.js— an optional chain is not an assignment target
 *   update-expression-postfix.js         — nor a `++`/`--` target
 *
 * Mining paid for itself: the last two are EARLY errors in node (SyntaxError, before a
 * line runs) and nativets ACCEPTED both, compiling `b?.[0] = 7` on a mutable `Uint8Array`
 * into a real store. No hand-written list would have contained them.
 *
 * The remaining shapes — nullish base as both `null` and `undefined`, whole-chain
 * short-circuit past trailing links, `??` interaction, and a falsy present element (the
 * case a naive `|| default` gets wrong) — round out the operator's surface.
 *
 * The one thing `?.` does NOT change is the INDEX rule: it guards the BASE being nullish,
 * nothing else. A present base indexed out of range behaves exactly as `a[i]` does —
 * nativets refuses/panics (Stage 41, docs/divergences.md), where node yields `undefined`.
 * That case is therefore asserted BY FIAT, not against node, and is called out below.
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte. */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Assert the source is REFUSED with `code`, and that the message mentions `needle`. */
function expectRejected(source: string, code: string, needle: string): void {
  let err: NTError | undefined;
  try { sourceToIR(source); } catch (e) { err = e as NTError; }
  expect(err).toBeInstanceOf(NTError);
  expect(err!.diag.code).toBe(code);
  expect(err!.diag.message).toContain(needle);
}

describe("optional element access `a?.[i]`", () => {
  test("an absent base short-circuits to undefined", async () => {
    await expectNode(`
let a: number[] | undefined = undefined;
console.log(a?.[0]);
`);
  });

  test("a present base reads the element", async () => {
    await expectNode(`
let a: number[] | undefined = [7, 8];
console.log(a?.[1]);
`);
  });

  test("a null base short-circuits too", async () => {
    await expectNode(`
let a: number[] | null = null;
console.log(a?.[0]);
`);
  });

  /*
   * THE case that distinguishes a real short-circuit from "evaluate then discard".
   * node does not evaluate the index at all when the base is nullish, which is
   * observable through a side effect. Lowering-wise this is why the index is emitted
   * INSIDE the continuation block, past the nullish guard.
   */
  test("the index is NOT evaluated when the base is nullish", async () => {
    await expectNode(`
function idx(): number { console.log("index evaluated"); return 0; }
let a: number[] | undefined = undefined;
console.log(a?.[idx()]);
`);
  });

  test("the index IS evaluated, once, when the base is present", async () => {
    await expectNode(`
function idx(): number { console.log("index evaluated"); return 1; }
let a: number[] | undefined = [7, 8];
console.log(a?.[idx()]);
`);
  });

  test("a falsy present element is kept, not replaced", async () => {
    await expectNode(`
let a: number[] | undefined = [0, 5];
console.log(a?.[0] ?? 99);
`);
  });

  test("?? supplies the default only when the chain short-circuited", async () => {
    await expectNode(`
let absent: number[] | undefined = undefined;
let present: number[] | undefined = [7, 8];
console.log(absent?.[0] ?? 99, present?.[0] ?? 99);
`);
  });

  /*
   * The WHOLE chain short-circuits, not just the guarded link: a trailing non-optional
   * `.name` after a short-circuited `?.[0]` is never evaluated, and the result is still
   * `undefined` rather than a crash on reading a field of nothing.
   */
  test("a trailing member after a short-circuited index is not evaluated", async () => {
    await expectNode(`
type P = { name: string };
let ps: P[] | undefined = undefined;
console.log(ps?.[0].name);
`);
  });

  test("the same chain reads through when the base is present", async () => {
    await expectNode(`
type P = { name: string };
let ps: P[] | undefined = [{ name: "ok" }];
console.log(ps?.[0].name);
`);
  });

  // The mirror mix: an optional MEMBER link followed by an index link. Both orders have
  // to be one chain, which is why `isOptChainExpr` accepts either node kind on either side.
  test("an index link trailing an optional member is part of the same chain", async () => {
    await expectNode(`
type B = { xs: number[] };
let b: B | undefined = undefined;
console.log(b?.xs[0]);
`);
  });

  test("two optional index links in a row", async () => {
    await expectNode(`
type G = { rows: number[] };
let g: G | undefined = undefined;
console.log(g?.rows?.[1]);
`);
  });

  /*
   * `?.` guards the BASE, and the index rule is untouched. node prints `undefined` for an
   * out-of-range read; nativets panics exactly as it does for `a[99]` — the Stage 41
   * divergence, already documented. Asserted BY FIAT (not differential against node),
   * because the two deliberately disagree.
   *
   * The point of the test is that the guard did NOT swallow the fault into a silent
   * `undefined`: execution reaches the read (so "before" prints), then aborts loudly
   * before "after". Getting this wrong would turn a memory-safety panic into exactly the
   * kind of silent wrong answer the prime directive forbids.
   */
  test("`?.` does not soften the index rule: a present base out of range still panics", async () => {
    const r = await compileAndRun(`
let a: number[] | undefined = [1, 2];
console.log("before");
console.log(a?.[99]);
console.log("after");
`);
    expect(r.stdout).toContain("before");
    expect(r.stdout).not.toContain("after");
    expect(r.stdout).not.toContain("undefined");
    expect(r.exitCode).not.toBe(0);
  });

  /*
   * The same rule at COMPILE time, where length and index are both statically known.
   * Spelled with `?.[` deliberately: the static bounds check has to keep running THROUGH
   * the optional guard, which is what reusing the ordinary index-typing tail buys. Written
   * as plain `a[99]` this test would pass without the feature at all.
   */
  test("a statically-known out-of-range index under `?.` is refused at compile time", () => {
    expectRejected(
      `
const a: number[] | undefined = [1, 2];
console.log(a?.[99]);
`,
      "NT2002",
      "out of bounds",
    );
  });

  /*
   * The mirror of the `a.b`-on-a-nullable rule: indexing a possibly-nullish base WITHOUT
   * `?.` is refused, and the hint names the `?.[` spelling. Without this the feature would
   * make the unguarded read silently legal.
   */
  test("indexing a nullable base without `?.` is refused, and the hint names `?.[`", () => {
    expectRejected(
      `
let a: number[] | undefined = [1, 2];
console.log(a[0]);
`,
      "NT2001",
      "possibly undefined",
    );
  });

  /* ================================================================
   * Mined from test262 `test/language/expressions/optional-chaining/`.
   * ================================================================ */

  /*
   * test262 `short-circuiting.js`, first assertion, transcribed:
   *
   *     const a = undefined; let x = 1;
   *     a?.[++x]            // short-circuiting.
   *     assert.sameValue(1, x);
   *
   * The same property as the `idx()` test above, but in test262's own spelling — the
   * index is an INCREMENT, so "evaluated and discarded" and "not evaluated" differ by
   * exactly the value of `x`, with no I/O involved.
   */
  test("test262 short-circuiting.js — `a?.[++x]` does not evaluate the index", async () => {
    await expectNode(`
const a: number[] | undefined = undefined;
let x = 1;
a?.[++x];
console.log(x);
`);
  });

  /*
   * test262 `member-expression.js`:
   *     assert.sameValue(2, [1, 2]?.[1]);          //   ArrayLiteral base
   *     assert.sameValue('h', \`hello\`?.[0]);       //   TemplateLiteral base
   *
   * A base that is statically NON-nullable still has to read through the `?.` link
   * rather than being rejected or short-circuited. This is the case a lowering that
   * assumes "optional implies nullable box" gets wrong.
   */
  test("test262 member-expression.js — `?.[i]` on a non-nullable literal base reads through", async () => {
    await expectNode(`
console.log([1, 2]?.[1]);
console.log(\`hello\`?.[0]);
`);
  });

  /*
   * test262 `member-expression.js`, the `MemberExpression [ Expression ]` block:
   *     const arr = [{a: 33}];
   *     assert.sameValue(33, arr[0]?.a);
   * A plain index feeding an optional MEMBER — the reverse nesting from `b?.xs[0]`.
   */
  test("test262 member-expression.js — a plain index feeding an optional member", async () => {
    await expectNode(`
type A = { a: number };
const arr: A[] = [{ a: 33 }];
console.log(arr[0]?.a);
`);
  });

  /*
   * test262 `optional-expression.js` — `OptionalExpression OptionalChain`, i.e. a chain
   * whose head is itself a chain. Spelled here with two INDEX links, the element-access
   * analogue of that file's `obj?.a?.b`.
   */
  test("test262 optional-expression.js — a chain whose head is itself an optional chain", async () => {
    await expectNode(`
const rows: number[][] | undefined = [[1, 2], [3, 4]];
console.log(rows?.[1]?.[0]);
`);
  });

  /*
   * test262 `static-semantics-simple-assignment.js` (negative, phase: parse, SyntaxError):
   *
   *     Static Semantics: IsValidSimpleAssignmentTarget
   *       LeftHandSideExpression: OptionalExpression   ->   Return false.
   *
   * node refuses `obj?.a = 33` before executing a line. nativets USED TO COMPILE the
   * element form: `Uint8Array` is genuinely mutable here, so `b?.[0] = 7` satisfied every
   * type rule and lowered to a real store — a program node rejects, silently accepted.
   * A nullable base merely masked it behind an unrelated NT1606 about array immutability.
   *
   * The refusal is in the PARSER, because this is syntax, not typing: no receiver type
   * makes it legal.
   */
  test("test262 static-semantics-simple-assignment.js — `a?.[i] = v` is refused", () => {
    expectRejected(
      `
const b: Uint8Array = new Uint8Array(3);
b?.[0] = 7;
`,
      "NT0001",
      "write position",
    );
  });

  // The member spelling of the same rule — `obj?.a = 33` verbatim from that file's body.
  // It was accepted on main too, so this pins the pre-existing half of the hole.
  test("test262 static-semantics-simple-assignment.js — `a?.b = v` is refused", () => {
    expectRejected(
      `
// @@mutable
type O = { a: number };
const o: O = { a: 1 };
o?.a = 33;
`,
      "NT0001",
      "write position",
    );
  });

  /*
   * test262 `update-expression-postfix.js` (negative, phase: parse, SyntaxError):
   * "optional chaining is forbidden in write contexts" — `a?.b++`. `++` is a read AND a
   * write, so it falls under the same IsValidSimpleAssignmentTarget rule.
   */
  test("test262 update-expression-postfix.js — `a?.[i]++` is refused", () => {
    expectRejected(
      `
const b: Uint8Array = new Uint8Array(3);
b?.[0]++;
`,
      "NT0001",
      "write position",
    );
  });
});
