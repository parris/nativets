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

  test("immutable replacements still compile (spread append, .with, object spread)", () => {
    expect(rejectCode(`const a: number[] = [1, 2]; const b: number[] = [...a, 3]; console.log(b.length);`)).toBeNull();
    expect(rejectCode(`const a: number[] = [1, 2]; const b: number[] = a.with(0, 9); console.log(b[0]);`)).toBeNull();
    expect(rejectCode(`const o: {x:number} = {x: 1}; const p: {x:number} = {...o, x: 9}; console.log(p.x);`)).toBeNull();
  });
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
