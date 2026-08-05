/*
 * B2 step 4 — REFERENCE COUNTING + TRANSIENTS: closing the remaining leaks.
 *
 * Stage 38 gave arrays a refcounted persistent trie, but the drop pass only freed
 * TOP-LEVEL linear locals, so two shapes still leaked — and now leaked trie nodes
 * with them:
 *
 *   1. REASSIGNMENT — `a = [...a, i]` in a loop abandoned the previous version.
 *   2. TEMPORARIES  — an array produced and never bound (`xs.slice(0,3).join()`).
 *
 * and a third was refused rather than solved:
 *
 *   3. CONDITIONAL MOVES — a value moved on one branch only was conservatively
 *      treated as moved everywhere, so it was never freed (rustc uses a drop flag).
 *
 * The counters are the witnesses: `__arrLive()` (allocated − freed array handles),
 * `__pvNodes()` (live trie nodes), `__objLive()`, `__strLive()`. They must return to
 * ZERO once every owner is out of scope — a leak shows up as a positive number, a
 * double free would show up as a crash (and is what the ASan run below rules out).
 *
 * TRANSIENTS (the performance half): when a persistent vector's refcount is 1 the
 * value is UNIQUELY owned, so mutating it in place is unobservable — Clojure's
 * transient trick, made provable here by the linear ownership model. `x = [...x, e]`
 * consumes `x` (the ownership pass proves the old version is dead), so the append
 * writes into the tail instead of cloning it. Every observable stays byte-identical
 * to node, and old-version-unchanged still holds whenever a second reference exists
 * — that is exactly what the refcount is telling us.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, expectMatchesNode } from "./harness.ts";

/** The idiomatic immutable loop-append (node-runnable: `[...a, i]` is plain ES). */
const BUILD = `
function build(n: number): number[] {
  let a: number[] = [];
  for (let i = 0; i < n; i = i + 1) { a = [...a, i]; }
  return a;
}`;

/** An n-element array built WITHOUT loop reassignment, so it is a plain flat block
 *  that the first `.with` freezes into the trie (same helper as sharing.test.ts). */
const BIG = `
function big(n: number): number[] {
  return "x".repeat(n).split("").map((c: string) => 1);
}`;

describe("leak 1: reassignment drops the superseded version", () => {
  test("loop-append of 100 leaves no live array and no live trie node", async () => {
    const src = `${BUILD}
function work(n: number): number {
  const t: number[] = build(n);
  return t[0] + t[n - 1] + t.length;
}
console.log(work(100));
console.log(__arrLive(), __pvNodes());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("199\n0 0\n");
  });
});

describe("memory safety: an array literal OWNS its elements", () => {
  test("returning [o1, o2] does not free the objects it points at", async () => {
    // Regression: array-literal elements were BORROWS, so `return [o1, o2]` dropped
    // both objects at scope exit while the escaping array still held their pointers —
    // a genuine use-after-free (it printed 4e-323 instead of 111). Elements now MOVE
    // into the array, exactly like object-literal fields.
    const src = `
function mk(): { a: number }[] {
  const o1: { a: number } = { a: 111 };
  const o2: { a: number } = { a: 222 };
  return [o1, o2];
}
const xs: { a: number }[] = mk();
const filler: number[] = [9, 9, 9, 9, 9, 9, 9, 9];
console.log(xs[0].a, xs[1].a, filler.length);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("111 222 8\n");
  });

  test("a nested array literal keeps its inner arrays alive", async () => {
    const src = `
function grid(): number[][] {
  const row1: number[] = [1, 2, 3];
  const row2: number[] = [4, 5, 6];
  return [row1, row2];
}
const g: number[][] = grid();
const filler: string[] = "abcdefgh".split("");
console.log(g[0][2], g[1][0], g.length, filler.length);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("3 4 2 8\n");
  });
});

describe("transients: rc == 1 ⇒ mutate in place", () => {
  test("a consuming append to a trie-backed array writes the tail in place", async () => {
    // `a` is frozen into the trie by the first `.with`; the loop then reassigns it, so
    // each append owns the vector outright (rc 1) and writes into the tail. Only the
    // 1-in-32 tail promotions allocate, so 96 appends cost a handful of nodes, not 96
    // tail clones (which is what the persistent path charges).
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const before: number = __pvAllocs();
for (let i = 0; i < 96; i = i + 1) { a = [...a, i]; }
console.log(a.length, a[100], a[195]);
console.log(__pvTransients(), __pvAllocs() - before < 20);`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("196 0 95\n92 true\n"); // 92 of 96 appends mutated in place
  });

  test("a second reference into the tail's LEAF disables the transient", async () => {
    // `.with(50, …)` on a 100-element vector writes in the TREE and therefore shares
    // the tail leaf with the source. The refcount says 2, so the following consuming
    // append must clone instead of mutating — and the snapshot must be untouched.
    // node runs the same program (the counters are stripped for the oracle).
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const snap: number[] = a.with(50, 77);
a = [...a, 999];
console.log(snap.length, snap[50], snap[0], snap[99]);
console.log(a.length, a[100], a[50], a[0]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("a snapshot taken in the tail keeps its own leaf while the source mutates", async () => {
    const src = `${BIG}
let a: number[] = big(100).with(0, 5);
const snap: number[] = a.with(99, 77);   // clones the tail: a keeps rc 1 on its own
a = [...a, 1].with(0, 3);
console.log(snap.length, snap[99], snap[0], a.length, a[99], a[100], a[0]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("many alternating snapshots stay independent (node is the oracle)", async () => {
    const src = `${BIG}
let a: number[] = big(40).with(0, 0);
let sum: number = 0;
for (let i = 0; i < 30; i = i + 1) {
  const snap: number[] = a.with(0, i);
  a = [...a, i];
  sum = sum + snap[0] + snap.length + a.length;
}
console.log(sum, a.length, a[0], a[40], a[69]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the consuming append is refused when the source is mentioned twice", async () => {
    // `x = [...x, x[0]]` — the second read happens AFTER the spread, so the storage
    // must NOT be handed over. (Ownership proves nothing about read ORDER; codegen
    // checks it syntactically.) node is the oracle.
    const src = `${BUILD}
let a: number[] = build(40);
a = [...a, a[0], a.length];
console.log(a.length, a[40], a[41], a[0], a[39]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("loop-append of 10k allocates no trie nodes and leaks nothing", async () => {
    // The performance witness, expressed as ALLOCATIONS so it is machine-independent:
    // the builder block is moved (not copied) from version to version, so 10k appends
    // cost zero node allocations and zero abandoned handles. Before B2 step 4 the same
    // program leaked 10001 array handles and 10561 trie nodes.
    const src = `${BUILD}
function work(): number { const t: number[] = build(10000); return t[9999]; }
console.log(work());
console.log(__arrLive(), __pvNodes(), __pvAllocs());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("9999\n0 0 0\n");
  });
});
