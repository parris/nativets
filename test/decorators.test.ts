/*
 * Decorators — two sigils, two mechanisms (see docs/decorators.md).
 *
 *   @@name   a COMPILE-TIME attribute the checker reads (Rust `#[derive]`-shaped).
 *            Zero runtime footprint: it changes how the class is CHECKED/COMPILED.
 *   @name    a real RUNTIME wrapper (Python-shaped), on a class or a method: an
 *            ordinary user function that takes the thing being decorated and
 *            returns the replacement.
 *
 * ORACLES.
 *  - `@@mutable` classes: node-differential. An `@@mutable` class is EXACTLY a plain
 *    TS class, so the oracle is the same source with the attribute line stripped
 *    (`runWithNodeAttrs`).
 *  - `@wrapper` decorators: node-differential against the hand-written explicit
 *    wrapper application (the desugaring itself), since node's own decorator
 *    proposal has different semantics.
 *  - The ORDINARY (undecorated) copy-on-write class has NO node desugaring — TS
 *    classes mutate — so it is a BEHAVIORAL test with exact expected stdout, like
 *    test/actors.test.ts. Documented in docs/divergences.md.
 */
import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNode, runWithNodeAttrs } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";

/** Compile-only: return the NT code of the rejection, or "" when it compiled. */
function rejectCode(source: string): string {
  try {
    sourceToIR(source);
    return "";
  } catch (e) {
    return (e as { diag?: { code?: string } }).diag?.code ?? `THREW:${(e as Error).message}`;
  }
}

/** Assert our binary matches node on the attribute-stripped source. */
async function expectMatchesStripped(source: string): Promise<string> {
  const oracle = runWithNodeAttrs(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

/* ---------------------------------------------------- 6-8. `@` runtime wrappers */

/** Our `@decorated` source vs the hand-written explicit wrapper application under node. */
async function expectMatchesDesugaring(source: string, nodeSource: string): Promise<string> {
  const oracle = runWithNode(nodeSource);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("`@wrapper` runtime decorators", () => {
  test("a method wrapper: an ordinary user function, called through", async () => {
    const out = await expectMatchesDesugaring(
      `
class Counter {
  pos: number = 3;
  @log scaled(n: number): number { return this.pos * n; }
}
function log(f: (c: Counter, n: number) => number): (c: Counter, n: number) => number {
  return (c: Counter, n: number) => {
    console.log("enter");
    const r = f(c, n);
    console.log("exit " + r);
    return r;
  };
}
const a = new Counter();
console.log(a.scaled(5));
console.log(a.scaled(2));
`,
      `
class Counter {
  pos = 3;
  scaledInner(n) { return this.pos * n; }
}
function log(f) {
  return (c, n) => {
    console.log("enter");
    const r = f(c, n);
    console.log("exit " + r);
    return r;
  };
}
const scaled = log((c, n) => c.scaledInner(n));
const a = new Counter();
console.log(scaled(a, 5));
console.log(scaled(a, 2));
`,
    );
    expect(out).toBe("enter\nexit 15\n15\nenter\nexit 6\n6\n");
  });

  // The decorator is applied ONCE, at the class declaration — Python's `m = log(m)`, not
  // per call. State the wrapper keeps therefore persists across calls.
  test("the wrapper is applied ONCE, so wrapper state persists across calls", async () => {
    const r = await compileAndRun(`
class Counter {
  pos: number = 1;
  @counted tick(n: number): number { return this.pos + n; }
}
function counted(f: (c: Counter, n: number) => number): (c: Counter, n: number) => number {
  let calls = 0;
  return (c: Counter, n: number) => { calls = calls + 1; console.log("call " + calls); return f(c, n); };
}
const a = new Counter();
a.tick(1);
a.tick(1);
console.log(a.tick(1));
`);
    expect(r.stdout).toBe("call 1\ncall 2\ncall 3\n2\n");
    expect(r.exitCode).toBe(0);
  });

  test("a CLASS wrapper wraps the constructor", async () => {
    const out = await expectMatchesDesugaring(
      `
@audited
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  show(): string { return this.x + "," + this.y; }
}
function audited(make: (p: Point, x: number, y: number) => Point): (p: Point, x: number, y: number) => Point {
  return (p: Point, x: number, y: number) => { console.log("new Point " + x + " " + y); return make(p, x, y); };
}
const a = new Point(1, 2);
console.log(a.show());
`,
      `
class Point {
  init(x, y) { this.x = x; this.y = y; return this; }
  show() { return this.x + "," + this.y; }
}
function audited(make) {
  return (p, x, y) => { console.log("new Point " + x + " " + y); return make(p, x, y); };
}
const ctor = audited((p, x, y) => p.init(x, y));
const a = ctor(new Point(), 1, 2);
console.log(a.show());
`,
    );
    expect(out).toBe("new Point 1 2\n1,2\n");
  });

  // Application order: BOTTOM-UP, exactly like Python. `@a @b m()` means `m = a(b(m))`,
  // so the decorator nearest the method runs innermost and `a` is the outermost wrapper.
  test("stacked decorators apply bottom-up (Python order): @a @b m ≡ a(b(m))", async () => {
    const r = await compileAndRun(`
class Box {
  v: number = 10;
  @outer @inner get(n: number): number { console.log("body"); return this.v + n; }
}
function outer(f: (b: Box, n: number) => number): (b: Box, n: number) => number {
  return (b: Box, n: number) => { console.log("outer in"); const r = f(b, n); console.log("outer out"); return r; };
}
function inner(f: (b: Box, n: number) => number): (b: Box, n: number) => number {
  return (b: Box, n: number) => { console.log("inner in"); const r = f(b, n); console.log("inner out"); return r; };
}
console.log(new Box().get(5));
`);
    expect(r.stdout).toBe("outer in\ninner in\nbody\ninner out\nouter out\n15\n");
    expect(r.exitCode).toBe(0);
  });

  test("`@@` on a class MEMBER is rejected (attributes are class-level)", () => {
    expect(rejectCode(`
class C {
  x: number = 1;
  @@mutable get(): number { return this.x; }
}
console.log(new C().get());
`)).toBe("NT1023");
  });

  test("a decorated method needs an explicit return type", () => {
    expect(rejectCode(`
class C {
  x: number = 1;
  @id get(n: number) { return this.x + n; }
}
function id(f: (c: C, n: number) => number): (c: C, n: number) => number { return f; }
console.log(new C().get(1));
`)).toBe("NT1023");
  });
});

/* ------------------------------------------ 5. ownership: exclusive access rule */

/*
 * Decision 3's safety story. `@@mutable` reintroduces real mutation, so the linear model
 * has to keep it single-owner. The rule, in one line: ONLY THE OWNER MAY MUTATE, and a
 * borrow may never escape its owner.
 *
 *   - `const b = a` is an ALIAS (a borrow), not a move — that is what makes "every alias
 *     observes it" expressible at all. Ownership never leaves the original binding, so
 *     the value is dropped exactly once and aliasing can never double-free.
 *   - Calling a SETTER through anything we cannot prove we own — an alias, a by-borrow
 *     parameter, a `for-of` element — is NT1607 (≈ rustc E0596).
 *   - A borrow that would outlive its owner (returning an alias, or returning a method
 *     result, which IS the receiver) is the existing NT1604 (≈ E0507).
 */
const COUNTER = `
@@mutable
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
`;

describe("@@mutable ownership: only the owner may mutate", () => {
  test("the OWNER may mutate, and an alias may READ", async () => {
    const r = await compileAndRun(`${COUNTER}
const a = new Counter();
const b = a;
a.bump();
console.log(b.get());
`);
    expect(r.stdout).toBe("1\n");
  });

  test("mutating through an ALIAS is rejected (NT1607)", () => {
    expect(rejectCode(`${COUNTER}
const a = new Counter();
const b = a;
b.bump();
console.log(a.get());
`)).toBe("NT1607");
  });

  test("mutating through a PARAMETER is rejected (NT1607) — a param is a borrow", () => {
    expect(rejectCode(`${COUNTER}
function tick(c: Counter): number { c.bump(); return c.get(); }
const a = new Counter();
console.log(tick(a));
`)).toBe("NT1607");
  });

  test("reading through a parameter is fine", async () => {
    const r = await compileAndRun(`${COUNTER}
function peek(c: Counter): number { return c.get(); }
const a = new Counter();
a.bump();
console.log(peek(a));
`);
    expect(r.stdout).toBe("1\n");
  });

  test("returning an ALIAS out of its owner's scope is rejected (NT1604)", () => {
    expect(rejectCode(`${COUNTER}
function make(): Counter {
  const a = new Counter();
  const b = a;
  return b;
}
console.log(make().get());
`)).toBe("NT1604");
  });

  test("returning a METHOD RESULT is rejected (NT1604) — it is the receiver, a borrow", () => {
    expect(rejectCode(`${COUNTER}
function make(): Counter {
  const a = new Counter();
  return a.bump();
}
console.log(make().get());
`)).toBe("NT1604");
  });

  // 9. What the analysis cannot prove sound, it REFUSES. These are the aliasing shapes
  // where "who owns this?" has no answer at compile time.
  test("mutating a container ELEMENT is rejected (NT1607)", () => {
    expect(rejectCode(`${COUNTER}
const items: Counter[] = [new Counter()];
items[0].bump();
console.log(items[0].get());
`)).toBe("NT1607");
  });

  test("mutating through a CALLBACK parameter is rejected (NT1607)", () => {
    expect(rejectCode(`${COUNTER}
const items: Counter[] = [new Counter()];
const out = items.map((c: Counter) => c.bump().get());
console.log(out[0]);
`)).toBe("NT1607");
  });

  // 9b. The one shape the refusal above got WRONG. A `new C(…)` receiver is a TEMPORARY:
  // it is not a binding, so nothing in this scope or any other can name it — which makes
  // it strictly MORE uniquely owned than the "local bound to `new C(…)`" the NT1607 hint
  // asks for, and that spelling is accepted. Same fact as commit 1ea7fa2 ("a
  // syntactically-fresh receiver is a temporary nothing can name"); there it made `.push`
  // vacuous, here it makes the call SAFE. node prints 1.
  test("a FRESH `new C(…)` receiver may be mutated in place", async () => {
    const r = await compileAndRun(`${COUNTER}
console.log(new Counter().bump().get());
`);
    expect(r.stdout).toBe("1\n");
    expect(r.exitCode).toBe(0);
  });

  // The boundary. Legalizing the fresh receiver moves NOTHING about escape: a
  // `@@mutable` method returns a BORROW of its receiver, and for a temporary there is no
  // owning binding to return instead — so every shape that hands the chain's result out
  // of the expression is still NT1604, unchanged.
  test("a fresh receiver's result still may not ESCAPE (NT1604 ×3)", () => {
    expect(rejectCode(`${COUNTER}
function f(): Counter { return new Counter().bump(); }
console.log(f().get());
`)).toBe("NT1604");
    expect(rejectCode(`${COUNTER}
const a: Counter[] = [new Counter().bump()];
console.log(a[0].get());
`)).toBe("NT1604");
    expect(rejectCode(`${COUNTER}
const x = move(new Counter().bump());
console.log(x.get());
`)).toBe("NT1604");
  });

  // Memory evidence, since this project has shipped both a leak and a double free. A
  // double free here would show as a NONZERO exit with CORRECT stdout, so both are
  // asserted. The bound spelling frees exactly once (`__objLive()` 0); the fresh spelling
  // LEAKS one object per temporary — which is PRE-EXISTING and not `@@mutable`-specific:
  // an ordinary `class P { get(): number {…} }` measures the identical 200 for
  // `new P(7).get()` on the unmodified tree. A `new C(…)` used as a receiver and never
  // bound is never dropped. This change inherits that accounting; it does not add to it.
  test("the fresh receiver is never freed TWICE — and leaks exactly like the plain-class temporary", async () => {
    const r = await compileAndRun(`${COUNTER}
function bound(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) { const c = new Counter(); c.bump(); c.bump(); t = t + c.get(); }
  return t;
}
function fresh(k: number): number {
  let t = 0;
  for (let i = 0; i < k; i++) { t = t + new Counter().bump().bump().get(); }
  return t;
}
console.log(bound(200));
console.log(__objLive());
console.log(fresh(200));
console.log(__objLive());
`);
    // node prints 400 for both loops. 0 = the owned binding is freed exactly once;
    // 200 = the pre-existing unbound-temporary leak, one per iteration.
    expect(r.stdout).toBe("400\n0\n400\n200\n");
    expect(r.exitCode).toBe(0); // a double free is a nonzero exit with correct stdout
  });

  /*
   * THE SAME NON-ESCAPE RULE, STATED INSIDE THE BODY. Every test above says a `@@mutable`
   * receiver's borrow may not escape — but each of them names the borrow at the CALL SITE
   * (`return a.bump()`, `[new Counter().bump()]`). `this` is the same borrow named from
   * INSIDE, and it was exempt from all of it.
   *
   * `untrackedThis` (ownership.ts) drops `this` from `linear` AND from `paramBorrows` for
   * every method of a `@@mutable` class, so `borrowBindings` never contains it and the
   * NT1604 arm in `expr`'s `Identifier` case can never fire on it. The stated reason names
   * exactly ONE consuming position — `return this`, the fluent chain — and delegates the
   * rest to "the call-site rules". Those rules see the RESULT of a call; they cannot see
   * `this` being packed into a container inside the callee. The RECEIVER side was reasoned
   * about; the VALUE side was not.
   *
   * Measured, not argued. Before the fix this compiled at exit 0 and printed
   * `1 1e-323` where node prints `1 30` — the receiver is freed at the end of `f` while
   * the returned array still points at it, and the denormal is the stale slot re-read.
   * Under `-fsanitize=address` it is `heap-use-after-free` in `main`. The undecorated twin
   * of the identical program is correctly refused NT1604 today, so `@@mutable` is the only
   * thing standing between this program and a silent wrong answer.
   *
   * MUTATION TEST: delete the `borrowThis` argument in `analyzeOwnership`'s `runScope`
   * call and this goes red as a MISCOMPILE (exit 0, `1e-323`), not as a crash.
   */
  test("`this` may not ESCAPE its own method body (NT1604) — the receiver is a borrow named from inside", () => {
    // Into an array literal that is RETURNED — the array outlives the receiver.
    expect(rejectCode(`
//@@mutable
class C { n: number = 30; box(): C[] { return [this]; } }
function f(): C[] { const c = new C(); return c.box(); }
console.log(f()[0].n);
`)).toBe("NT1604");
    // Into an object literal that is RETURNED.
    expect(rejectCode(`
//@@mutable
class C { n: number = 31; wrap(): { inner: C } { return { inner: this }; } }
function f(): { inner: C } { const c = new C(); return c.wrap(); }
console.log(f().inner.n);
`)).toBe("NT1604");
    // Appended to an array FIELD — a second owner reachable from the object itself.
    expect(rejectCode(`
//@@mutable
class C { kids: C[] = []; n: number = 2; add(): void { this.kids.push(this); } }
const c = new C();
c.add();
console.log(c.kids.length);
`)).toBe("NT1604");
    // Handed out through `move(this)` — the explicit consuming position.
    expect(rejectCode(`
//@@mutable
class C { n: number = 40; give(): C { return move(this); } }
function f(): C { const c = new C(); return c.give(); }
console.log(f().n);
`)).toBe("NT1604");
  });

  /*
   * THE EXEMPTION THAT WAS ACTUALLY JUSTIFIED, kept intact. `return this` hands the
   * receiver's own borrow straight back to the caller, and the call-site rules pinned
   * above ("returning a METHOD RESULT is rejected", "a fresh receiver's result may not
   * escape") are what keep THAT single-owner — they can see it, because it is a call
   * result. So the fluent chain must keep compiling; only the positions those rules
   * cannot see are closed. A binding of `this` to a local is exempt for the same reason
   * and by an older mechanism: `collectAliases` already records `const self = this` as an
   * ALIAS of `this`, which makes the initializer a borrow rather than a move (so it never
   * reaches the new rule) and makes `self` itself a borrow binding — so it cannot escape,
   * and it cannot be MUTATED through either (that is the pre-existing NT1607 two tests up).
   */
  test("`return this` and `const self = this` still compile — the fluent chain is untouched", async () => {
    const r = await compileAndRun(`
//@@mutable
class Chain {
  private pos: number = 0;
  bump(): Chain { this.pos++; return this; }
  peek(): number { const self = this; return self.pos; }
  get(): number { return this.pos; }
}
const c = new Chain();
console.log(c.bump().bump().peek(), c.get());
`);
    expect(r.stdout).toBe("2 2\n"); // node agrees
    expect(r.exitCode).toBe(0);
  });

  test("reassigning an owner that is still aliased is rejected (NT1602)", () => {
    expect(rejectCode(`${COUNTER}
let a = new Counter();
const b = a;
a = new Counter();
console.log(b.get());
`)).toBe("NT1602");
  });

  test("an aliased @@mutable instance is still dropped exactly once", async () => {
    const r = await compileAndRun(`${COUNTER}
function scope(): number {
  const a = new Counter();
  const b = a;
  a.bump();
  return b.get();
}
console.log(scope());
console.log(__objLive());
`);
    // 1 from the counter's mutation; 0 live objects afterwards = freed exactly once.
    expect(r.stdout).toBe("1\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

/* ------------------------------------- 4. ordinary class = copy-on-write setter */

/*
 * An ORDINARY (undecorated) class is IMMUTABLE: a field-assigning method produces a NEW
 * instance and leaves the original alone. TypeScript classes mutate, so there is no
 * mechanical desugaring to hand node — these are BEHAVIORAL tests with exact expected
 * stdout (the test/actors.test.ts contract). Documented in docs/divergences.md.
 */
describe("ordinary class: a field-assigning method copy-on-writes", () => {
  test("the receiver is unchanged; the method hands back the new instance", async () => {
    const r = await compileAndRun(`
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a.bump();
const c = b.bump();
console.log(a.get(), b.get(), c.get());
`);
    expect(r.stdout).toBe("0 1 2\n");
    expect(r.exitCode).toBe(0);
  });

  test("the implicit return (Decision 2) also yields the new instance", async () => {
    const r = await compileAndRun(`
class Point {
  x: number = 0;
  y: number = 0;
  moveTo(nx: number, ny: number) { this.x = nx; this.y = ny; }
  show(): string { return this.x + "," + this.y; }
}
const p = new Point();
const q = p.moveTo(3, 4);
console.log(p.show());
console.log(q.show());
`);
    expect(r.stdout).toBe("0,0\n3,4\n");
    expect(r.exitCode).toBe(0);
  });

  test("a setter that throws the copy away is rejected, never miscompiled", () => {
    expect(rejectCode(`
class Counter {
  private pos: number = 0;
  bump(): number { this.pos++; return this.pos; }
  get(): number { return this.pos; }
}
console.log(new Counter().bump());
`)).toBe("NT1023");
  });
});

/* ------------------------------- 5. `.push` to an ARRAY FIELD of a `@@mutable` class */

/*
 * An `@@mutable` class already mutates its fields in place: `this.xs = [...this.xs, v]`
 * compiles today and every handle observes it. `.push` is the SAME observable effect
 * done in O(1) instead of O(n), so the attribute that sanctions the one sanctions the
 * other — and `src/` needs the O(1) form because bun is stage 0 (docs/ROADMAP.md).
 *
 * Oracle: node on the attribute-stripped source. An `@@mutable` class IS a plain TS
 * class, and TS `.push` on a field is exactly this.
 */
describe("`@@mutable` class: `.push` to an array field", () => {
  test("a method appends to its own array field, and every handle observes it", async () => {
    expect(await expectMatchesStripped(`
//@@mutable
class Acc {
  xs: number[] = [];
  add(v: number): void { this.xs.push(v); }
  size(): number { return this.xs.length; }
}
const a = new Acc();
a.add(1); a.add(2); a.add(3);
console.log(a.xs.join(","), a.size());
`)).toBe("1,2,3 3\n");
  });

  /*
   * ITERATOR INVALIDATION — rustc's E0502, our NT1603. `nt_arr_push` reallocates the
   * array's data block and the lowered `for-of` snapshots the length at entry, so
   * appending to the array being iterated printed `6 6` where node prints `24779 40`.
   * That is a SILENT WRONG ANSWER at exit 0, so the shape is refused.
   *
   * This is the guard the whole feature rests on. Delete the `iterationPath` arm in
   * `ownership.ts` and this test goes green-to-red as a MISCOMPILE, not as a crash.
   */
  test("appending to the field being iterated is refused, never miscompiled", () => {
    expect(rejectCode(`
//@@mutable
class A {
  xs: number[] = [1, 2, 3];
  boom(): number {
    let sum = 0;
    for (const x of this.xs) {
      if (this.xs.length < 40) { this.xs.push(x + 100); }
      sum = sum + x;
    }
    return sum;
  }
}
console.log(new A().boom());
`)).toBe("NT1603");
  });

  /* The receiver shapes that KEEP the refusal (`o.xs.push`, an ordinary class's field)
   * live in test/push-accumulator.test.ts, which owns the canonical `.push` receiver
   * table. Only the two behaviours the class attribute is responsible for are here. */
});

/* ------------------------------------------------------------------ 1. syntax */

describe("decorator syntax", () => {
  test("`@@mutable` before a class parses and is a no-op for a read-only class", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  get(): number { return this.pos; }
}
const a = new Counter();
console.log(a.get());
`);
    expect(out).toBe("0\n");
  });

  test("an unknown `@@attribute` is REJECTED, never silently ignored", () => {
    expect(rejectCode(`
@@frobnicate
class C {
  x: number = 1;
  get(): number { return this.x; }
}
console.log(new C().get());
`)).toBe("NT1023");
  });

  test("`@@mutable`: a setter mutates in place and every alias observes it", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  bump(): Counter { this.pos++; return this; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;
a.bump();
console.log(b.get());
a.bump().bump();
console.log(b.get());
`);
    expect(out).toBe("1\n3\n");
  });

  // Decision 2: a method that assigns a field but does not return gets an IMPLICIT
  // return. The MUTATION half is node-differential (node's classes mutate too); the
  // implicit return itself is a divergence (node returns `undefined`), so chaining off
  // a return-less setter is pinned behaviorally below.
  test("`@@mutable`: a setter with no `return` still mutates (differential)", async () => {
    const out = await expectMatchesStripped(`
@@mutable
class Counter {
  private pos: number = 0;
  bump() { this.pos++; }
  get(): number { return this.pos; }
}
const a = new Counter();
const b = a;
a.bump();
a.bump();
console.log(b.get());
`);
    expect(out).toBe("2\n");
  });

  test("`@@mutable`: the implicit return is `this`, so a return-less setter chains", async () => {
    const r = await compileAndRun(`
@@mutable
class Counter {
  private pos: number = 0;
  bump() { this.pos++; }
  get(): number { return this.pos; }
}
const a = new Counter();
a.bump().bump().bump();
console.log(a.get());
`);
    expect(r.stdout).toBe("3\n");
    expect(r.exitCode).toBe(0);
  });

  test("`@@mutable` on a non-class is rejected", () => {
    expect(rejectCode(`
@@mutable
function f(): number { return 1; }
console.log(f());
`)).toBe("NT1023");
  });
});
