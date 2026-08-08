/*
 * Optional ELEMENT access — `a?.[i]`.
 *
 * The sibling of optional member access (`a?.b`, which already worked). Both are pure
 * JS semantics, so node is the oracle for every runtime-visible case here — nothing
 * below was reasoned out; each expected value was read off `node` first (scratch probe,
 * this lane) and is then re-asserted differentially by `expectNode`.
 *
 * test262 is NOT vendored into this repo and no network was available, so the behavior
 * list is DERIVED from the operator's specification rather than mined. The shapes chosen
 * mirror what test262's `optional-chaining/` directory is known to cover: nullish base
 * (both `null` and `undefined`), NON-EVALUATION of the index on short-circuit, the
 * whole-chain short-circuit past trailing links, `??` interaction, and a falsy present
 * element (the case a naive `|| default` gets wrong).
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
});
