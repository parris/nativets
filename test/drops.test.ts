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
import { compileAndRun, expectMatchesNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

/** The NT code a program is REFUSED with (`""` if it compiles) — diagnostics are
 *  thrown, so a rejection cannot be observed through `compileAndRun`. */
function rejectCode(source: string): string {
  try {
    sourceToIR(source);
    return "";
  } catch (e) {
    return (e as { diag?: { code?: string } }).diag?.code ?? `THREW:${(e as Error).message}`;
  }
}

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

/*
 * `.reverse()` hands back its RECEIVER (in place, exactly like node), so binding the
 * result introduces a SECOND NAME for one allocation. Before the alias rule below,
 * both names were owners and the scope freed the same pointer twice — a double free
 * that printed the right answer and then died on a signal.
 *
 * Note the shape of these assertions: stdout alone was already CORRECT while the bug
 * was live, so every case pins the EXIT CODE too, and `__arrLive()` pins the free
 * count. Cases are derived from the node semantics of `Array.prototype.reverse`
 * (run against node as the oracle); no test262 checkout exists on this machine.
 */
describe("drops: `.reverse()` returns its receiver (aliasing)", () => {
  test("the result binding aliases the receiver and is freed exactly once", async () => {
    const src = `
const a = [1, 2, 3];
const b = a.reverse();
console.log(b.join(","));`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("3,2,1\n");
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0); // a double free died on a signal (134/139) here
  });

  test("returning the receiver's own result moves it out instead of freeing it", async () => {
    // `return a.reverse()` returns the pointer `a` owns. Treating the call as opaque
    // let the scope drop `a` and hand the caller a FREED pointer: exit 0, empty output
    // where node prints `3,2,1` — a silent wrong answer, worse than the crash above.
    const src = `
function f(): number[] {
  const a = [1, 2, 3];
  return a.reverse();
}
console.log(f().join(","));`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.stdout).toBe("3,2,1\n");
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0);
  });

  test("receiver and alias are both readable and name one array, freed once", async () => {
    const src = `
function f(): string {
  const a = [1, 2, 3];
  const b = a.reverse();
  return b.join(",") + "|" + a.join(",");
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3,2,1|3,2,1\n0\n"); // node prints `3,2,1|3,2,1`; 0 live ⇒ freed once
    expect(r.exitCode).toBe(0);
  });

  test("an alias CHAIN still resolves to the single owner", async () => {
    const src = `
function f(): string {
  const a = [1, 2, 3];
  const b = a.reverse();
  const c = b.reverse();
  return c.join(",");
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1,2,3\n0\n"); // reversed twice; one allocation, one free
    expect(r.exitCode).toBe(0);
  });

  test("a CHAINED receiver is a fresh temporary, so the binding really owns it", async () => {
    // `a.map(f)` mints a new array that no binding owns, so `.reverse()`ing it must NOT
    // make `b` an alias — `b` is its owner. The regression this pins is UNDER-freeing.
    const src = `
function f(): string {
  const a = [1, 2, 3];
  const b = a.map((x: number) => x * 2).reverse();
  return b.join(",") + "|" + a.join(",");
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6,4,2|1,2,3\n0\n"); // both arrays freed: 0 live, no leak
    expect(r.exitCode).toBe(0);
  });

  test("REGRESSION: the discarded and temporary forms still work", async () => {
    const src = `
function f(): string {
  const a = [1, 2, 3];
  a.reverse();
  return a.join(",");
}
console.log(f());
console.log([4, 5, 6].reverse().join(","));
console.log(__arrLive());`;
    const { ours, oracle } = await expectMatchesNode(src.replace("\nconsole.log(__arrLive());", ""));
    expect(ours.stdout).toBe(oracle.stdout);
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3,2,1\n6,5,4\n0\n"); // neither over- nor under-freed
    expect(r.exitCode).toBe(0);
  });

  test("a TEMPORARY receiver is freed through the retaining call, not leaked", async () => {
    // `[4,5,6].reverse()` hands the literal's own pointer down the chain, so `freshArray`
    // has to see freshness THROUGH the call — otherwise nothing owns the temp and it
    // leaks. Invisible locally; LeakSanitizer on Linux CI is what catches this.
    const src = `
console.log([4, 5, 6].reverse().join(","));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6,5,4\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("a USER class's own `.reverse()` is not receiver-retaining", async () => {
    // The rule keys off the ARRAY builtin, not the method NAME: a class may define
    // `.reverse()` returning something fresh, and calling that an alias would leak the
    // fresh value (and refuse returning it). The result TYPE is what gates it.
    const src = `
class Foo {
  n: number;
  constructor(n: number) { this.n = n; }
  reverse(): Foo { return new Foo(-this.n); }
}
function f(): number {
  const a = new Foo(5);
  const b = a.reverse();
  return b.n + a.n;
}
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("0\n0\n"); // node prints `0`; 0 live ⇒ the fresh Foo was freed
    expect(r.exitCode).toBe(0);
  });

  test("...even when that class's `.reverse()` returns an ARRAY", async () => {
    // The result type alone would match here, so the RECEIVER's type is checked too:
    // `a` is a `Foo`, so this is an ordinary method returning a fresh array `b` owns.
    const src = `
class Foo {
  n: number;
  constructor(n: number) { this.n = n; }
  reverse(): number[] { return [this.n, -this.n]; }
}
function f(): number {
  const a = new Foo(5);
  const b = a.reverse();
  return b.length + a.n;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n0\n"); // node prints `7`; 0 live ⇒ the returned array was freed
    expect(r.exitCode).toBe(0);
  });

  test("an alias may not ESCAPE its owner's scope (NT1604)", () => {
    // Returning `b` would hand the caller a pointer this scope still drops. Refused at
    // compile time, not miscompiled — the CLI exits 1 with a diagnostic, never a signal.
    expect(rejectCode(`
function f(): number[] {
  const a = [1, 2, 3];
  const b = a.reverse();
  return b;
}
console.log(f().join(","));`)).toBe("NT1604");
  });

  test("the owner may not be REASSIGNED while an alias is live (NT1602)", () => {
    expect(rejectCode(`
let a = [1, 2, 3];
const b = a.reverse();
a = [9, 9];
console.log(b.join(","));`)).toBe("NT1602");
  });
});

/*
 * The for-of ITERABLE temporary.
 *
 * `for (const x of [3,2,1])` builds an array no binding owns, so the drop pass never
 * sees it and the loop leaked it. Only the RECEIVER position had a temp-free rule
 * (`freeReceiverTemp`); the iterable position had none.
 *
 * Cases are DERIVED from the ownership model, not mined — there is no test262 or
 * TypeScript conformance checkout on this machine. `__arrLive()` is the oracle for
 * ownership here; node is the oracle for the values.
 */
describe("drops: the for-of iterable temporary", () => {
  test("a temporary iterable is freed when the loop ends", async () => {
    const src = `
function f(): number {
  let t: number = 0;
  for (const x of [3, 2, 1]) { t = t + x; }
  return t;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6\n0\n"); // node prints 6; 0 live ⇒ the literal was freed
    expect(r.exitCode).toBe(0);
  });

  test("a temporary iterable is freed when the loop BREAKS", async () => {
    // `break` jumps to the same join point the fall-through exit uses, so it must not
    // skip the free (elsewhere `break` deliberately jumps past drops — not here).
    const src = `
function f(): number {
  let t: number = 0;
  for (const x of [3, 2, 1]) { t = t + x; break; }
  return t;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("3\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("a BINDING iterable is left to its owner (no double free)", async () => {
    // The regression that matters: freeing here would free storage the binding still
    // owns and the scope will drop again. Exit code pins that it did not.
    const src = `
function f(): number {
  const a = [3, 2, 1];
  let t: number = 0;
  for (const x of a) { t = t + x; }
  return t + a.length;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("9\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

/*
 * ASSIGNING TO A LINEAR PARAMETER — NT1608 (≈ rustc E0384, "cannot assign twice to
 * immutable variable"; a Rust parameter is an immutable binding unless declared `mut`).
 *
 * The bug this closes was the worst failure mode this project recognises: a silent wrong
 * answer that did not reproduce identically.
 *
 *   function f(out: string[]): void { out = ["z"]; }
 *   const acc: string[] = ["a", "b"];
 *   f(acc);
 *   console.log(acc.length);
 *
 * node prints `2`. This printed `3` on one run and `6875746259392517000` on the next, and
 * both times EXIT 0 — so a differential test could pass by luck. `3` is not the length of
 * anything in the program (`["z"]` is 1, `acc` is 2): the read was landing on freed
 * storage, not on a stale header.
 *
 * CAUSE, one token wide. `AssignExpr` sets `dropOld` — "this scope frees the value being
 * overwritten" — from `droppable()`, which proves only *not moved out* and *not captured
 * by a closure*. It never asked whether this scope OWNS the binding. A linear parameter is
 * in `linear` (so the move checker tracks it) but is deliberately NOT in the scope-exit
 * drop set, because it is a BORROW: `paramBorrows`, ownership.ts. `dropOld` was the one
 * place that read `linear` without also reading `borrowParams`, so `out = […]` freed the
 * CALLER's array and every later read of `acc` dangled.
 *
 * WHY A REFUSAL AND NOT A FIX. Suppressing `dropOld` for a borrow param is memory-safe and
 * matches node on all of these — but then nothing frees the value the callee allocated
 * (measured: `__arrLive()` 2 where 1 is live for the straight-line case, 5 where 1 is live
 * for the loop). Dropping it at scope exit instead needs a per-parameter drop flag for the
 * paths that did not reassign, and getting that wrong is a double free. The pattern users
 * reach for here — an accumulator out-param — cannot work in node either, so the rebinding
 * was never what they wanted. docs/self-hosting.md decided the same question for a
 * persistent Map: RETURN the value.
 *
 * Only LINEAR parameters (array / object / union / class instance) are affected. A
 * `string` or `number` parameter is Copy, is not in `linear`, and is untouched — the
 * `s = s.trim()` idiom keeps working.
 */
describe("drops: assignment to a linear parameter (NT1608)", () => {
  test("rebinding an array parameter is refused, not miscompiled", () => {
    expect(rejectCode(`
function f(out: string[]): void { out = ["z"]; }
const acc: string[] = ["a", "b"];
f(acc);
console.log(acc.length);`)).toBe("NT1608");
  });

  test("the spread/accumulator form is refused too — it was the NONDETERMINISTIC one", () => {
    // This is the shape the NT1606 `.push` hint used to recommend verbatim. Before the
    // refusal it printed a different garbage integer on every run, always at exit 0.
    expect(rejectCode(`
function collect(names: string[], out: string[]): void {
  for (const n of names) out = [...out, n];
}
const acc: string[] = [];
collect(["a", "b", "c"], acc);
console.log(acc.length);`)).toBe("NT1608");
  });

  test("an OBJECT parameter is the same borrow (this one crashed with SIGTRAP)", () => {
    // Heap corruption rather than a quiet wrong answer — the built binary died on signal
    // 5 with nothing on stdout at all. Same cause, louder symptom.
    expect(rejectCode(`
function f(o: { n: number }): void { o = { n: 9 }; }
const a = { n: 1 };
f(a);
console.log(a.n);`)).toBe("NT1608");
  });

  test("a STRING parameter is Copy, not linear — still accepted", async () => {
    // The refusal must not swallow `s = s.trim()`. Strings are not in `linear`, so they
    // never reach the borrow-param arm; this pins that the rule stayed narrow.
    const src = `
function f(s: string): string { s = s + "!"; return s; }
const a = "hi";
console.log(f(a), a);`;
    await expectMatchesNode(src);
  });

  test("a LOCAL is still reassignable, and still freed exactly once", async () => {
    // The guard is on `borrowParams`, not on `linear`, so RAII-on-reassignment for an
    // ordinary local is untouched: one array live at the end, none leaked, none freed
    // twice. Remove the `borrowParams.has` check and the parameter case above returns.
    const src = `
function f(): number {
  let a: string[] = ["a", "b"];
  a = ["z"];
  return a.length;
}
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n0\n"); // the superseded ["a","b"] was freed; no leak, no double free
    expect(r.exitCode).toBe(0);
  });
});
