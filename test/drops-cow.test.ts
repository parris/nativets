/*
 * Copy-on-write drop / leak balance (B2 step 1 — additive immutable primitives).
 *
 * `.with(i,v)` and object-spread `{...o, k:v}` allocate a FULL independent copy
 * (nt_arr_copy / a fresh nt_obj block). Each copy is single-owner, so the linear
 * drop pass must free it exactly once — copies must not leak and must not
 * double-free. Observed via the `__arrLive()` / `__objLive()` counters (alloc −
 * free), exactly like drops.test.ts / drops-obj.test.ts. Not node-differential:
 * `.with` runs under node, but `__arrLive`/`__objLive` do not.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";

describe("copy-on-write drops (deterministic free)", () => {
  test("array .with copy is freed at scope exit (both original and copy)", async () => {
    const src = `
function f(): number {
  const a: number[] = [1, 2, 3];
  const b: number[] = a.with(1, 99);
  return a.length + b.length;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6\n0\n"); // a and its .with copy both dropped
    expect(r.exitCode).toBe(0);
  });

  test("chained .with copies all return to 0 live", async () => {
    const src = `
function f(): number {
  const v0: number[] = [1, 2, 3];
  const v1: number[] = v0.with(0, 100);
  const v2: number[] = v1.with(2, 300);
  return v0[0] + v1[0] + v2[2];
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("401\n0\n"); // 1 + 100 + 300; all three versions dropped
    expect(r.exitCode).toBe(0);
  });

  test("many .with copies in a loop all free (no leak)", async () => {
    const src = `
function mk(n: number): number {
  const a: number[] = [n, n, n];
  const b: number[] = a.with(1, n + 1);
  return b[1];
}
let total: number = 0;
for (let i = 0; i < 100; i = i + 1) { total = total + mk(i); }
console.log(total);
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5050\n0\n"); // sum of (i+1) for i in 0..99; every copy freed
    expect(r.exitCode).toBe(0);
  });

  test("object spread copy is freed at scope exit (both original and copy)", async () => {
    const src = `
function g(): number {
  const o: {x:number, y:number} = {x: 1, y: 2};
  const p: {x:number, y:number} = {...o, y: 9};
  return o.y + p.y;
}
console.log(g());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("11\n0\n"); // o and its spread copy both dropped
    expect(r.exitCode).toBe(0);
  });
});
