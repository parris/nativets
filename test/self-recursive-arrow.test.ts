/*
 * A SELF-RECURSIVE, LOCALLY-BOUND ARROW: `const walk = (s) => { … walk(…) … }`.
 *
 * This shape was `NT1003` — "call to 'walk' (function values / unknown callee) is not
 * supported yet", whose hint read "function values / closures need captured
 * environments". BOTH halves of that hint were false here, and the falsification is the
 * whole reason this lane is narrow rather than a closure implementation:
 *
 *     const dbl     = (n: number): number => n * 2;            // compiled, always
 *     const base = 10;
 *     const addBase = (n: number): number => n + base;         // compiled, always
 *     const fact    = (n: number): number => n <= 1 ? 1 : n * fact(n - 1);   // NT1003
 *
 * Captured environments already SHIPPED — `addBase` builds a real `[fn_ptr, cap0]` block
 * and calls through it. The only thing `fact` adds is that the callee is the binding
 * being declared, and the checker types an initializer BEFORE it declares the binding
 * (src/checker.ts, the `VarDecl` arm: `this.type(d.init, …)` precedes `scope.declare`).
 * So the name was simply not in scope yet, fell past the function-VALUE call path, and
 * was blamed on a feature that was not missing. It is a scoping gap, not a closure gap.
 *
 * WHY IT IS SOUND WITHOUT NEW LAYOUT — the question a refusal-relaxation has to answer.
 * A self-call inside `@arrow_N` is a call to `@arrow_N` with the SAME environment, and
 * `%__clo` is already the first parameter of every lifted arrow. So the call lowers to
 * the ordinary `callClosure(%__clo, …)` — the identical sequence every other closure call
 * emits — and the closure block stays `nt_obj_new(1 + captures)`. Nothing is allocated,
 * nothing is freed, and the self-name is deliberately NOT a capture: capturing it would
 * snapshot `%walk.addr` while the closure is still being BUILT, i.e. read the slot before
 * it is stored and call through garbage. `computeCaptures` excludes it explicitly, and
 * the "shadowed" case below is the test that would catch it if that exclusion were
 * dropped — under a capture it would call the OUTER `walk` and print a wrong answer at
 * exit 0.
 *
 * BOUNDARY, deliberately: `const` only, and only when the arrow's parameters and its
 * return type are all annotated. `let` may be reassigned, so a self-call would have to
 * re-read the binding rather than reuse `%__clo`; and an UNANNOTATED return type cannot
 * be inferred from a body that calls itself without a fixpoint. Both stay `NT1003`, and
 * `describe("still refused")` pins them so the boundary cannot drift open by accident.
 *
 * Cases are node-run in every accept, asserting stdout AND exit code — the recursion
 * ones especially, since a closure-env bug in this area shows up as a correct-looking
 * stdout with a non-zero exit.
 */
import { describe, expect, test } from "bun:test";
import { compileAndRun, emitIR, runWithNode } from "./harness.ts";

/** node is the oracle: same stdout, same exit code. */
async function same(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Compile-only: the diagnostic a source is rejected with (or null if it compiles). */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

describe("a self-recursive const arrow", () => {
  test("recurses on a number, with no captures", async () => {
    await same(`
const fact = (n: number): number => n <= 1 ? 1 : n * fact(n - 1);
console.log(fact(5));
console.log(fact(1));
console.log(fact(0));
`);
  });

  test("recurses AND captures an enclosing binding", async () => {
    await same(`
const step = 2;
const down = (n: number): number => n <= 0 ? 0 : down(n - step) + 1;
console.log(down(10));
console.log(down(1));
`);
  });

  test("recurses from a STATEMENT body, which is the shape src/ uses", async () => {
    await same(`
const sum = (n: number): number => {
  if (n <= 0) return 0;
  return n + sum(n - 1);
};
console.log(sum(10));
`);
  });

  test("is a local inside a function, not only a module-level binding", async () => {
    await same(`
function total(n: number): number {
  const go = (k: number): number => k <= 0 ? 0 : k + go(k - 1);
  return go(n);
}
console.log(total(4));
console.log(total(0));
`);
  });

  test("SHADOWS an outer binding of the same name and still calls ITSELF", async () => {
    // The self-name must not become a capture. If it did, this arrow would capture the
    // OUTER `pick` and print 100 — node prints 3, at exit 0 either way, so only the
    // oracle catches it. On 99c8d60 this exact source produced EMPTY STDOUT at exit 255;
    // see the note above `describe("shadowing, …")` for the three shapes it was wrong in.
    await same(`
const pick = (n: number): number => 100;
function run(): number {
  const pick = (n: number): number => n <= 0 ? 0 : 1 + pick(n - 1);
  return pick(3);
}
console.log(run());
console.log(pick(3));
`);
  });

  test("recursion that never fires still returns the base case", async () => {
    await same(`
const f = (n: number): number => n > 1000 ? f(n) : n;
console.log(f(7));
`);
  });
});

/*
 * Each test below was written because MUTATING the guard it covers left every other test
 * in this file green. They are the cases that make each rule load-bearing rather than
 * decorative, and the mutation each one catches is named on it.
 */
/*
 * A PRE-EXISTING SILENT WRONG ANSWER, closed here as a side effect — and it is the most
 * valuable thing this lane found, because nothing in the suite was looking for it.
 *
 * A self-recursive arrow that SHADOWS a binding of the same name was not refused at all
 * before this change. The checker types a `VarDecl` initializer before declaring the
 * binding, so the body's own name resolved OUTWARD to the shadowed binding and the call
 * compiled — as a call to the WRONG FUNCTION. Measured on 99c8d60, against node:
 *
 *     const f = (n: number): number => n * 100;      // block-shadowed
 *     { const f = (n: number): number => n <= 0 ? 0 : 1 + f(n - 1); return f(3); }
 *         node 3   |   nativets 201   |   exit 0 on both
 *
 *     ...with a second level of shadowing:   node 3   |   nativets 15    | exit 0
 *     ...shadowing a MODULE-level binding:   node 3   |   nativets: empty stdout, exit 255
 *
 * So the shape was not "refused pending closures" — it was three different wrong answers
 * wearing exit 0, plus a trap. The NT1003 the lane was pointed at only fired where NOTHING
 * of that name was in scope to absorb the reference; add a shadow and the refusal vanished
 * along with the correctness. That is why these cases are `same()` against node rather
 * than IR assertions, and why `alphaRenameShadows` had to move too.
 */
describe("shadowing, where every one of these rules is actually load-bearing", () => {
  // MUTATION: drop codegen's `!arrow.params.some(p => p.name === selfName)` in `genArrow`.
  // Then `f(1)` in the body calls `%__clo` — the arrow itself — instead of the PARAMETER
  // that shadows the name. It emitted `call double %t2(ptr %__clo, ptr 0x3FF…)`, passing a
  // double where the closure signature wants a pointer. node calls the parameter.
  test("a PARAMETER of the same name shadows the binding and is what gets called", async () => {
    await same(`
const f = (f: (n: number) => number): number => f(1);
const dbl = (n: number): number => n * 2;
console.log(f(dbl));
`);
  });

  // MUTATION: revert `alphaRenameShadows` to walking the initializer before binding.
  // TWO levels of shadowing are needed: the body's \`f\` then resolves to the MIDDLE
  // binding, which alpha-renaming has already moved to \`f$1\`, while \`selfName\` still
  // says \`f\` — so codegen stops recognising the self-call and falls into \`genUserCall\`
  // with a name no signature table has. One level is not enough: nothing is renamed there,
  // so the two spellings agree by accident and the bug hides.
  test("TWO levels of shadowing still call the innermost arrow itself", async () => {
    await same(`
function run(): number {
  const f = (n: number): number => n * 100;
  {
    const f = (n: number): number => n * 7;
    {
      const f = (n: number): number => n <= 0 ? 0 : 1 + f(n - 1);
      return f(3);
    }
  }
}
console.log(run());
`);
  });

  // MUTATION: drop `computeCaptures`'s self-name exclusion. `scope` is the ENCLOSING
  // scope, so with an outer binding of the same name in it the self-name resolves and is
  // captured — a slot naming the OUTER closure. stdout stays correct (codegen still calls
  // through `%__clo`), and the only visible effect is that the outer binding is now
  // "mentioned" and loses its own drop: `__objLive()` goes 0 -> 1.
  test("a shadowed self-recursive arrow captures nothing, so nothing leaks", async () => {
    const r = await compileAndRun(`
function run(): number {
  const pick = (n: number): number => n * 100;
  {
    const pick = (n: number): number => n <= 0 ? 0 : 1 + pick(n - 1);
    return pick(3);
  }
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("3\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("still refused — the boundary this lane deliberately did NOT cross", () => {
  // MUTATION: let `inferCall` search the whole `selfArrows` stack instead of its top.
  // `outer` is then accepted inside `inner`, but codegen's `%__clo` there is INNER's
  // environment and `outer` is not a capture, so it fell into `genUserCall` and crashed
  // with a TypeError. A clean NT1003 is the correct answer until closures over enclosing
  // arrow bindings actually work.
  test("an inner arrow calling the ENCLOSING self-recursive arrow is still NT1003", () => {
    const d = rejectionOf(`
function run(): number {
  const outer = (n: number): number => {
    const inner = (k: number): number => k <= 0 ? 0 : outer(k - 1);
    return n <= 0 ? 0 : 1 + inner(n);
  };
  return outer(3);
}
console.log(run());
`);
    expect(d?.code).toBe("NT1003");
  });

  // MUTATION: drop the `bound === undefined` guard in `inferCall`, so the self-frame is
  // consulted even when the name IS in scope. This is the one mutation whose damage is a
  // SILENT WRONG ANSWER rather than a crash: a local `const f = 5` shadows the arrow, so
  // node throws `TypeError: f is not a function` and exits 1 — and the mutated compiler
  // printed `0` at exit 0. The self-frame is deliberately the LAST thing consulted, after
  // every real binding, which is what JS shadowing does.
  test("a LOCAL shadowing the self-name is not silently turned into a self-call", () => {
    const d = rejectionOf(`
function run(): number {
  const f = (n: number): number => {
    const f = 5;
    return n <= 0 ? 0 : f(n - 1);
  };
  return f(3);
}
console.log(run());
`);
    expect(d?.code).toBe("NT1003");
  });

  // The self-name is legal in CALL position only. As a value it has no lowering: codegen
  // emitted `load ptr, ptr %down.addr` inside the LIFTED function, where that alloca does
  // not exist, and clang rejected the whole module — a build failure with no NT code at
  // all. Tracking the name on `selfArrows` (read only by `inferCall`) instead of declaring
  // it in the body scope is what keeps this a diagnostic.
  test("the self-name read as a VALUE is refused, not miscompiled", () => {
    const d = rejectionOf(`
function run(): number {
  const down = (n: number): number => {
    const g = down;
    return n <= 0 ? 0 : g(n - 1) + 1;
  };
  return down(5);
}
console.log(run());
`);
    expect(d).not.toBeNull();
    expect(d?.code).toBe("NT2001");
    expect(d?.message).toContain("'down' is not defined");
  });

  test("a `let` arrow may be reassigned, so its self-call is still NT1003", () => {
    const d = rejectionOf(`
let g = (n: number): number => n <= 0 ? 0 : g(n - 1);
console.log(g(3));
`);
    expect(d?.code).toBe("NT1003");
  });

  test("an UNANNOTATED return type cannot be inferred through the recursion", () => {
    const d = rejectionOf(`
const h = (n: number) => n <= 0 ? 0 : h(n - 1);
console.log(h(3));
`);
    expect(d?.code).toBe("NT1003");
  });

  test("MUTUAL recursion between two const arrows is still NT1003", () => {
    const d = rejectionOf(`
const isEven = (n: number): boolean => n === 0 ? true : isOdd(n - 1);
const isOdd = (n: number): boolean => n === 0 ? false : isEven(n - 1);
console.log(isEven(4));
`);
    expect(d?.code).toBe("NT1003");
  });
});

describe("the closure environment is still freed", () => {
  /*
   * THE LEAK THIS FEATURE WOULD HAVE SHIPPED WITH, and it is invisible to every assertion
   * above: stdout and exit code are both correct while the env is never freed.
   *
   * `nonEscapingClosures` (src/ownership.ts) frees a `const f = <arrow>` env only when
   * every other mention of the name is the callee of a DIRECT call, and it counts a
   * mention inside ANY arrow body — because a name an arrow names is normally copied into
   * that arrow's environment, a second handle that may outlive this scope. A self-call is
   * the one case where that is false: `computeCaptures` refuses to capture the self-name
   * and codegen calls through `%__clo`, so the pointer still lives in exactly one slot.
   * Without the exemption every self-recursive closure leaked one env per evaluation —
   * unbounded inside a loop, and red under Linux CI's LeakSanitizer where macOS is silent.
   *
   * `__objLive()` is objects allocated minus freed; it is the only instrument that sees
   * this, exactly as test/closure-env-drops.test.ts documents.
   */
  test("a self-recursive closure's env is freed at scope exit", async () => {
    const r = await compileAndRun(`
function run(): number {
  const down = (n: number): number => n <= 0 ? 0 : down(n - 1) + 1;
  return down(5);
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("5\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("one env per ITERATION is freed, not accumulated", async () => {
    const r = await compileAndRun(`
function run(): number {
  let total = 0;
  let i = 0;
  while (i < 100) {
    const down = (n: number): number => n <= 0 ? 0 : down(n - 1) + 1;
    total = total + down(3);
    i = i + 1;
  }
  return total;
}
console.log(run());
console.log(__objLive());`);
    expect(r.stdout).toBe("300\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // ...and the drop must stay OFF where the closure escapes, which is the direction that
  // is a use-after-free rather than a leak. A returned self-recursive closure is still
  // live after `build` returns, so freeing it there would hand `main` a dangling pointer —
  // correct stdout, exit 255, which is how the original wild free presented.
  test("a RETURNED self-recursive closure is not freed by the scope that built it", async () => {
    const r = await compileAndRun(`
function build(): (n: number) => number {
  const down = (n: number): number => n <= 0 ? 0 : down(n - 1) + 1;
  return down;
}
const f = build();
console.log(f(4));
console.log(f(2));`);
    expect(r.stdout).toBe("4\n2\n");
    expect(r.exitCode).toBe(0);
  });
});

describe("the emitted IR", () => {
  test("adds NO capture slot for the self-name", () => {
    const ir = emitIR(`
const fact = (n: number): number => n <= 1 ? 1 : n * fact(n - 1);
console.log(fact(5));
`);
    // One slot: the function pointer. A captured self-name would make this 2 and read
    // `%fact.addr` before it is ever stored.
    expect(ir).toContain("nt_obj_new(double 0x3FF0000000000000)");
  });
});
