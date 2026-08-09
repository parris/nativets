/*
 * Writes to a CAPTURED binding, from inside a closure.
 *
 * ---- The bug this file closes ----
 * A closure's environment is a heap block `[fn_ptr, cap0, cap1, …]` whose slots are
 * filled by VALUE at the point the closure is built (`src/codegen.ts`, the
 * `ArrowFunction` case of `genExpr`). Reading a capture loads that slot — correct, and
 * what almost every closure does. WRITING one stored back into the same slot, so
 *
 *     let n: number = 0;
 *     const add = () => { n = n + 1; };
 *     add(); add();
 *     console.log(n);        // node: 2      nativets (before): 0
 *
 * printed `0` and exited 0. No diagnostic, no crash — a silent wrong answer, which
 * CLAUDE.md calls the worst outcome available. JS closures capture by REFERENCE; ours
 * capture by value, and nothing checked that the difference was unobservable.
 *
 * ---- What is done about it ----
 * Refusal, not implementation. `NT1031` rejects an assignment / compound assignment /
 * `++` / `--` whose target is a binding the closure CAPTURED from an enclosing scope.
 * By-reference capture (boxing the cell) is a real feature with a real design; a
 * refusal shipped now is worth more, because every day the miscompile stands is a day
 * programs get wrong answers.
 *
 * ---- …except where the by-value slot IS the variable ----
 * The blanket rule would have deleted a working, differential-tested program:
 * `test/fixtures/stage11/counter.ts`, the escaping-counter idiom, where `count` is
 * never touched again in the frame that declared it. Nothing can observe the stale
 * copy there, so the env slot is the whole variable and node agrees with us. NT1031 is
 * therefore conditioned on OBSERVABILITY (anything outside the closure still mentioning
 * the binding) and on the binding being a `number` — the two other types were measured
 * in the same safe shape and are not safe: an array PANICKED, and a string leaks the
 * value it overwrites. Both are pinned below.
 *
 * ---- The things this file must NOT do ----
 *  1. Refuse READS. They are correct today and are what closures are mostly for.
 *  2. Refuse a SHADOWING local or a parameter — a name that merely LOOKS like the outer
 *     one. That is the false positive this design is most exposed to, so it is tested
 *     directly (`describe("not a capture")`).
 *  3. Refuse the escaping counter, or the inlined `map`/`reduce` accumulator that the
 *     NT1031 hint sends people to.
 *
 * Cases are DERIVED from the construct itself (assignment × binding kind × nesting),
 * not borrowed from a suite: no TypeScript conformance checkout or test262 corpus was
 * opened for this file. node is the oracle for every accepted case.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

/** Compile-only: the diagnostic a source is rejected with, or null if it compiles. */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** node is the specification: same stdout, same exit code. */
async function matchesNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect({ stdout: ours.stdout, exitCode: ours.exitCode })
    .toEqual({ stdout: oracle.stdout, exitCode: oracle.exitCode });
  expect(oracle.stdout).not.toBe(""); // a test that asserts two empty strings proves nothing
}

/* ============================================================
 * READS of a capture keep working. These are the regression wall: the refusal below
 * must not touch them. Every one is checked against node, output included.
 * ============================================================ */
describe("reads of a captured binding still compile and match node", () => {
  test("captured number, read in an expression body", async () => {
    await matchesNode(`
const base: number = 10;
const add = (x: number): number => base + x;
console.log(add(5));
`);
  });

  test("captured string, read in a block body", async () => {
    await matchesNode(`
const prefix: string = "hi ";
const greet = (n: string): string => { return prefix + n; };
console.log(greet("there"));
`);
  });

  test("captured array, read and indexed", async () => {
    await matchesNode(`
const xs: number[] = [3, 1, 4];
const at = (i: number): number => xs[i];
console.log(at(0), at(2));
`);
  });

  test("a captured binding is read AFTER the closure runs — the value is unchanged", async () => {
    await matchesNode(`
let n: number = 7;
const show = (): number => n;
console.log(show(), n);
`);
  });

  test("two levels of nesting, read only", async () => {
    await matchesNode(`
const k: number = 3;
const outer = (): number => {
  const inner = (): number => k * 2;
  return inner() + k;
};
console.log(outer());
`);
  });

  test("a capture read inside a function-scope closure", async () => {
    await matchesNode(`
function f(): number {
  const n: number = 4;
  const twice = (): number => n + n;
  return twice();
}
console.log(f());
`);
  });
});

/* ============================================================
 * WRITES are refused (NT1031), rather than compiled to the wrong answer.
 *
 * Each `source` here was run under BOTH node and the pre-fix compiler; the comment
 * records what each printed. Every one of them exited 0 on both sides — the divergence
 * was in stdout alone, which is what made it invisible.
 * ============================================================ */
/** Refused with NT1031, and the message names the binding and the operator. */
function expectRefused(source: string, op: string, name: string): void {
  const r = rejectionOf(source);
  expect(r?.code).toBe("NT1031");
  expect(r?.message).toContain(op);
  expect(r?.message).toContain(`'${name}'`);
  expect(r?.hint).toContain("capture by VALUE");
}

describe("a write to a captured binding is refused", () => {
  test("assignment to a captured number", () => {
    // node: 2   before: 0   (both exit 0)
    expectRefused(`
function f(): number {
  let n: number = 0;
  const add = () => { n = n + 1; };
  add(); add();
  return n;
}
console.log(f());
`, "n = …", "n");
  });

  test("assignment to a captured string", () => {
    // node: abb   before: a   (both exit 0)
    expectRefused(`
function f(): string {
  let s: string = "a";
  const app = () => { s = s + "b"; };
  app(); app();
  return s;
}
console.log(f());
`, "s = …", "s");
  });

  test("assignment to a captured number[]", () => {
    // node: 3   before: 1   (both exit 0)
    expectRefused(`
function f(): number {
  let xs: number[] = [1];
  const grow = () => { xs = [xs[0] + 1]; };
  grow(); grow();
  return xs[0];
}
console.log(f());
`, "xs = …", "xs");
  });

  test("`n++` on a capture", () => {
    // node: 3   before: 0   (both exit 0)
    expectRefused(`
function f(): number {
  let n: number = 0;
  const bump = () => { n++; };
  bump(); bump(); bump();
  return n;
}
console.log(f());
`, "n++", "n");
  });

  test("`--n` on a capture (the prefix form reports itself, not the postfix one)", () => {
    expectRefused(`
function f(): number {
  let n: number = 9;
  const drop = () => { --n; };
  drop();
  return n;
}
console.log(f());
`, "--n", "n");
  });

  test("`n += 1` on a capture", () => {
    // node: 9   before: 1   (both exit 0)
    expectRefused(`
function f(): number {
  let n: number = 1;
  const bump = () => { n += 4; };
  bump(); bump();
  return n;
}
console.log(f());
`, "n += …", "n");
  });

  test("a captured write at MODULE scope, not just function scope", () => {
    // node: 10   before: 0   (both exit 0). Module-level bindings are promoted to LLVM
    // globals (SH1), so it is worth pinning separately from the frame-alloca case.
    expectRefused(`
let n: number = 0;
const add = () => { n = n + 5; };
add(); add();
console.log(n);
`, "n = …", "n");
  });

  test("nested arrows: the inner one writes a binding captured through TWO levels", () => {
    // node: 6   before: `clang failed` (the by-value lowering did not even survive two
    // levels — a build error rather than a wrong answer, but still not a diagnostic).
    expectRefused(`
function f(): number {
  let n: number = 0;
  const outer = () => {
    const inner = () => { n = n + 3; };
    inner();
  };
  outer(); outer();
  return n;
}
console.log(f());
`, "n = …", "n");
  });

  test("the write is found through control flow, not just at the top of the body", () => {
    expectRefused(`
function f(): number {
  let n: number = 0;
  const go = (k: number) => {
    for (let i: number = 0; i < k; i = i + 1) {
      if (i > 0) { n = n + i; }
    }
  };
  go(3);
  return n;
}
console.log(f());
`, "n = …", "n");
  });

  /* ---- The carve-out's two edges. Both of these are the SAFE shape (nothing outside
   * the closure names the binding), so only the TYPE keeps them out. Measured on the
   * pre-refusal compiler; without these tests the `b.ty === "number"` condition looks
   * arbitrary and would be widened by the next person to read it. ---- */

  test("a captured STRING is refused even in the escaping-counter shape (the slot leaks)", () => {
    // Before: printed `x xx xxx`, matching node — but `writeCapture` emits a bare
    // `store i64` and never releases the string it overwrites, so every call leaks one.
    // Correct output and a leak is not "works": Linux CI runs LeakSanitizer.
    expectRefused(`
function make(): () => string {
  let s: string = "";
  return (): string => { s = s + "x"; return s; };
}
const f = make();
console.log(f(), f(), f());
`, "s = …", "s");
  });

  test("a captured ARRAY is refused even in the escaping-counter shape (it panicked)", () => {
    // Before: `panic: index out of bounds: the length is 0 but the index is 0`, exit 255,
    // where node printed `1 2 3`. Nothing about the array survives the round trip
    // through the env slot.
    expectRefused(`
function make(): () => number {
  let xs: number[] = [0];
  return (): number => { xs = [xs[0] + 1]; return xs[0]; };
}
const f = make();
console.log(f(), f(), f());
`, "xs = …", "xs");
  });

  test("TWO closures over one binding are refused — they would get separate slots", () => {
    // node: 2   before: 0   (both exit 0). `inc` writes its own env copy; `get` reads a
    // different one. This is why the rule asks about uses ANYWHERE outside the closure,
    // not just uses in straight-line code.
    expectRefused(`
function make(): number {
  let n: number = 0;
  const inc = () => { n = n + 1; };
  const get = (): number => n;
  inc(); inc();
  return get();
}
console.log(make());
`, "n = …", "n");
  });

  test("an outer write AFTER the closure is built is refused — the snapshot predates it", () => {
    // node: 11   before: 1   (both exit 0). The env slot was filled with 0 when the
    // closure was created; `n = 10` afterwards never reaches it.
    expectRefused(`
function make(): number {
  let n: number = 0;
  const inc = (): number => { n = n + 1; return n; };
  n = 10;
  return inc();
}
console.log(make());
`, "n = …", "n");
  });

  test("a shadowing `let` in a NESTED BLOCK of the closure is refused, not silently confused", () => {
    // A separate pre-existing bug that this rule happens to close. `collectBlockLocals`
    // only scans the arrow's TOP-LEVEL statements, so a `let n` inside the `if` does not
    // register as a local and `n` is treated as a capture — the write went to the env
    // slot and the read came back from the outer binding. node: `3 7`; before: `9 7`,
    // exit 0 on both. NT1031's wording calls this a capture, which is what the compiler
    // believes; the honest fix is to make block locals scope properly, and then this
    // program should COMPILE rather than be refused.
    expectRefused(`
let n: number = 7;
const g = (k: number): number => {
  if (k > 0) {
    let n: number = 1;
    n = n + k;
    return n;
  }
  return 0;
};
console.log(g(2), n);
`, "n = …", "n");
  });

  test("a write inside an INLINED map callback, itself inside a closure, is refused", () => {
    // A `map` callback is inlined into the ENCLOSING frame, which is why an inlined
    // write to an outer binding works at top level (pinned below). It does not work
    // when that enclosing frame is itself a lifted closure. Measured before the fix:
    // `clang failed … use of undefined value '%sum.addr'` — because `collectIdents`
    // does not descend into a block-bodied nested arrow, so `sum` never even became a
    // capture of `run`. A build error rather than a wrong answer, but still not a
    // diagnostic, and still a program node runs (printing 6).
    expectRefused(`
function f(): number {
  let sum: number = 0;
  const run = (xs: number[]): number => {
    const ys: number[] = xs.map((x: number) => { sum = sum + x; return x; });
    return ys[0];
  };
  run([1, 2, 3]);
  return sum;
}
console.log(f());
`, "sum = …", "sum");
  });
});

/* ============================================================
 * NOT a capture. The false-positive wall: these names only LOOK like the outer ones.
 * Each is checked against node, so it is pinned as behavior and not merely as
 * "did not throw".
 * ============================================================ */
describe("not a capture: a closure's own bindings stay writable", () => {
  test("a closure-local `let` SHADOWING an outer binding is not refused", async () => {
    await matchesNode(`
let n: number = 100;
const g = (): number => {
  let n: number = 1;
  n = n + 1;
  return n;
};
console.log(g(), n);
`);
  });

  test("a PARAMETER of the arrow is not refused, even when an outer binding shares its name", async () => {
    await matchesNode(`
let n: number = 100;
const g = (n: number): number => {
  n = n + 1;
  return n;
};
console.log(g(5), n);
`);
  });

  test("a `++` on the closure's own local is not refused", async () => {
    await matchesNode(`
let i: number = 50;
const count = (k: number): number => {
  let i: number = 0;
  let total: number = 0;
  while (i < k) { i++; total += i; }
  return total;
};
console.log(count(4), i);
`);
  });

  test("a `for-of` element name shadowing an outer binding is not refused", async () => {
    await matchesNode(`
let c: string = "outer";
const join = (xs: string[]): string => {
  let acc: string = "";
  for (const c of xs) { acc = acc + c; }
  return acc;
};
console.log(join(["a", "b"]), c);
`);
  });

  test("an INLINED map callback writing a binding the ENCLOSING frame owns still works", async () => {
    // Not a closure at all: `map`/`filter`/`reduce` callbacks are inlined into the frame
    // that owns `sum`, so the write hits the real alloca. This is the accumulate idiom
    // the NT1031 hint points people at, so it has to keep working — and it is the reason
    // the refusal is scoped to arrows used as VALUES rather than to every arrow.
    await matchesNode(`
const a: number[] = [1, 2, 3];
let sum: number = 0;
const doubled: number[] = a.map((x: number) => { sum = sum + x; return x * 2; });
console.log(sum, doubled[2]);
`);
  });

  test("the escaping counter still compiles — nothing outside the closure names `count`", async () => {
    // `test/fixtures/stage11/counter.ts`, verbatim. The by-value env slot IS the whole
    // variable here: `makeCounter`'s frame is gone before the closure is ever called and
    // never mentions `count` again, so the write-back is not observably different from
    // node's by-reference cell. Two counters are made so the test also pins that they
    // are INDEPENDENT (a boxed-cell implementation must keep this true).
    await matchesNode(`
function makeCounter() {
  let count = 0;
  return () => {
    count++;
    return count;
  };
}
const c = makeCounter();
console.log(c(), c(), c());
const d = makeCounter();
console.log(d(), c());
`);
  });

  test("a NESTED arrow writing its OWN parameter is not refused, outer name notwithstanding", async () => {
    // The outer arrow captures `n` (it reads it) AND contains a write to the name `n`
    // — but that write is to the inner arrow's parameter. A capture check that ignored
    // shadowing inside nested arrows would reject this correct program.
    await matchesNode(`
let n: number = 4;
const outer = (): number => {
  const f = (n: number): number => { n = n + 1; return n; };
  return f(10) + n;
};
console.log(outer(), n);
`);
  });

  /*
   * A NAME shared with an unrelated binding elsewhere is not a use of THIS one.
   *
   * The question NT1031 asks — "is the captured binding used outside the closure?" — was
   * asked of the whole program by bare name, so `t` in any other function answered it.
   * That never mattered much in a single file and became ordinary once SH1 linked module
   * graphs, where the outermost body is every module at once and the linker renames only
   * TOP-LEVEL bindings: two modules that each compiled alone would not compile together
   * (test/modules/closure-name). Only the body that DECLARES the binding is scanned now.
   */
  test("an unrelated function's local of the SAME NAME does not make the counter observed", async () => {
    await matchesNode(`
function makeCounter(): () => number {
  let t = 0;
  return () => { t = t + 1; return t; };
}
function widest(xs: string[]): number {
  let t = 0;
  for (const s of xs) if (s.length > t) t = s.length;
  return t;
}
const c = makeCounter();
console.log(c(), c(), widest(["ab", "c", "defg"]));
`);
  });

  test("a captured ARROW PARAMETER is the escaping-counter shape too", async () => {
    // The counter's state is the OUTER ARROW's parameter rather than a `let`. Same
    // safety argument, and the same one frame to scan: `build`'s body mentions `t`
    // nowhere outside the closure it returns.
    await matchesNode(`
function make(start: number): () => number {
  const build = (t: number): (() => number) => (() => { t = t + 1; return t; });
  return build(start);
}
const c = make(10);
console.log(c(), c(), c());
`);
  });
});

/*
 * ...and the other direction: scanning ONE body must still find every real use of the
 * binding. These are the negatives that keep the narrowed scan honest — each is a
 * program node runs and we must refuse, where the observing code sits in exactly the
 * frame `bindingFrame` picks.
 */
describe("the one scanned body still catches a real observation", () => {
  test("the OUTER ARROW reads the parameter its nested arrow writes", () => {
    // node: 3 (the write reaches the shared cell). The observing `return t` is in the
    // outer ARROW's body, not the enclosing function's — so an implementation that
    // scanned only function bodies, or only the innermost frame, would miss it.
    expectRefused(`
function make(): number {
  const outer = (t: number): number => {
    const inc = () => { t = t + 1; };
    inc();
    return t;
  };
  return outer(1);
}
console.log(make());
`, "t = …", "t");
  });

  test("a SECOND closure over the same binding, where the first is nested deeper", () => {
    // node: 2. `get` is a sibling of `inc` in the declaring body; both would get their
    // own env slot and diverge.
    expectRefused(`
function make(): number {
  let t: number = 0;
  const inc = () => { const bump = () => { t = t + 1; }; bump(); };
  const get = (): number => t;
  inc(); inc();
  return get();
}
console.log(make());
`, "t = …", "t");
  });

  test("a MODULE-LEVEL binding is still judged against the whole program", () => {
    // The declaring body is the module top level, so the scan is program-wide exactly as
    // it always was — and `report`, a function that merely READS `t`, is the observer.
    // node: 1 then 1.
    expectRefused(`
let t: number = 0;
function report(): number { return t; }
function make(): () => number { return () => { t = t + 1; return t; }; }
const c = make();
console.log(c());
console.log(report());
`, "t = …", "t");
  });
});

/*
 * The compiler's OWN source, which is where this refusal costs something real.
 *
 * `src/lexer.ts` cleared the identical blocker by making its scanner cursor ONE
 * `//@@mutable` record (`LexState`) instead of three separate `let`s: mutating a FIELD
 * of an owned local is not a capture write, because the binding never changes — only
 * the object does. `src/coverage-preprocess.ts` had the same shape (a `line`/`prev`
 * cursor moved by two closures inside `tokenize`), and it was that module's FIRST
 * blocker in the standalone column of `test/selfhost-ratchet.test.ts`.
 *
 * This asserts the construct is gone from that module, not that the module compiles —
 * it does not (its `.push` accumulators are NT1606, refused by decision). A first-
 * blocker pipeline stops at one error, so "the first blocker is not NT1031" is exactly
 * the available statement, and it is the one that goes red if the shape comes back.
 */
describe("the compiler's own source holds no capture write", () => {
  test("src/coverage-preprocess.ts is not blocked on NT1031", () => {
    const src = readFileSync(new URL("../src/coverage-preprocess.ts", import.meta.url), "utf8");
    const r = rejectionOf(src);
    expect(r?.code).not.toBe("NT1031");
  });
});
