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

  /*
   * A THROWN PRODUCER STRING WAS DOUBLE-OWNED.
   *
   * Every other binding site in codegen asks `isStrProducer` before retaining — a fresh
   * template/concat/call result arrives already registered at rc=1, so binding it CONSUMES
   * that reference instead of adding one (`retainStrBind`, and the `ReturnStmt` transfer
   * rule beside it). Both `throw` lowerings retained unconditionally: the in-frame one
   * before storing into the catch binding, and the cross-frame one inside
   * `nt_exc_raise_msg`. The producer's own rc=1 was then never released by anybody —
   * `emitStrDrops` only walks NAMED locals, and a thrown temporary is not one.
   *
   * One heap string leaked per throw, on the shape the self-hosting frontier is made of
   * (`throw \`LexError: …\``). The control is the test above and the two here: the same
   * template bound to a local reclaims correctly, so this is the throw path, not the
   * producer.
   */
  /*
   * The in-frame shape is measured INSIDE A FUNCTION, deliberately. Written with the
   * `try` directly in the loop body it reports the same residue before and after the fix,
   * and the counter is not lying — `__strLive` is allocations minus frees, so it cannot
   * see the difference between one leaked string and one leaked string that also had a
   * spurious extra reference. A SEPARATE, pre-existing gap dominates there: a string local
   * declared in a loop body has a function-scoped slot that is released once, at function
   * exit, so the previous iteration's value is dropped on the floor. The last case in this
   * describe is that control — no throw anywhere, same residue — and it is NOT fixed here.
   * Putting the `try` in a function makes the frame (and its releases) exit every
   * iteration, which isolates the throw path: base 500, fixed 0, at n=500.
   */
  test("a thrown producer string is consumed, not double-owned — in-frame catch", async () => {
    const body = (n: number): string => `
function work(i: number): number {
  try {
    if (i > -1) throw \`LexError: bad input \${i}\`;
    return 0;
  } catch (e) {
    return e.length;
  }
}
let acc = 0;
for (let i = 0; i < ${n}; i++) { acc = acc + work(i); }
console.log(__strLive());`;
    const small = await compileAndRun(body(200));
    const large = await compileAndRun(body(1000));
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
    expect(small.stdout).toBe("0\n");
    expect(large.stdout).toBe("0\n"); // …and it does not GROW with the work
  });

  test("a thrown producer string is consumed, not double-owned — across a frame", async () => {
    const body = (n: number): string => `
function lex(s: string, i: number): number {
  if (s === "bad") throw \`LexError: bad input \${i}\`;
  return s.length;
}
function run(s: string, i: number): number {
  try { return lex(s, i); } catch (e) { return e.length; }
}
let acc = 0;
for (let i = 0; i < ${n}; i++) { acc = acc + run("bad", i); }
console.log(__strLive());`;
    const small = await compileAndRun(body(200));
    const large = await compileAndRun(body(1000));
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
    expect(small.stdout).toBe("0\n");
    expect(large.stdout).toBe("0\n");
  });

  // THE PREMATURE-FREE DIRECTION, which is the risk the fix above runs. A thrown NAMED
  // local is a borrow of a string the frame still owns and still releases at scope exit,
  // and a thrown literal is untracked — neither may lose a reference here. If the consume
  // were applied to them, the handler would read freed memory.
  test("a thrown local and a thrown literal are not consumed", async () => {
    const src = `
function work(i: number): number {
  const m: string = \`held \${i}\`;
  try {
    if (i > -1) throw m;
    return 0;
  } catch (e) {
    return e.length + m.length;
  }
}
let acc = 0;
for (let i = 0; i < 1000; i++) { acc = acc + work(i); }
console.log(acc);
try { throw "a literal"; } catch (e) { console.log(e); }
console.log(__strLive());`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    // 2 * Σ len(`held ${i}`) for i<1000 = 2 * (5000 + 10 + 180 + 2700) = 15780.
    expect(r.stdout).toBe("15780\na literal\n0\n");
  });

  /*
   * CLOSED — this was the "adjacent gap that is NOT fixed", and the numbers below are the
   * ones its own comment nominated as the intended direction (200 -> 0, 1000 -> 0).
   *
   * A string local declared in a loop body got a function-scoped slot released once at the
   * function's exit, so each iteration overwrote it without releasing what was there: one
   * heap string per iteration. `genStmts` now releases the strings a REPEATING block
   * declared (and nulls each slot) at every exit from it — fall-through, `break`/`continue`
   * via `emitJumpDrops`, and the inlined-HOF `return` via `emitStrScopeDropsTo`.
   *
   * Worth recording how invisible this was to the obvious instrument: `leaks(1)` reports
   * ZERO on the 400,000-iteration version, and is not wrong — the strings stay REACHABLE
   * from the runtime's registry, so it is unbounded growth rather than unreachable memory.
   * Peak RSS was the measurement that showed it: 60.3 MiB before, 1.5 MiB after, against
   * 1.7 MiB for the same program at 2,000 iterations.
   *
   * This is still why the in-frame throw case above is measured inside a function.
   */
  test("a string local declared in a loop body is released each iteration", async () => {
    const body = (n: number): string => `
let acc = 0;
for (let i = 0; i < ${n}; i++) {
  const m: string = \`LexError: bad input \${i}\`;
  acc = acc + m.length;
}
console.log(__strLive());`;
    const small = await compileAndRun(body(200));
    const large = await compileAndRun(body(1000));
    expect(small.exitCode).toBe(0);
    expect(large.exitCode).toBe(0);
    // Zero at BOTH scales, and both are asserted for the reason the two were written: a
    // per-iteration leak is invisible at one size and obvious across two.
    expect(small.stdout).toBe("0\n");
    expect(large.stdout).toBe("0\n");
  });

  /*
   * CLOSED, and the CONTROL that decides how far the rule may go.
   *
   * `freshString` (ast.ts) is a WHITELIST — a template literal or a `+` — for exactly the
   * reason the comment below gives: codegen's `isStrProducer` admits a plain `CallExpr`,
   * and a callee handing back a string it still owns would be freed by its CALLER. So a
   * call result must keep leaking rather than become a use-after-free, and that is
   * asserted here rather than left to the reader to trust.
   */
  test("a CALL result is still not freed — the hazard the whitelist exists to avoid", async () => {
    const r = await compileAndRun(`
function give(): string { return "shared"; }
let n = 0;
for (const c of give()) { n += c.length; }
console.log(n);`);
    expect(r.exitCode).toBe(0);   // never a UAF, whatever the leak
    expect(r.stdout).toBe("6\n");
  });

  /*
   * A SECOND, DISTINCT GAP — the one above is about a BINDING; this one has no binding at
   * all. `for (const c of x + y)` iterates a string nothing owns. The array twin of that
   * shape IS reclaimed: `codegen.ts`'s `ForOfStmt` frees the iterable at `endLbl` when
   * `freshArray(s.iterable)` says it was syntactically fresh, and the comment there says
   * exactly why ("a temporary no binding owns, so the drop pass never sees it"). There is
   * no string half of that rule, so the concat leaks once per execution of the loop.
   *
   * Found while giving `for…of` its code-point framing, by measuring the loop's live-string
   * delta and finding a residue the loop variable could not account for. It is NOT that
   * change's doing — the byte-framed loop leaked the same string — and it is deliberately
   * not fixed here. The array rule works because `freshArray` is a narrow syntactic
   * judgment; the string equivalent, `isStrProducer`, admits a plain `CallExpr`, and a
   * callee that hands back a string it still owns would be FREED BY ITS CALLER. That is a
   * use-after-free traded for a leak, which is the wrong direction — this repo's rule is
   * that a leak is recoverable and a dangling pointer is not. The fix belongs with whoever
   * owns the producer/borrow judgment, with the control below as its acceptance test.
   */
  test("`for (const c of x + y)` frees the iterable, like the ARRAY twin", async () => {
    const src = `
const x = "abc";
const y = "def";
const b1 = __strLive();
for (let i = 0; i < 100; i++) { for (const c of x + y) { } }
console.log("fresh string iterable", __strLive() - b1);
const b2 = __strLive();
for (let i = 0; i < 100; i++) { for (const c of x) { } }
console.log("named string iterable", __strLive() - b2);
const b3 = __arrLive();
for (let i = 0; i < 100; i++) { for (const v of [1, 2, 3]) { } }
console.log("fresh array iterable", __arrLive() - b3);`;
    const r = await compileAndRun(src);
    expect(r.exitCode).toBe(0);
    // All three 0 now. The first was 100 and its own comment nominated 0 as the intended
    // direction; the other two are the CONTROLS and were always 0 — they are what says
    // this was the fresh-temporary rule and not the loop or the framing.
    expect(r.stdout).toBe(
      "fresh string iterable 0\nnamed string iterable 0\nfresh array iterable 0\n",
    );
  });
});
