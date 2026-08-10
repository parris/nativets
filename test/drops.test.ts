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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, expectMatchesNode, emitIR, emitIRAsan } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/*
 * A `?:` ARM IN A CONSUMING POSITION MOVES.
 *
 * `Analyzer.expr`'s `ConditionalExpr` walked both arms with a hard-coded `consume: false`,
 * throwing away the caller's `consume`. The move checker therefore could not see through a
 * `?:`, and EVERY ownership rule was bypassable by laundering the move through one — the
 * identical shape `AsExpr` was fixed for in 481c463, one node type over.
 *
 *   const y: string[] = x;          // error[NT1604]: cannot move out of `x`
 *   const y: string[] = c ? x : o;  // the same move — compiled, exit 0
 *
 * Not a refusal-only defect: the second line gives one allocation two owners, so the
 * callee frees the caller's array. `test/ownership/ternary-move.ts` pins the diagnostics;
 * what is pinned HERE is that the accepted programs are still memory-correct, and the ASan
 * gate at the bottom is the only assertion in this file that can see the double free at
 * all — the live counters balance to zero just as happily while a program reads freed
 * memory.
 */
describe("drops: a `?:` arm moves (NT1604 was bypassable through a ternary)", () => {
  test("the headline bypass is refused — `c ? x : o` is the same move as `x`", () => {
    const bypass = `
function use(a: string[]): number { return a.length; }
function pick(x: string[], o: string[], c: boolean): number {
  const y: string[] = c ? x : o;
  return use(y);
}
console.log(pick(["a"], ["b", "c"], true));`;
    expect(rejectCode(bypass)).toBe("NT1604");
    // ...and it is refused for the SAME reason the un-laundered spelling always was.
    expect(rejectCode(bypass.replace("c ? x : o", "x"))).toBe("NT1604");
  });

  test("a union member returned through a `?:` is refused — this one was a double free", () => {
    // The `opt(e, on) { return on ? e : undefined }` helper shape that test/unions.test.ts
    // and test/unions/narrow-nullable.ts both used to rest on. With a plain (non-boxed)
    // return type ASan calls it "attempting double-free"; the program printed NOTHING
    // where node prints its output, because the allocator's abort discards buffered stdout.
    expect(rejectCode(`
interface A { kind: "A"; left: number }
interface B { kind: "B"; text: string }
type E = A | B;
function pick(e: E, f: E): E { return e.kind === "A" ? e : f; }
function g(): string {
  const a: E = { kind: "A", left: 1 };
  const b: E = { kind: "B", text: "x" };
  const r: E = pick(a, b);
  return r.kind;
}
console.log(g());`)).toBe("NT1604");
  });

  test("reading THROUGH the result is a borrow, and still compiles", async () => {
    // The receiver spelling is what keeps the union-join shape `(e.kind === "A" ? e : f).kind`
    // legal — the fix must not swallow it, or it would take the useful half of `?:` with it.
    // The arrays are LOCALS, not literal arguments: an array literal passed straight to a
    // call is a temporary nothing owns, and it leaks on `main` too (pre-existing, and
    // unrelated to `?:`), which would drown out the counter this test is here to read.
    const src = `
function longer(x: string[], o: string[]): number { return (x.length > o.length ? x : o).length; }
function g(): number { const a: string[] = ["a"]; const b: string[] = ["b", "c"]; return longer(a, b); }
console.log(g());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n"); // both arrays freed exactly once by their owners
    expect(r.exitCode).toBe(0);
  });

  test("fresh values in both arms are freed exactly once", async () => {
    const src = `
function f(c: boolean): number { const y: string[] = c ? ["a"] : ["b", "c"]; return y.length; }
console.log(f(true));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("one place arm + one fresh arm: still exactly one free, no leak", async () => {
    // `true ? a : ["z"]` marks `a` moved and makes `y` the owner. Only one arm ever
    // allocates, so this balances to zero — it was a heap-use-after-free before.
    const src = `
function f(): number { const a: string[] = ["x"]; const y: string[] = true ? a : ["z"]; return y.length; }
console.log(f());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("KNOWN COST: two owned locals as the two arms LEAK the arm not taken", async () => {
    // Both arms are marked moved, but only the one that actually ran is reachable through
    // `y`, so the other is never freed. Making this exact needs a per-path drop flag this
    // pass does not have — the same one the NT1608 rule above also declined to invent. A
    // LEAK is the better of the two failures and node's answer is still exact: before the
    // fix this shape was a heap-use-after-free.
    const src = `
function f(c: boolean): number { const a: string[] = ["x"]; const b: string[] = ["y", "z"]; const y: string[] = c ? a : b; return y.length; }
console.log(f(true));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n1\n"); // 1 leaked (was: use-after-free). node prints 1.
    expect(r.exitCode).toBe(0);
  });

  /*
   * The sanitizer gate — the only assertion here that can see the double free this fix is
   * about. Same construction as test/hof-drops.test.ts and test/transients.test.ts: ASan +
   * UBSan, `-fno-sanitize-recover` so every finding is fatal, LSan left OFF (it does not
   * exist on macOS, and the leak half is gated precisely by `__arrLive()` above).
   *
   * Proved by MUTATION: restore `consume: false` on either arm in `ConditionalExpr` and
   * `CHURN` below builds into a binary that dies with
   * `AddressSanitizer: heap-use-after-free ... in nt_arr_free`.
   */
  test("ASan + UBSan: the accepted `?:` shapes are free of double frees and use-after-free", () => {
    // Every array is a LOCAL, so `__arrLive()` reads the drop paths rather than the
    // pre-existing leak of array-literal arguments (see the borrow test above).
    const CHURN = `
function longer(x: string[], o: string[]): number { return (x.length > o.length ? x : o).length; }
function borrowed(): number { const a: string[] = ["a"]; const b: string[] = ["b", "c"]; return longer(a, b); }
function fresh(c: boolean): number { const y: string[] = c ? ["a"] : ["b", "c"]; return y.length; }
function mixed(c: boolean): number { const a: string[] = ["x"]; const y: string[] = c ? a : ["z"]; return y.length; }
let n = 0;
for (let i = 0; i < 200; i = i + 1) {
  n = n + borrowed() + fresh(i % 2 === 0) + mixed(true);
}
console.log(n);
console.log(__arrLive());`;
    const dir = mkdtempSync(join(tmpdir(), "nativets-ternasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIRAsan(CHURN));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        ll, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      const run = spawnSync(bin, [], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      expect(run.stderr).not.toContain("AddressSanitizer");
      expect(run.stderr).not.toContain("runtime error");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("900\n0\n"); // node agrees on 900
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
