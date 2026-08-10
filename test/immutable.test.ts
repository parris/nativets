/*
 * Immutable-by-default (Phase B "sharp turn") — in-place mutation is REJECTED.
 *
 * Arrays and objects are values that are never mutated in place (a deliberate
 * divergence from node, chosen by the owner). Every mutating form is refused with
 * NT1606 and an actionable pointer to the non-mutating replacement — reject-don't-
 * miscompile — and the rejection is surfaced by `coverage`. The immutable
 * replacements (`[...a, x]`, `a.with(i, v)`, `{ ...o, f: v }`) keep working and are
 * covered by the node-differential fixtures (stage7, stage22-cow, drops-cow).
 */

import { test, expect, describe } from "bun:test";

import { sourceToIR } from "../src/driver.ts";
import { coverage } from "../src/coverage.ts";
import { NTError } from "../src/diagnostics.ts";
import { compileAndRun, runWithNode } from "./harness.ts";

/** Compile far enough to hit parse+check; return the NT code if it was rejected. */
function rejectCode(src: string): string | null {
  try {
    sourceToIR(src);
    return null;
  } catch (e) {
    if (e instanceof NTError) return e.diag.code;
    throw e;
  }
}

/** The HINT a rejection carries. A refusal is only as good as the way out it names,
 *  so the hint is asserted like any other behavior. */
function rejectHint(src: string): string | null {
  try {
    sourceToIR(src);
    return null;
  } catch (e) {
    if (e instanceof NTError) return e.diag.hint ?? null;
    throw e;
  }
}

describe("immutable-by-default: in-place mutation is rejected (NT1606)", () => {
  const REJECTED: { name: string; code: string }[] = [
    { name: "array .push", code: `const a: number[] = [1, 2]; a.push(3); console.log(a.length);` },
    { name: "array .pop", code: `const a: number[] = [1, 2]; const x = a.pop(); console.log(x);` },
    { name: "array element assignment arr[i] = v", code: `const a: number[] = [1, 2]; a[0] = 9; console.log(a[0]);` },
    { name: "array compound element assignment arr[i] += v", code: `const a: number[] = [1, 2]; a[0] += 9; console.log(a[0]);` },
    { name: "object field assignment o.f = v", code: `const o: {x:number} = {x: 1}; o.x = 9; console.log(o.x);` },
    { name: "push while iterating (subsumes iterator invalidation)", code: `const a: number[] = [1, 2]; for (const x of a) { a.push(x); }` },
    // `.sort` on an ALIASED receiver. These are the guard rail for the fresh-receiver
    // permission below: sorting an array someone else can still observe is a mutation
    // of THEIR data, and must stay refused. Loosening any of these would turn a correct
    // refusal into a silent wrong answer, which is strictly worse than a false positive.
    { name: "array .sort on a named binding", code: `const a: number[] = [3, 1]; a.sort(); console.log(a.join(","));` },
    { name: "array .sort through an alias of a binding", code: `const a: number[] = [3, 1]; const b: number[] = a; b.sort(); console.log(b.join(","));` },
    { name: "array .sort on a parameter (the CALLER owns it)", code: `function f(xs: number[]): number { xs.sort(); return xs.length; } console.log(f([3, 1]));` },
    { name: "array .sort on a module-level array inside a function", code: `const g: number[] = [3, 1]; function f(): number { g.sort(); return g.length; } console.log(f());` },
    { name: "array .sort on a function's returned array (callee may still own it)", code: `function mk(): number[] { return [3, 1]; } const s: number[] = mk().sort(); console.log(s.join(","));` },
  ];

  for (const c of REJECTED) {
    test(`rejects ${c.name}`, () => {
      expect(rejectCode(c.code)).toBe("NT1606");
    });
  }

  test("coverage surfaces the NT1606 blocker (array .push)", () => {
    const r = coverage(`const a: number[] = [1, 2]; a.push(3);`);
    expect(r.compiles).toBe(false);
    expect(r.firstError?.code).toBe("NT1606");
  });

  test("coverage surfaces the NT1606 blocker (arr[i] = v, a parse-form reject)", () => {
    const r = coverage(`const a: number[] = [1, 2]; a[0] = 9;`);
    expect(r.firstError?.code).toBe("NT1606");
  });

  /*
   * `.push` is refused on EVERY receiver — including a fresh one, unlike `.sort`. See
   * the "why .push gets no fresh-receiver permission" note below for the reasoning; the
   * point of pinning the fresh shapes HERE is that they are refused deliberately, not
   * by omission, and that a later lane widening `freshArray` cannot quietly admit them.
   */
  const PUSH_REJECTED: { name: string; code: string }[] = [
    { name: "push through an alias of a binding", code: `const a: number[] = [1, 2]; const b: number[] = a; b.push(3); console.log(b.length);` },
    { name: "push on a parameter (the CALLER owns it)", code: `function f(xs: number[]): number { xs.push(3); return xs.length; } console.log(f([1, 2]));` },
    { name: "push on a module-level array inside a function", code: `const g: number[] = [1, 2]; function f(): number { g.push(3); return g.length; } console.log(f());` },
    { name: "push on a function's returned array (callee may still own it)", code: `function mk(): number[] { return [1, 2]; } const n: number = mk().push(3); console.log(n);` },
    { name: "push on a FRESH array literal (no fresh-receiver permission)", code: `const n: number = [1, 2].push(3); console.log(n);` },
    { name: "push on a FRESH spread copy (no fresh-receiver permission)", code: `const xs: number[] = [1, 2]; const n: number = [...xs].push(3); console.log(n);` },
    { name: "push on a FRESH .map result (no fresh-receiver permission)", code: `const xs: number[] = [1, 2]; const n: number = xs.map((x) => x).push(3); console.log(n);` },
  ];

  for (const c of PUSH_REJECTED) {
    test(`rejects ${c.name}`, () => {
      expect(rejectCode(c.code)).toBe("NT1606");
    });
  }

  /*
   * A refusal that does not name the working alternative reads as a dead end. `[...arr,
   * x]` alone answers "how do I append once" but NOT "how do I accumulate in a loop",
   * which is the shape that actually hits this diagnostic (five times in
   * src/coverage-preprocess.ts alone). The reassignment form is the answer, and it is
   * not a copy per element: codegen's consuming-append lowers it to an in-place append
   * when nothing else shares the storage.
   */
  test("the .push rejection names the loop accumulator, not just the one-shot spread", () => {
    const hint = rejectHint(`const a: number[] = [1, 2]; a.push(3); console.log(a.length);`);
    expect(hint).toContain("[...arr, x]");
    expect(hint).toContain("acc = [...acc, x]");
    // …and says it does not copy. Without this the hint reads as "rewrite your loop to
    // be quadratic" and nobody believes it — node's `[...out, x]` accumulator really IS
    // O(n²) (12.4s at 100k appends, vs 21ms for the same program built here).
    expect(hint).toContain("not a copy per element");
  });

  /*
   * …but NOT on a PARAMETER receiver, where that same advice was a use-after-free.
   *
   * `out.push(n)` on `out: string[]` used to answer "accumulate with `acc = [...acc, x]`",
   * and applying it literally to `out` gave `out = [...out, n]` — which freed the caller's
   * array on the first iteration and then read it. It printed a different garbage integer
   * on every run, at exit 0, so a differential test could pass by luck. It is NT1608 now
   * (see test/drops.test.ts), but a hint whose advice is another refusal is still a dead
   * end, and this one is read exactly when someone is unsure. So the parameter receiver
   * gets the true answers instead: MARK the parameter `//@@mutable` (the per-parameter
   * opt-in, which shipped after this test was written — for several stages the hint went
   * on asserting that no attribute could help, which is its own kind of false advice), or
   * accumulate into a local and RETURN it.
   *
   * The load-bearing assertion is the NEGATIVE one at the bottom: whatever else this hint
   * grows, it must never send the reader back to rebinding the parameter.
   */
  test("the .push rejection does NOT recommend rebinding when the receiver is a PARAMETER", () => {
    const hint = rejectHint(`
function collect(names: string[], out: string[]): void { for (const n of names) out.push(n); }
const acc: string[] = [];
collect(["a"], acc);
console.log(acc.length);`);
    expect(hint).toContain("PARAMETER");
    expect(hint).toContain("NT1608");
    expect(hint).toContain("RETURN it");
    expect(hint).toContain("MARK it");
    // The load-bearing negative: the accumulator spelling must not be offered here as
    // something to do to `out` itself. It appears only as the named-and-refused form.
    expect(hint).not.toContain("To accumulate in a loop, reassign");
  });

  test("immutable replacements still compile (spread append, .with, object spread)", () => {
    expect(rejectCode(`const a: number[] = [1, 2]; const b: number[] = [...a, 3]; console.log(b.length);`)).toBeNull();
    expect(rejectCode(`const a: number[] = [1, 2]; const b: number[] = a.with(0, 9); console.log(b[0]);`)).toBeNull();
    expect(rejectCode(`const o: {x:number} = {x: 1}; const p: {x:number} = {...o, x: 9}; console.log(p.x);`)).toBeNull();
  });
});

/*
 * WHY `.push` GETS NO FRESH-RECEIVER PERMISSION (and `.sort` does).
 *
 * `.sort` became legal on a fresh receiver by being REWRITTEN to the copying
 * `.toSorted()`: same VALUE, no mutation, so no aliasing question is ever asked.
 * `.push` has no such equivalent — its value is the new LENGTH and its whole point is
 * the side effect on the receiver.
 *
 * A fresh receiver COULD be permitted safely, by the same copying trick: `e.push(x)`
 * on a fresh `e` is exactly `[...e, x].length`, because the mutated array is a
 * temporary nothing can name. But that is the proof it is USELESS — the mutation is
 * unobservable precisely because the result is discarded, so `[1,2].push(3)` is dead
 * code and no real program writes it. The permission would buy zero expressiveness
 * while adding an in-place-mutation path to a method that has already produced one
 * double free (a retained receiver owned by two bindings) and one leak (a realloc that
 * abandoned the old block). The useful shape — `xs.push(x)` on a NAMED accumulator —
 * needs real in-place mutation on a binding, which is the aliasing hazard itself.
 *
 * So `.push` stays refused everywhere, and the accumulator below is the replacement:
 * already legal, node-exact, and single-owner. It is also not a copy per element —
 * codegen's consuming-append lowers `acc = [...acc, x]` to an in-place append when the
 * storage has no other sharer.
 *
 * These assertions pin OWNERSHIP, not just output: stdout was correct throughout the
 * double free that motivated this rule, so every case pins the exit code and
 * `__arrLive()` too.
 */
describe("the accumulator that replaces .push is single-owner", () => {
  test("200 appends leave no live array and no double free", async () => {
    const src = `
function build(n: number): number {
  let out: number[] = [];
  for (let i = 0; i < n; i++) out = [...out, i];
  return out.length;
}
console.log(build(200));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("200\n0\n"); // every intermediate freed; nothing leaked
    expect(r.exitCode).toBe(0); //        a double free would die on a signal here
  });

  test("the accumulated array is freed exactly once when it outlives the loop", async () => {
    const src = `
let out: string[] = [];
for (let i = 0; i < 3; i++) out = [...out, "x"];
console.log(out.join(","));
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("x,x,x\n1\n"); // `out` is still in scope: exactly one live
    expect(r.exitCode).toBe(0);
  });

  /*
   * The hint promises the accumulator is O(1) amortized, so pin the MECHANISM that makes
   * it so. A timing assertion would be flaky under a loaded runner; the lowering is
   * deterministic. `nt_arr_extend_own` is the consuming-append — it MOVES the old block
   * into the new header instead of copying element by element. If a change makes the
   * consuming-append stop firing here, this fails and the hint has become a lie.
   *
   * (Measured, for the record: node's own `[...out, x]` accumulator really is O(n²) —
   * 12.4s for 100k appends, against 21ms for this program built here, scaling linearly
   * at 100k/200k/400k. So the hint's claim is the surprising direction, and worth pinning.)
   */
  test("the accumulator lowers to a consuming append, not a copy per element", () => {
    const ir = sourceToIR(`
function build(n: number): number {
  let out: number[] = [];
  for (let i = 0; i < n; i++) out = [...out, i];
  return out.length;
}
console.log(build(3));`);
    const body = ir.split("\n").filter((l) => !l.startsWith("declare"));
    expect(body.some((l) => l.includes("call void @nt_arr_extend_own"))).toBe(true);
    // …and exactly one free for the superseded array: not zero (a leak), not two (a
    // double free). This is the assertion the .push double-free would have tripped.
    expect(body.filter((l) => l.includes("call void @nt_arr_free")).length).toBe(1);
  });

  const NODE_CASES: { name: string; code: string }[] = [
    {
      name: "numeric accumulator in a loop",
      code: `let out: number[] = []; for (let i = 0; i < 5; i++) out = [...out, i * 2]; console.log(out.join(",")); console.log(out.length);`,
    },
    {
      name: "conditional append (the .filter-by-hand shape)",
      code: `const xs: number[] = [1, 2, 3, 4, 5]; let out: number[] = []; for (const x of xs) { if (x % 2 === 1) out = [...out, x]; } console.log(out.join(","));`,
    },
    {
      name: "accumulator local to a function, returned",
      code: `function evens(n: number): number[] { let out: number[] = []; for (let i = 0; i < n; i++) { if (i % 2 === 0) out = [...out, i]; } return out; } console.log(evens(7).join(","));`,
    },
    {
      name: "appending more than one element at a time",
      code: `let out: number[] = []; for (let i = 0; i < 3; i++) out = [...out, i, i]; console.log(out.join(","));`,
    },
  ];

  for (const c of NODE_CASES) {
    test(`${c.name} matches node`, async () => {
      const oracle = runWithNode(c.code);
      const ours = await compileAndRun(c.code);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});

/*
 * `.sort()` on a FRESH receiver is not a mutation of anyone's data.
 *
 * The immutability rule protects against mutating a SHARED array. A freshly built
 * temporary — `[...xs]`, an array literal — has no sharer, so sorting it is
 * unobservable to any other binding and NT1606 is a false positive there. On such a
 * receiver `.sort()` is exactly `.toSorted()`, which is already node-exact (including
 * node's LEXICOGRAPHIC default order for numbers), so that is what it lowers to.
 * The aliased cases stay refused — see the REJECTED table above.
 */
describe(".sort on a fresh receiver (node-differential)", () => {
  const CASES: { name: string; code: string }[] = [
    {
      name: "spread copy [...xs].sort()",
      code: `const xs: number[] = [3, 1, 2]; const s: number[] = [...xs].sort(); console.log(s.join(",")); console.log(xs.join(","));`,
    },
    {
      // node's no-comparator `.sort()` compares the elements' STRING forms, so on
      // numbers it is LEXICOGRAPHIC: [10, 9] stays [10, 9] and 100 sorts before 2.
      // The case a hand-written test "obviously" gets wrong by assuming numeric order.
      name: "default order is LEXICOGRAPHIC on numbers, not numeric",
      code: `const xs: number[] = [10, 9, 1, 100, 2]; console.log([...xs].sort().join(","));`,
    },
    {
      name: "array literal [3,1,2].sort()",
      code: `console.log([3, 1, 2].sort().join(","));`,
    },
    {
      name: "with a comparator (numeric order, unlike the default)",
      code: `const xs: number[] = [10, 9, 1, 100, 2]; console.log([...xs].sort((a, b) => a - b).join(","));`,
    },
    {
      name: ".map() result",
      code: `const xs: number[] = [3, 1, 2]; console.log(xs.map((x) => x * 2).sort().join(",")); console.log(xs.join(","));`,
    },
    {
      name: ".filter() result",
      code: `const xs: number[] = [3, 1, 2, 4]; console.log(xs.filter((x) => x > 1).sort().join(",")); console.log(xs.join(","));`,
    },
    {
      name: ".concat() result",
      code: `const xs: number[] = [3, 1]; const ys: number[] = [2]; console.log(xs.concat(ys).sort().join(",")); console.log(xs.join(","));`,
    },
    {
      name: ".slice(0) result",
      code: `const xs: number[] = [3, 1, 2]; console.log(xs.slice(0).sort().join(",")); console.log(xs.join(","));`,
    },
    {
      name: "string elements sort by code unit",
      code: `const xs: string[] = ["pear", "Apple", "fig"]; console.log([...xs].sort().join(",")); console.log(xs.join(","));`,
    },
    {
      name: "inside a function, on a spread of a parameter",
      code: `function sorted(xs: number[]): number[] { return [...xs].sort(); } const a: number[] = [3, 1, 2]; console.log(sorted(a).join(",")); console.log(a.join(","));`,
    },
  ];

  for (const c of CASES) {
    test(`${c.name} compiles and matches node`, async () => {
      const oracle = runWithNode(c.code);
      const ours = await compileAndRun(c.code);
      expect(ours.stdout).toBe(oracle.stdout);
      expect(ours.exitCode).toBe(oracle.exitCode);
    });
  }
});
