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

/*
 * Object drop is SHALLOW — `nt_obj_free` is `free(o)` and never walks the slots.
 *
 * These tests PIN that gap rather than fix it. It is the `array/object ELEMENTS`
 * item listed under **Still open** in docs/ROADMAP.md's Phase C: "an array does not
 * recursively free what its slots point at ... leaks by construction, never a double
 * free or a dangling pointer". They exist so the leak is a measured number that
 * cannot silently grow, and so that whoever closes the gap has to change a test on
 * purpose instead of discovering the shape by accident.
 *
 * They are also the reason a GENERIC recursive free is not merely unsafe but
 * impossible: `nt_obj_new` returns a bare `int64_t*` of n slots with NO header, so at
 * `nt_obj_free(void *o)` the runtime knows neither the slot count nor whether any
 * given 64-bit word is a double, a refcounted string, a linear object, or an
 * `NtArray*`. Closing this needs TYPE INFORMATION AT THE FREE SITE (a codegen-emitted
 * per-type destructor), plus the two blockers pinned in the `double free` block below.
 */
describe("object drops are SHALLOW (pinned open gap, ROADMAP Phase C)", () => {
  test("an object reachable only through another object's slot leaks", async () => {
    const src = `
function f(): number { const inner = { b: 2 }; const outer = { a: inner }; return outer.a.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n"); // outer freed, `inner` leaked: SHOULD be 0
    expect(r.exitCode).toBe(0);
  });

  test("the leak is one object per nesting level, not one per tree", async () => {
    const src = `
function f(): number { const a = { n: 1 }; const b = { x: a }; const c = { y: b }; return c.y.x.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n2\n"); // only the outermost `c` is freed
    expect(r.exitCode).toBe(0);
  });

  test("an object in an array leaks though the array HEADER is freed", async () => {
    // __arrLive counts headers, so it reports 0 here and sees nothing wrong.
    const src = `
function f(): number { const o = { b: 2 }; const xs = [o]; return xs[0].b; }
console.log(f());
console.log(__objLive());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n0\n"); // objLive 1 = the leak __arrLive cannot see
    expect(r.exitCode).toBe(0);
  });

  test("an array in an object leaks, and __arrLive DOES see it", async () => {
    const src = `
function f(): number { const xs = [1, 2, 3]; const o = { a: xs }; return o.a[1]; }
console.log(f());
console.log(__objLive());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n1\n"); // the object is freed; its array slot is not
    expect(r.exitCode).toBe(0);
  });

  test("a union member's object field leaks — SH2's `__objLive() -> 0` does not hold", async () => {
    const src = `
type Sq = { kind: "sq"; inner: { n: number } };
function f(): number { const u: Sq = { kind: "sq", inner: { n: 5 } }; return u.inner.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n1\n"); // a union IS an object block, so it leaks identically
    expect(r.exitCode).toBe(0);
  });

  test("a @@mutable record holding an object leaks it too", async () => {
    const src = `
@@mutable
type Box = { held: { n: number } };
function f(): number { const b: Box = { held: { n: 7 } }; return b.held.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n1\n");
    expect(r.exitCode).toBe(0);
  });

  test("a refcounted string in a slot does NOT leak (strings are not linear)", async () => {
    // Contrast case: proves the gap is specific to linear slots. `__strLive` is 1
    // only because the object's own release never runs; the count is a refcount,
    // so a recursive `free()` over this slot would corrupt, not merely leak.
    const src = `
function f(): number { const o = { a: "hel" + "lo" }; return o.a.length; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

/*
 * WHY A TYPE-DIRECTED RECURSIVE FREE IS STILL UNSAFE TODAY.
 *
 * Knowing the static type at the drop site is necessary but NOT sufficient. Both
 * programs below compile today and are correct today precisely BECAUSE the drop is
 * shallow; each would become a DOUBLE FREE the moment an object recursively freed its
 * slots. They are pinned here as the blockers a future per-type destructor must clear
 * first (by consuming the source, or by refusing these forms).
 *
 * A double free is silent on stdout and shows up only as a nonzero exit — the exact
 * signature of the shipped `nt_arr_reverse` bug — so both assertions matter.
 */
describe("blockers a recursive free must clear first (double-free hazards)", () => {
  test("spread SHALLOW-COPIES a slot, so two objects hold one pointer", async () => {
    // The emitted IR loads o1's slot 0 and stores the SAME i64 into o2's slot 0,
    // then frees both objects. Recursive free => `inner` freed twice.
    const src = `
function f(): number { const inner = { b: 2 }; const o1 = { a: inner }; const o2 = { ...o1 }; return o2.a.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n"); // 3 allocated, 2 freed; `inner` is aliased by o1 and o2
    expect(r.exitCode).toBe(0);
  });

  test("a field can be MOVED OUT while the parent's slot still points at it", async () => {
    // `outer.a` is not invalidated in outer's slot, so outer + taken both reference
    // `inner`. Today that is exactly 2 allocs / 2 frees; recursively freeing outer
    // would make it 3 frees.
    const src = `
function f(): number { const inner = { b: 2 }; const outer = { a: inner }; const taken = outer.a; return taken.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("a field returned out of a function outlives its parent's drop", async () => {
    const src = `
function g(): { b: number } { const inner = { b: 2 }; const outer = { a: inner }; return outer.a; }
function f(): number { const r = g(); return r.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n"); // g drops `outer` shallowly while the caller owns `inner`
    expect(r.exitCode).toBe(0);
  });
});
