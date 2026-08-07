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
