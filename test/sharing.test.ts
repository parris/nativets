/*
 * B2 step 2 — real STRUCTURAL SHARING for arrays (32-way persistent vector trie).
 *
 * Past NT_PV_THRESHOLD (32) elements an array switches from the flat block to the
 * refcounted persistent trie in runtime/nt_pvec.c, so `arr.with(i,v)` and the
 * leading-spread append `[...a, x]` copy only the root→leaf path instead of all n
 * slots. Two kinds of assertion here:
 *
 *  1. BEHAVIOUR — everything observable stays byte-identical to `node`. The trie is
 *     an implementation detail, so the differential oracle is the real gate. Biased
 *     to the references' danger zones: the flat→trie boundary (31/32/33), the tree
 *     capacity / height bump (1023/1024/1025) and a deep 2000-element vector.
 *  2. SHARING + MEMORY — witnessed by `__pvAllocs()` / `__pvNodes()` (cumulative and
 *     live trie nodes; the array analogue of `__arrLive()`). An update must allocate
 *     O(log32 n) nodes, NOT n; an append O(1); and the refcounts must return the live
 *     node count to 0 once every version is dropped (no leak, no double free).
 *     Those two builtins do not exist under node, so those cases are behavioural.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, expectMatchesNode } from "./harness.ts";

/** Build an n-element `number[]` by repeated immutable append (node-runnable). */
const BUILD = `
function build(n: number): number[] {
  let a: number[] = [];
  for (let i = 0; i < n; i = i + 1) { a = [...a, i]; }
  return a;
}`;

/**
 * Build an n-element `number[]` in ONE expression, so no intermediate version is
 * left undropped. Needed by the memory assertions: `build()` above reassigns in a
 * loop, and reassignment does not drop the old value (a pre-existing conservative
 * limitation of the drop pass), which would mask the refcount accounting.
 */
const BIG = `
function big(n: number): number[] {
  return "x".repeat(n).split("").map((c: string) => 1);
}`;

describe("structural sharing: observable behaviour matches node", () => {
  // The flat→trie boundary (§1.8) and the tree-capacity boundary. Every size is run
  // through append, .with, index, .length and .join.
  for (const n of [31, 32, 33, 1023, 1024, 1025]) {
    test(`size ${n}: append + .with + indexing match node`, async () => {
      const src = `${BUILD}
const a: number[] = build(${n});
const b: number[] = [...a, 777];
const c: number[] = a.with(${n} - 1, 42);
console.log(a.length, b.length, c.length);
console.log(a[0], a[${n} - 1], b[${n}], c[${n} - 1], a[${n} - 1]);
console.log(a.indexOf(31), a.includes(32), b.includes(777), c.includes(42));
console.log(c.join(",").length, b.join(",").length);`;
      const { ours, oracle } = await expectMatchesNode(src);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }

  test("deep index + update at ~2000 matches node", async () => {
    const src = `${BUILD}
const a: number[] = build(2000);
const b: number[] = a.with(0, -1).with(1055, -2).with(1056, -3).with(1999, -4);
console.log(a.length, b.length);
console.log(a[0], a[1055], a[1056], a[1999]);
console.log(b[0], b[1055], b[1056], b[1999], b[1000]);
let s: number = 0;
for (const x of b) { s = s + x; }
console.log(s);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("the old version is untouched by .with and by append", async () => {
    const src = `${BUILD}
const v0: number[] = build(200);
const v1: number[] = v0.with(7, 999);
const v2: number[] = [...v1, 1234];
console.log(v0[7], v1[7], v2[7]);
console.log(v0.length, v1.length, v2.length);
console.log(v0.indexOf(999), v1.indexOf(999));
console.log(v0.includes(1234), v2.includes(1234));`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("every array operation on a trie-backed array matches node", async () => {
    const src = `${BUILD}
const a: number[] = build(100);
console.log(a.length, a[0], a[99], a.slice(0, 5).join("-"), a.slice(-3).join("-"));
console.log(a.includes(99), a.includes(100), a.indexOf(50), a.indexOf(1000));
console.log(a.map((x: number) => x * 2)[10]);
console.log(a.filter((x: number) => x % 25 === 0).join(","));
console.log(a.reduce((s: number, x: number) => s + x, 0));
console.log(JSON.stringify(a.slice(0, 4)));
let s: number = 0;
for (const x of a) { s = s + x; }
console.log(s);
const r: number[] = build(64);
console.log(r.reverse().slice(0, 3).join(","), r.length);
const strs: string[] = "x".repeat(50).split("");
console.log(strs.length, strs.with(0, "y").join("").length, strs[0]);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  test("=== identity semantics survive the switch (a version is not its source)", async () => {
    const src = `${BUILD}
const a: number[] = build(100);
const b: number[] = a.with(0, 0);
console.log(a === a, a === b, b === b);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});

describe("structural sharing is real (node-count witness)", () => {
  test("an update allocates O(log32 n) nodes, not n", async () => {
    // shift/5 + 1 nodes per tree update: 2 at shift 5 (≤1024 in-tree), 3 at shift 10,
    // 4 at shift 15. The first `.with` is what freezes the array, so measure the SECOND.
    const src = `${BIG}
function upd(n: number): number {
  const a: number[] = big(n);
  const v1: number[] = a.with(0, 5);   // freezes: one-time O(n) build
  const before: number = __pvAllocs();
  const v2: number[] = v1.with(1, 6);  // path copy only
  const cost: number = __pvAllocs() - before;
  return cost + 0 * (v2[1] + a[0]);
}
console.log(upd(100), upd(1000), upd(2000), upd(40000));`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("2 2 3 4\n");
  });

  test("a leading-spread append allocates O(1) nodes, not n", async () => {
    const src = `${BIG}
const a: number[] = big(2000);
const f: number[] = [...a, 1];        // freezes
const before: number = __pvAllocs();
const g: number[] = [...f, 2];        // adopt (0 nodes) + persistent push (1 tail clone)
console.log(__pvAllocs() - before, g.length, f.length, a.length);`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1 2002 2001 2000\n");
  });

  test("small arrays stay flat — no trie nodes are allocated at all", async () => {
    const src = `
const a: number[] = [1, 2, 3];
const b: number[] = a.with(1, 99);
const c: number[] = [...a, 4];
console.log(a.join(","), b.join(","), c.join(","));
console.log(__pvAllocs(), __pvNodes());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1,2,3 1,99,3 1,2,3,4\n0 0\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("shared trie nodes are refcounted (no leak, no double free)", () => {
  test("all versions dropped ⇒ live node count returns to 0", async () => {
    const src = `${BIG}
function work(): number {
  const a: number[] = big(2000);
  const b: number[] = a.with(0, 7);
  const c: number[] = b.with(1999, 9);
  const d: number[] = [...c, 5];
  return a[0] + b[0] + c[1999] + d[2000];
}
console.log(work());
console.log(__pvNodes());`;
    // (__arrLive is NOT 0 here: big()'s split/map temporaries are unbound and the drop
    // pass only frees top-level linear locals — a pre-existing, documented safe leak.
    // Those temporaries are FLAT arrays, so they contribute no trie nodes.)
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("22\n0\n"); // 1 + 7 + 9 + 5; every trie node reclaimed
    expect(r.exitCode).toBe(0);
  });

  test("many versions in a loop all free (a shared node dies with its LAST owner)", async () => {
    const src = `${BIG}
function step(k: number): number {
  const a: number[] = big(200);
  const b: number[] = a.with(k, 3);
  const c: number[] = b.with(k + 1, 4);
  return b[k] + c[k + 1];
}
let total: number = 0;
for (let i = 0; i < 50; i = i + 1) { total = total + step(i); }
console.log(total);
console.log(__pvNodes());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("350\n0\n"); // 50 * 7, and 50 rounds of versions all reclaimed
    expect(r.exitCode).toBe(0);
  });

  test("dropping the source first leaves the derived version intact (no dangling node)", async () => {
    const src = `${BIG}
function derive(): number[] {
  const a: number[] = big(2000);   // dropped at scope exit
  return a.with(1500, 88);         // survives, sharing a's nodes
}
const d: number[] = derive();
console.log(d.length, d[1500], d[0], d[1999]);
console.log(__pvNodes() > 0);`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2000 88 1 1\ntrue\n");
    expect(r.exitCode).toBe(0);
  });

  test("in-place .reverse thaws instead of writing through shared nodes", async () => {
    const src = `${BIG}
const a: number[] = big(100).with(0, 5).with(99, 7);
const b: number[] = a.with(50, 3);
console.log(b.reverse()[49], a[50], a[0], a[99]);
console.log(b[0], b.length);`;
    const { ours, oracle } = await expectMatchesNode(src.replace(/__pv\w+\(\)/g, "0"));
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });
});
