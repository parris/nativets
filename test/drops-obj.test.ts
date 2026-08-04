/*
 * Object drop / deterministic-free tests (mirrors drops.test.ts for arrays).
 *
 * Compiler-inserted RAII frees are invisible in normal output, so we expose a
 * runtime counter `__objLive()` (objects allocated − freed) to observe them.
 * NOTE: these use the `move` intrinsic and `__objLive` builtin, neither of which
 * exists under node — so, exactly like drops.test.ts, they are compile-and-run
 * only (NOT node-differential fixtures under test/fixtures/, which node oracles).
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";

describe("object drops (deterministic free)", () => {
  test("owned object is freed at scope exit", async () => {
    const src = `
function make(): number { const a: {x:number} = {x: 42}; return a.x; }
console.log(make());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("42\n0\n"); // a dropped when make() returns
    expect(r.exitCode).toBe(0);
  });

  test("many owned objects in a loop all return to 0 live", async () => {
    const src = `
function mk(n: number): number {
  const a: {x:number, y:number} = {x: n, y: n + 1};
  return a.x + a.y;
}
let total: number = 0;
for (let i = 0; i < 100; i = i + 1) { total = total + mk(i); }
console.log(total);
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("10000\n0\n"); // every object freed at its scope exit
    expect(r.exitCode).toBe(0);
  });

  test("a moved-out (returned) object is not freed by the callee", async () => {
    const src = `
function mk(): {x:number} { const a: {x:number} = {x: 7}; return a; }
const b = mk();
console.log(b.x);
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n1\n"); // b still alive; mk did not drop the moved-out value
    expect(r.exitCode).toBe(0);
  });

  test("move transfers ownership and frees exactly once (no double free)", async () => {
    const src = `
function useIt(): number {
  const a: {x:number} = {x: 5};
  const b = move(a);
  return b.x;
}
console.log(useIt());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n0\n"); // freed once via b; no double free (exit 0)
    expect(r.exitCode).toBe(0);
  });
});
