/*
 * String reference-counting (RC) leak tests.
 *
 * Heap strings have VALUE semantics (freely copied/aliased), so they are
 * reclaimed by reference counting rather than linear move/drop. A runtime
 * pointer->refcount side table registers each heap string at creation (rc=1),
 * retains on bind/alias, and frees + removes at rc 0. Literals (`@.str`
 * globals) are never in the table, so retain/release on them are no-ops and
 * they are never freed.
 *
 * These are NOT node-differential (node has no `__strLive`); they compile+run
 * our binary and observe the live heap-string counter, exactly like the
 * `__arrLive()` array-drop tests. The assertion is that the counter returns to
 * 0 once heap strings go out of scope — RC reclaims them, no leak — and that a
 * literal-only program is 0 and does not crash.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun } from "./harness.ts";

describe("string rc (reclaim heap strings)", () => {
  test("a literal-only program allocates no heap strings and never frees a literal", async () => {
    const src = `
const s: string = "hello world";
const t: string = s;            // alias of a literal: retain/release are no-ops
console.log(s.length, t.length);
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("11 11\n0\n"); // literals never tracked -> live count 0
    expect(r.exitCode).toBe(0);
  });

  test("an owned heap string is freed at scope exit", async () => {
    const src = `
function build(): number {
  const a: string = "abcdef";
  const b: string = a.slice(0, 3);   // heap producer, owned by b
  const c: string = b.toUpperCase(); // heap producer, owned by c
  return b.length + c.length;
}
console.log(build());
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6\n0\n"); // b, c freed when build() returns
    expect(r.exitCode).toBe(0);
  });

  test("aliasing a heap string retains; both owners release, freed once", async () => {
    const src = `
function alias(): number {
  const a: string = "x".repeat(5);   // heap producer, owned by a (rc=1)
  const b: string = a;               // alias -> retain (rc=2)
  const c: string = b;               // alias -> retain (rc=3)
  return a.length + b.length + c.length;
}
console.log(alias());
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("15\n0\n"); // three owners, three releases -> freed exactly once
    expect(r.exitCode).toBe(0);
  });

  test("heavy string creation/concat/aliasing in a loop returns to 0 live", async () => {
    const src = `
function work(seed: string): number {
  const a: string = seed + "-tag";       // concat producer
  const b: string = a.toUpperCase();     // method producer
  const c: string = b.slice(1);          // method producer
  const d: string = c;                   // alias -> retain
  const e: string = d + "!";             // concat producer (borrows d), bound directly
  return a.length + b.length + c.length + d.length + e.length;
}
let total: number = 0;
for (let i: number = 0; i < 2000; i = i + 1) {
  total = total + work("item");
}
console.log(total);
console.log(__strLive());`;
    const r = await compileAndRun(src);
    // Every heap string is created inside work() and reclaimed when it returns,
    // so after 2000 calls the live count is back to 0 (no accumulation).
    expect(r.stdout.split("\n")[1]).toBe("0");
    expect(r.exitCode).toBe(0);
  });

  test("a returned string transfers ownership and is freed by its final owner", async () => {
    const src = `
function make(): string {
  const s: string = "a-b-c-d".toUpperCase(); // heap producer, owned by s
  return s;                                  // ownership transfers to the caller
}
function run(): number {
  const r: string = make();  // consumes the transferred owner
  return r.length;
}
console.log(run());
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n0\n"); // freed once at run()'s scope exit, no double free
    expect(r.exitCode).toBe(0);
  });
});

/*
 * COERCION TRANSIENTS — the string a `+` or a `${}` creates only in order to hand it
 * straight to `js_str_concat`.
 *
 * `"item" + n` coerces `n` with `js_num_to_str`, which ALLOCATES and registers a heap
 * string; `js_str_concat` then COPIES its two inputs into a third buffer and retains
 * neither. The coerced intermediate is dead on the next instruction and nothing owned
 * it — it is not a local, so it is not in `strLocals` and no scope exit releases it.
 * One leaked string per concatenation, proportional to work.
 *
 * INVISIBLE ON macOS: LeakSanitizer is Linux-only, so the whole class was green on the
 * laptop. `__strLive()` is what sees it, and only when the input is SCALED — at n=3 a
 * leak of three strings and a leak of none look equally like "small".
 *
 * Only the arms of `coerceToString` that call a REGISTERING producer are released:
 * `number` (js_num_to_str) and an array (`nt_arr_join_*`). A `boolean` coerces to a
 * literal and a `string` is handed back BORROWED — releasing either would be dropping
 * an owner this frame never took, which is a premature free rather than a leak.
 */
describe("string coercion transients are released, not leaked", () => {
  test("`\"lit\" + n` does not leak its js_num_to_str intermediate", async () => {
    const src = `
function work(n: number): number {
  const s: string = "item" + n;   // js_num_to_str temp -> js_str_concat -> dead
  return s.length;
}
let total: number = 0;
for (let i: number = 0; i < 2000; i = i + 1) { total = total + work(i); }
console.log(total);
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("14890\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("residue does not GROW with work (200 unwinds vs 2000)", async () => {
    // The property that distinguishes a leak from a constant: run the same body at two
    // scales and require the SAME residue. A per-iteration leak fails this even when a
    // single-scale assertion of "small" would pass.
    const body = (n: number) => `
function work(k: number): number {
  const a: string = "a" + k + "b";      // TWO transients: the number, and the inner concat
  const b: string = \`t\${k}u\${k}\`;      // template literal, two coercions
  const c: string = "arr" + [k, k];     // nt_arr_join_num temp
  return a.length + b.length + c.length;
}
let t: number = 0;
for (let i: number = 0; i < ${n}; i = i + 1) { t = t + work(i); }
console.log(__strLive());`;
    const small = await compileAndRun(body(200));
    const large = await compileAndRun(body(2000));
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
    expect(large.stdout).toBe(small.stdout);
  });

  test("a BORROWED coercion is not released — `s + t` of two heap locals stays valid", async () => {
    // The premature-free direction. Both operands are heap strings this frame owns; the
    // coercion hands each back unchanged, so releasing one here would free a string the
    // local still owns and the scope-exit release would then double-free.
    const src = `
function work(seed: string): number {
  const s: string = seed.toUpperCase();
  const t: string = seed.slice(1);
  const u: string = s + t;      // both operands BORROWED, not allocated by the coercion
  return s.length + t.length + u.length;
}
let total: number = 0;
for (let i: number = 0; i < 2000; i = i + 1) { total = total + work("item"); }
console.log(total);
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("28000\n0\n");
    expect(r.exitCode).toBe(0);
  });
});
