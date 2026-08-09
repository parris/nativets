/*
 * Object drop / deterministic-free tests (mirrors drops.test.ts for arrays).
 *
 * Compiler-inserted RAII frees are invisible in normal output, so we expose a
 * runtime counter `__objLive()` (objects allocated − freed) to observe them.
 * NOTE: these use the `move` intrinsic and `__objLive` builtin, neither of which
 * exists under node — so, exactly like drops.test.ts, they are compile-and-run
 * only (NOT node-differential fixtures under test/fixtures/, which node oracles).
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";

describe("object drops (deterministic free)", () => {
  test("owned object is freed at scope exit", async () => {
    const src = `
function make(): number { const a: {x:number} = {x: 42}; return a.x; }
console.log(make());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("42\n0\n"); // a dropped when make() returns
    expect(r.exitCode).toBe(0);
  });

  test("many owned objects in a loop all return to 0 live", async () => {
    const src = `
function mk(n: number): number {
  const a: {x:number, y:number} = {x: n, y: n + 1};
  return a.x + a.y;
}
let total: number = 0;
for (let i = 0; i < 100; i = i + 1) { total = total + mk(i); }
console.log(total);
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("10000\n0\n"); // every object freed at its scope exit
    expect(r.exitCode).toBe(0);
  });

  test("a moved-out (returned) object is not freed by the callee", async () => {
    const src = `
function mk(): {x:number} { const a: {x:number} = {x: 7}; return a; }
const b = mk();
console.log(b.x);
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n1\n"); // b still alive; mk did not drop the moved-out value
    expect(r.exitCode).toBe(0);
  });

  test("move transfers ownership and frees exactly once (no double free)", async () => {
    const src = `
function useIt(): number {
  const a: {x:number} = {x: 5};
  const b = move(a);
  return b.x;
}
console.log(useIt());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n0\n"); // freed once via b; no double free (exit 0)
    expect(r.exitCode).toBe(0);
  });
});

/*
 * Object drop is SHALLOW — `nt_obj_free` is `free(o)` and never walks the slots.
 *
 * These tests PIN that gap rather than fix it. It is the `array/object ELEMENTS`
 * item listed under **Still open** in docs/ROADMAP.md's Phase C: "an array does not
 * recursively free what its slots point at ... leaks by construction, never a double
 * free or a dangling pointer". They exist so the leak is a measured number that
 * cannot silently grow, and so that whoever closes the gap has to change a test on
 * purpose instead of discovering the shape by accident.
 *
 * They are also the reason a GENERIC recursive free is not merely unsafe but
 * impossible: `nt_obj_new` returns a bare `int64_t*` of n slots with NO header, so at
 * `nt_obj_free(void *o)` the runtime knows neither the slot count nor whether any
 * given 64-bit word is a double, a refcounted string, a linear object, or an
 * `NtArray*`. Closing this needs TYPE INFORMATION AT THE FREE SITE (a codegen-emitted
 * per-type destructor), plus the two blockers pinned in the `double free` block below.
 */
describe("object drops are SHALLOW (pinned open gap, ROADMAP Phase C)", () => {
  test("an object reachable only through another object's slot leaks", async () => {
    const src = `
function f(): number { const inner = { b: 2 }; const outer = { a: inner }; return outer.a.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n"); // outer freed, `inner` leaked: SHOULD be 0
    expect(r.exitCode).toBe(0);
  });

  test("the leak is one object per nesting level, not one per tree", async () => {
    const src = `
function f(): number { const a = { n: 1 }; const b = { x: a }; const c = { y: b }; return c.y.x.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("1\n2\n"); // only the outermost `c` is freed
    expect(r.exitCode).toBe(0);
  });

  test("an object in an array leaks though the array HEADER is freed", async () => {
    // __arrLive counts headers, so it reports 0 here and sees nothing wrong.
    const src = `
function f(): number { const o = { b: 2 }; const xs = [o]; return xs[0].b; }
console.log(f());
console.log(__objLive());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n0\n"); // objLive 1 = the leak __arrLive cannot see
    expect(r.exitCode).toBe(0);
  });

  test("an array in an object leaks, and __arrLive DOES see it", async () => {
    const src = `
function f(): number { const xs = [1, 2, 3]; const o = { a: xs }; return o.a[1]; }
console.log(f());
console.log(__objLive());
console.log(__arrLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n1\n"); // the object is freed; its array slot is not
    expect(r.exitCode).toBe(0);
  });

  test("a union member's object field leaks — SH2's `__objLive() -> 0` does not hold", async () => {
    const src = `
type Sq = { kind: "sq"; inner: { n: number } };
function f(): number { const u: Sq = { kind: "sq", inner: { n: 5 } }; return u.inner.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n1\n"); // a union IS an object block, so it leaks identically
    expect(r.exitCode).toBe(0);
  });

  test("a @@mutable record holding an object leaks it too", async () => {
    const src = `
@@mutable
type Box = { held: { n: number } };
function f(): number { const b: Box = { held: { n: 7 } }; return b.held.n; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("7\n1\n");
    expect(r.exitCode).toBe(0);
  });

  test("a refcounted string in a slot does NOT leak (strings are not linear)", async () => {
    // Contrast case: proves the gap is specific to linear slots. `__strLive` is 1
    // only because the object's own release never runs; the count is a refcount,
    // so a recursive `free()` over this slot would corrupt, not merely leak.
    const src = `
function f(): number { const o = { a: "hel" + "lo" }; return o.a.length; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("5\n0\n");
    expect(r.exitCode).toBe(0);
  });
});

/*
 * WHY A TYPE-DIRECTED RECURSIVE FREE IS STILL UNSAFE TODAY.
 *
 * Knowing the static type at the drop site is necessary but NOT sufficient. Both
 * programs below compile today and are correct today precisely BECAUSE the drop is
 * shallow; each would become a DOUBLE FREE the moment an object recursively freed its
 * slots. They are pinned here as the blockers a future per-type destructor must clear
 * first (by consuming the source, or by refusing these forms).
 *
 * A double free is silent on stdout and shows up only as a nonzero exit — the exact
 * signature of the shipped `nt_arr_reverse` bug — so both assertions matter.
 */
describe("blockers a recursive free must clear first (double-free hazards)", () => {
  test("spread SHALLOW-COPIES a slot, so two objects hold one pointer", async () => {
    // The emitted IR loads o1's slot 0 and stores the SAME i64 into o2's slot 0,
    // then frees both objects. Recursive free => `inner` freed twice.
    const src = `
function f(): number { const inner = { b: 2 }; const o1 = { a: inner }; const o2 = { ...o1 }; return o2.a.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n1\n"); // 3 allocated, 2 freed; `inner` is aliased by o1 and o2
    expect(r.exitCode).toBe(0);
  });

  test("a field can be MOVED OUT while the parent's slot still points at it", async () => {
    // `outer.a` is not invalidated in outer's slot, so outer + taken both reference
    // `inner`. Today that is exactly 2 allocs / 2 frees; recursively freeing outer
    // would make it 3 frees.
    const src = `
function f(): number { const inner = { b: 2 }; const outer = { a: inner }; const taken = outer.a; return taken.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n");
    expect(r.exitCode).toBe(0);
  });

  test("a field returned out of a function outlives its parent's drop", async () => {
    const src = `
function g(): { b: number } { const inner = { b: 2 }; const outer = { a: inner }; return outer.a; }
function f(): number { const r = g(); return r.b; }
console.log(f());
console.log(__objLive());`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("2\n0\n"); // g drops `outer` shallowly while the caller owns `inner`
    expect(r.exitCode).toBe(0);
  });
});

/**
 * THE CHAIN-TEMPORARY DROP, for CLASS INSTANCES — the half Stage 41 never wired.
 *
 * `freeReceiverTemp` (src/codegen.ts) frees an unbound temporary receiver after an
 * ARRAY method call, and lives on the `isArrayTy(recv.ty)` branch of the method
 * dispatch. A class-instance call takes a different branch entirely — it lowers to
 * `C.m(inst, …)` via `genUserCall`, arriving several hundred lines earlier — so no
 * drop was ever emitted there. Measured on the same position in the same loop, before
 * this change:
 *
 *   for (…200…) { t = t + [1,2,3].indexOf(2); }   __arrLive() === 0    freed
 *   for (…200…) { t = t + new P(7).get(); }       __objLive() === 200  LEAKED
 *
 * ROADMAP's Phase C listed only "temporaries in non-chain positions (call arguments)"
 * as open, which was true for arrays and false for class instances.
 *
 * WHAT PROVES THE DROP SAFE. Two facts, and the drop is gated on the second:
 *  1. `new C(…)` is a fresh allocation nothing else can name, and `this` is a
 *     PARAMETER — a BORROW. Storing it (`G = this`, `[this]`, into a container) is
 *     already NT1604, so the receiver pointer cannot escape the method body.
 *  2. The one sanctioned way it leaves is `return this`, which the `@@mutable` setter
 *     does. That is invisible to the array rule's `out.v === recv.v` pointer check,
 *     because a lowered call returns a FRESH SSA name. So the gate is the STATIC
 *     return type: a method that hands back its receiver returns the receiver's class.
 *
 * Everything else still leaks — a leak, never a double free.
 */
describe("a fresh `new C(…)` receiver is dropped after a chain call", () => {
  const P = `class P { constructor(private n: number) {} get(): number { return this.n; } }\n`;

  test("200 chain calls leave 0 live — the array shape's answer, for objects", async () => {
    const r = await compileAndRun(`${P}let t = 0;\nfor (let i = 0; i < 200; i++) { t = t + new P(7).get(); }\nconsole.log(t);\nconsole.log(__objLive());\n`);
    expect(r.stdout).toBe("1400\n0\n");
    expect(r.exitCode).toBe(0); // a double free presents HERE, with correct stdout
  });

  /**
   * Spelled LONGHAND, because node refuses a parameter property outright
   * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) and would oracle an empty stdout / exit 1.
   */
  test("the answer is still node's — stdout AND exit code", async () => {
    const source = `class P { n: number; constructor(n: number) { this.n = n; } get(): number { return this.n; } }\n` +
      `let t = 0;\nfor (let i = 0; i < 200; i++) { t = t + new P(7).get(); }\nconsole.log(t);\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("1400\n");
  });

  test("a NAMED receiver is untouched — its binding owns it and drops it once", async () => {
    const r = await compileAndRun(`${P}function f(): number { const p = new P(7); return p.get() + p.get(); }\nconsole.log(f());\nconsole.log(__objLive());\n`);
    expect(r.stdout).toBe("14\n0\n");
    expect(r.exitCode).toBe(0);
  });

  /**
   * THE SHAPE THAT MUST NOT BE DROPPED. `bump()` returns `this`, so the call's result
   * aliases the receiver; freeing it would be a use-after-free on the very next `.n`.
   * It stays open (leaks) rather than being freed.
   */
  test("a method returning `this` is NOT dropped — the result aliases the receiver", async () => {
    const src = `//@@mutable\nclass C { constructor(public n: number) {} bump(): C { this.n = this.n + 1; return this; } }\n` +
      `let t = 0;\nfor (let i = 0; i < 5; i++) { t = t + new C(1).bump().n; }\nconsole.log(t);\nconsole.log(__objLive());\n`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("10\n5\n"); // 5 leaked, and every read is valid
    expect(r.exitCode).toBe(0);
    const oracle = runWithNode(`//@@mutable\nclass C { n: number; constructor(n: number) { this.n = n; } bump(): C { this.n = this.n + 1; return this; } }\n` +
      `let t = 0;\nfor (let i = 0; i < 5; i++) { t = t + new C(1).bump().n; }\nconsole.log(t);\n`);
    expect(oracle.stdout).toBe("10\n");
  });

  /**
   * A method returning a FIELD is droppable: `nt_obj_free` frees the receiver's slot
   * array and nothing it points at (exactly as `nt_arr_free` frees a header only), so
   * the returned pointer stays valid. The array it hands back still leaks — that is the
   * `new P([…])` argument's own storage, a separate open case.
   */
  test("a method returning a FIELD is dropped, and the field survives it", async () => {
    const src = `class Q { constructor(public xs: number[]) {} f(): number[] { return this.xs; } }\n` +
      `const r = new Q([1, 2, 3]).f();\nconsole.log(r[0] + r[1] + r[2]);\nconsole.log(__objLive());\n`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("6\n0\n");
    expect(r.exitCode).toBe(0);
  });

  /**
   * STAYS OPEN, and the reason is not this rule. A field-assigning method has its return
   * type REWRITTEN to the class and an implicit `return this` inserted (src/parser.ts,
   * "or nothing, which inserts it") — even when it is declared `: void`. So the gate sees
   * `ret === C` and correctly declines: the call really does hand the receiver back.
   *
   * That rewrite is a separate, pre-existing SILENT WRONG ANSWER, reported alongside this
   * change and deliberately not pinned here (pinning it would cement the wrong value):
   *
   *   //@@mutable
   *   class C { n: number; constructor(n: number) { this.n = n; } set(v: number): void { this.n = v; } }
   *   const c = new C(1); console.log(c.set(2));
   *   // node: undefined      nativets: C { n: 2 }      both exit 0
   */
  test("a `void`-DECLARED @@mutable setter is NOT dropped — it returns the receiver anyway", async () => {
    const src = `//@@mutable\nclass C { constructor(public n: number) {} set(v: number): void { this.n = v; } }\n` +
      `for (let i = 0; i < 50; i++) { new C(1).set(2); }\nconsole.log(__objLive());\n`;
    const r = await compileAndRun(src);
    expect(r.stdout).toBe("50\n"); // leaked, never freed twice
    expect(r.exitCode).toBe(0);
  });

  /**
   * BINDING a LINEAR field off a BORROWED receiver — the sibling of the two tests above,
   * and the one that was a USE-AFTER-FREE rather than a leak.
   *
   * `const b = o.lines` was neither a move nor an alias: nothing recorded the binding, so
   * it became an ordinary linear local and scope exit emitted `nt_arr_free(b)` on storage
   * the caller's object still points at. The caller's very next read then printed an EMPTY
   * LINE **at exit 0** — the silent-wrong-answer shape this project ranks worst — and the
   * same program through a `@@mutable` class field SEGFAULTED (exit 139).
   *
   * `collectAliases` now records it as an ALIAS, which is what the model already said the
   * answer was: the object owns the field, the binding only names it, so nobody frees it
   * twice. Node is the oracle here, not `__objLive` — the bug was a WRONG ANSWER, and the
   * assertion that catches it has to be the one node makes.
   */
  test("binding a field off a BORROWED receiver does not free it underneath the owner", async () => {
    const source = `type Box = { lines: string[] };\n`
      + `function probe(o: Box): string { const b = o.lines; return b.join("|"); }\n`
      + `const o: Box = { lines: ["a", "b"] };\n`
      + `console.log(probe(o));\n`
      + `console.log(o.lines.join("|"));\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("a|b\na|b\n"); // we printed "a|b\n\n", exit 0
  });

  /** The same read off a `for-of` ELEMENT — the array owns it for the loop's extent.
   *  This one used to SEGFAULT (exit 139) rather than print a wrong answer. */
  test("binding a field off a for-of ELEMENT does not free it underneath the array", async () => {
    const source = `type Tok = { parts: string[] };\n`
      + `const toks: Tok[] = [{ parts: ["a", "b"] }];\n`
      + `for (const t of toks) { const b = t.parts; console.log(b.join("|")); }\n`
      + `console.log(toks[0]!.parts.join("|"));\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("a|b\na|b\n");
  });

  /** The same read through a `@@mutable` class field — this one used to SEGFAULT (139). */
  test("binding a field off `this` does not free it underneath the receiver", async () => {
    const source = `//@@mutable\nclass Emitter {\n  lines: string[] = ["a", "b"];\n`
      + `  probe(): string { const b = this.lines; return b.join("|") + " / " + String(b.length); }\n}\n`
      + `const e = new Emitter();\nconsole.log(e.probe());\nconsole.log(e.lines.join("|"));\n`;
    const oracle = runWithNode(source);
    const ours = await compileAndRun(source);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(oracle.stdout).toBe("a|b / 2\na|b\n");
  });
});
