/*
 * Drop / deterministic-free tests.
 *
 * Compiler-inserted RAII frees are invisible in normal output, so we expose a
 * runtime counter `__arrLive()` (arrays allocated − freed) to observe them.
 * These assert: (1) an owned array is freed at scope exit, (2) a moved-out
 * (returned) array is NOT freed by the callee, and (3) under `move`, the value
 * is freed exactly once (no double free — the program exits 0).
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";

describe("drops (deterministic free)", () => {
  test("owned array is freed at scope exit", async () => {
    const src = `
function make(): number { const a: number[] = [1, 2, 3]; return a.length; }
console.log(make());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3\n0\n"); // a dropped when make() returns
    expect(r.exitCode).toBe(0);
  });

  test("a moved-out (returned) array is not freed by the callee", async () => {
    const src = `
function mk(): number[] { const a: number[] = [1, 2, 3]; return a; }
const b = mk();
console.log(b.length);
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3\n1\n"); // b still alive; mk did not drop the moved-out value
    expect(r.exitCode).toBe(0);
  });

  test("move transfers ownership and frees exactly once", async () => {
    const src = `
function useIt(): number {
  const a: number[] = [1, 2, 3];
  const b = move(a);
  return b.length;
}
console.log(useIt());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3\n0\n"); // freed once via b; no double free (exit 0)
    expect(r.exitCode).toBe(0);
  });
});
