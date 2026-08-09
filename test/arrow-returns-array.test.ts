/*
 * AN ARROW WHOSE RETURN TYPE IS AN ARRAY WAS FREED AS AN ARRAY.
 *
 *     const arr = [1, 2, 3];
 *     const g = () => arr;
 *     console.log(g().length);     // node: 3      nativets: exit 255, EMPTY stdout
 *
 * Not a refusal, not a diagnostic — a dead process, and the worst thing short of a
 * wrong answer. The mechanism is one character of encoding, in `isArrayTy`:
 *
 *     isArrayTy(t) === t.endsWith("[]")
 *
 * Types are strings. A function type is encoded `(p1,p2)=>ret` (src/ast.ts,
 * `makeFuncTy`), so an arrow returning `number[]` has the type `()=>number[]` — and
 * that string ENDS WITH "[]". Every "is this an array?" question in the compiler
 * answered YES about the FUNCTION. The one that kills the process is the drop set:
 * `isLinearTy` (src/ownership.ts) put `g` in the scope's owned locals, and
 * `emitDrops` (src/codegen.ts) picked `nt_arr_free` over `nt_obj_free` for it.
 *
 * `g` is a CLOSURE: `nt_obj_new(n)` hands back a bare `int64_t[n]` slot block.
 * `nt_arr_free` reinterprets that block as `NtArray { len, cap, data, pv }` and runs
 *     if (a->pv) nt_pv_release(a->pv);   free(a->data);   free(a);
 * — so it calls `free()` on slots 2 and 3 of a one- or two-slot allocation. Those are
 * READS PAST THE END of the block, and the values are freed as pointers. A WILD FREE,
 * not merely a crash: whether the process dies is a question about what the allocator
 * happened to leave in the adjacent words. `() => [[n]]` (`number[][]`) survived it
 * and printed the right answer on this machine while `() => [n, n+1]` died — same IR
 * shape, different neighbouring heap. That is why this is filed as corruption rather
 * than as a crash, and why every case below asserts the EXIT CODE as well as stdout.
 *
 * The `function` spelling was never affected: a FuncDecl is not a value with a type in
 * a scope's drop set, so nothing ever asked whether `f` was an array.
 *
 * Arrays specifically, not "heap values returned from arrows": the sibling predicates
 * are all prefix-anchored (`isObjectTy` needs `{` at 0 or an identifier tag before it,
 * `isUnionTy` needs `U<`, `isTypeRefTy` needs `@`, Map/Set need `Map<`/`Set<`), and a
 * function type starts with `(`. Only `isArrayTy` was suffix-anchored. The
 * object/string/number/Set-returning arrows below are the control group: all already
 * green, and they stay green.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** node is the oracle: same stdout AND same exit code. Both, always — a double free
 *  shows itself in the exit code while stdout still looks perfect. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("an arrow returning an array does not free itself as one", () => {
  test("expression body returning a captured array binding", async () => {
    await same(`const arr = [1, 2, 3];
const g = () => arr;
console.log(g().length);
`);
  });

  test("expression body returning a fresh array literal", async () => {
    await same(`const f = (n: number) => [n, n + 1];
console.log(f(1).length);
`);
  });

  test("BLOCK body returning an array", async () => {
    await same(`const f = (n: number) => { return [n, n + 1]; };
console.log(f(1).length);
`);
  });

  test("an explicit `: number[]` return annotation", async () => {
    await same(`const f = (n: number): number[] => [n];
console.log(f(1).length);
`);
  });

  test("called twice — the closure survives its first call", async () => {
    await same(`const g = () => [1, 2, 3];
console.log(g().length);
console.log(g().length);
`);
  });

  test("a NESTED arrow returning an array", async () => {
    await same(`const f = (n: number) => (m: number) => [n, m];
console.log(f(1)(2).length);
`);
  });

  test("an array-returning arrow called from inside a HOF callback", async () => {
    await same(`const f = (n: number) => [n];
console.log([1, 2].map((x: number) => f(x).length).join(","));
`);
  });

  /*
   * `number[][]` is the case that PRINTED THE RIGHT ANSWER before the fix, with IR
   * byte-identical to the `number[]` one that died. Both ran `nt_arr_free` on a
   * one-slot `nt_obj_new` block; whether `free()` choked was a question about the two
   * words past the end of it. Under `bun run src/cli.ts run` it survived; under this
   * harness's build it does not. SAME SOURCE, same IR, different verdict — which is
   * why the old behaviour is filed as heap corruption and not as "a crash", and why
   * stdout alone is never enough to call one of these green.
   */
  test("a nested array type — the case that USED to survive the wild free", async () => {
    await same(`const f = (n: number) => [[n]];
console.log(f(1).length);
`);
  });
});

/*
 * The CONTROL GROUP. This is arrays specifically, not "any heap value returned from an
 * arrow" — the two are very different bugs and the distinction is the whole diagnosis.
 * Every one of these was already green before the fix, because their return encodings
 * are prefix-anchored and a function type starts with `(`. They are here to keep the
 * fix from being mistaken for a general closure-lifetime change, and to catch a future
 * regression that widens it into one.
 */
describe("control: arrows returning every OTHER heap shape were never affected", () => {
  test("returning an object literal", async () => {
    await same(`const f = (n: number) => ({ a: n });
console.log(f(1).a);
`);
  });

  test("returning a captured object binding", async () => {
    await same(`const o = { a: 1 };
const g = () => o;
console.log(g().a);
`);
  });

  test("returning a Set", async () => {
    await same(`const f = (n: number) => new Set([n]);
console.log(f(5).size);
`);
  });

  test("returning a string", async () => {
    await same(`const s = "hi";
const g = () => s;
console.log(g());
`);
  });

  test("returning a number", async () => {
    await same(`const f = (n: number) => n + 1;
console.log(f(1));
`);
  });
});

/*
 * The `function` spelling of the same code always worked, and the report said so — this
 * confirms it rather than trusting it. A `FuncDecl` is not a VALUE living in a scope's
 * drop set, so nothing ever asked whether `f` was an array. Keeping the pair adjacent is
 * the point: if a future change breaks one spelling the other pins down which.
 */
describe("control: the `function` spelling of each", () => {
  test("function returning a fresh array", async () => {
    await same(`function f(n: number) { return [n, n + 1]; }
console.log(f(1).length);
`);
  });

  test("function returning a captured array binding", async () => {
    await same(`const arr = [1, 2, 3];
function g() { return arr; }
console.log(g().length);
`);
  });
});

/*
 * The IR-level guard, and the sharpest one: `nt_arr_free` must never be handed the
 * closure slot block. Asserting on stdout alone would have let the `number[][]` shape
 * through — it produced the right answer WHILE corrupting the heap.
 *
 * The env block is not freed at all now (`__objLive()` reports 1 at exit). That is the
 * PRE-EXISTING closure behaviour, identical for an arrow returning a number, and it is
 * a leak, never a use-after-free — the side of that trade this project already takes
 * everywhere else. Making the array-returning arrow behave exactly like the
 * number-returning one is the whole of the fix.
 */
describe("the IR itself", () => {
  test("the closure block is never reclaimed as an array", () => {
    const ir = emitIR(`const arr = [1, 2, 3];
const g = () => arr;
console.log(g().length);
`);
    const main = ir.slice(ir.indexOf("define i32 @main"));
    // exactly one nt_arr_free in main: `arr`. NOT `g`.
    expect(main.match(/call void @nt_arr_free/g)?.length ?? 0).toBe(1);
  });

  test("an array-returning arrow leaks its env exactly like a number-returning one", async () => {
    const withArray = await compileAndRun(`function main(): void {
  const f = (n: number) => [n, n + 1];
  console.log(f(1).length);
}
main();
console.log(__objLive());
`);
    const withNumber = await compileAndRun(`function main(): void {
  const f = (n: number) => n + 1;
  console.log(f(1));
}
main();
console.log(__objLive());
`);
    expect(withArray.exitCode).toBe(0);
    expect(withNumber.exitCode).toBe(0);
    // one leaked env block each — the same number, which is the claim being made.
    expect(withArray.stdout.trim().split("\n").at(-1)).toBe(withNumber.stdout.trim().split("\n").at(-1));
    expect(withArray.stdout.trim().split("\n").at(-1)).toBe("1");
  });

  test("the CAPTURED array is still freed, exactly once", async () => {
    const r = await compileAndRun(`function main(): void {
  const arr = [1, 2, 3];
  const g = () => arr;
  console.log(g().length);
}
main();
console.log(__arrLive());
`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("3\n0\n"); // no leak, and no double free either
  });
});
