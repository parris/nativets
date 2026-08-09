/*
 * Forward-referenced and recursive TYPE NAMES.
 *
 * The parser SUBSTITUTES a named type for its shape as it parses: `typeAliases` accumulates
 * as it goes, and `resolveNamed` originally fell back to `number` for any name not yet
 * registered. So a type alias written ABOVE its members silently became `number`, and the
 * program was then rejected downstream by NT2001 blaming the VALUE ("'x' declared number
 * but initialized with {…}") — a message that names neither the type nor the real cause.
 * That misdirection is what made `ForStmt.init: VarDecl | Expr | null` in src/ast.ts read
 * as a union-representation problem for a whole round: `Expr` (ast.ts:550, members from
 * 601) had already been erased to `number` before the union code ever saw it.
 *
 * The erasure became a refusal (NT1030) first. It is now a FEATURE: TypeScript hoists every
 * type declaration in a scope, order is irrelevant for types, and `hoistTypeDecls`
 * (src/parser.ts) resolves the top-level declarations to a fixpoint before the file proper
 * is parsed. What the fixpoint cannot resolve is a CYCLE — a type that contains itself — and
 * that is a different, unsolved problem (`Ty` is a flat structural string, so a
 * self-containing type has no finite encoding). These pin both halves, and pin that the two
 * are told apart: reordering advice for the one it can fix, never for the one it cannot.
 *
 * Only names DECLARED IN THIS FILE are ever refused — a name from elsewhere still falls back
 * as before, so the imported-type path is untouched.
 *
 * Cases are DERIVED, not mined: there is no TypeScript conformance checkout on this machine
 * (see docs/self-hosting.md and the env notes), so the rule these encode is TypeScript's own
 * — type declarations are hoisted; source order carries no meaning for types. Every shape
 * comes from real compiler source: the use-before-declaration shape is `as Identifier` at
 * src/ast.ts:521 against `interface Identifier` at 621, the alias-before-members shape is
 * `Expr` (ast.ts:550), and the cycle is `TemplateLiteral.exprs: Expr[]` closing back through
 * `type Expr` — which is what still gates src/ast.ts.
 */

import { test, expect, describe } from "bun:test";
import { sourceToIR } from "../src/driver.ts";
import { compileAndRun, runWithNode } from "./harness.ts";

/** The differential gate: our binary must agree with node byte-for-byte. */
async function matchesNode(source: string): Promise<void> {
  const [ours, node] = await Promise.all([compileAndRun(source), runWithNode(source)]);
  expect(ours.stdout).toBe(node.stdout);
  expect(ours.exitCode).toBe(node.exitCode);
}

/** The diagnostic a source is refused with. `hint` is the `= help:` line, which is where
 *  the advice lives — it is NOT part of `message`. */
function reject(source: string): { code: string; message: string; hint: string } {
  try {
    sourceToIR(source);
    return { code: "", message: "(compiled)", hint: "" };
  } catch (e) {
    const err = e as { diag?: { code?: string; hint?: string }; message?: string };
    return { code: err.diag?.code ?? "THREW", message: err.message ?? "", hint: err.diag?.hint ?? "" };
  }
}

describe("forward-referenced / recursive type names", () => {
  // TypeScript HOISTS every type declaration in a scope: order is irrelevant for types,
  // which is why `interface I { … }` below its use is not even a warning in tsc. This is
  // the shape blocking src/ast.ts, where `resolveStaticFieldReads` (line 505) casts
  // `as Identifier` and `interface Identifier` is declared at line 621.
  test("an interface used before it is declared compiles and matches node", async () => {
    await matchesNode(`
function label(i: Ident): string { return i.name; }
interface Ident { kind: "Identifier"; name: string; }
const id: Ident = { kind: "Identifier", name: "x" };
console.log(label(id));`);
  });

  // The `Expr` shape, minimized: the alias is declared above the members it unions.
  // Hoisting resolves A and B first, so the alias is the real union, not `number`.
  test("a type alias used before its members are declared compiles and matches node", async () => {
    await matchesNode(`
type E = A | B;
interface A { kind: "A"; a: number; }
interface B { kind: "B"; b: number; }
const x: E = { kind: "A", a: 7 };
console.log(x.kind);`);
  });

  // A CHAIN, written in reverse dependency order. One resolution pass is not enough here:
  // `Outer` needs `Mid`, which needs `Inner`. This is what makes the hoist a FIXPOINT
  // rather than a single pre-pass, so it is pinned separately.
  test("a chain of forward references declared in reverse order compiles and matches node", async () => {
    await matchesNode(`
const o: Outer = { mid: { inner: { v: 41 } } };
console.log(o.mid.inner.v + 1);
interface Outer { mid: Mid; }
interface Mid { inner: Inner; }
interface Inner { v: number; }`);
  });

  // `@@mutable` makes mutability NOMINAL: the record carries its declaration name as a tag
  // (docs/decorators.md), and only a tagged record may be assigned in place. If hoisting
  // resolved the forward use to the UNtagged shape, the mutation below would be refused —
  // or worse, an undecorated record could pick up the tag. The tag has to survive the hoist.
  test("a @@mutable record used before its declaration keeps its tag and mutates, matching node", async () => {
    await matchesNode(`
const c: Cell = { n: 1 };
c.n = c.n + 1;
console.log(c.n);
//@@mutable
type Cell = { n: number };`);
  });

  // The deliberate carve-out: hoisting is TOP-LEVEL only. A `type` declared inside a
  // function can mean something different there (a type parameter in scope resolves to a
  // `#T` marker, not a shape), so hoisting it could change what it resolves to. It stays in
  // source order — and is REFUSED, not silently erased to `number`, with a hint that says
  // which of the two situations this is.
  test("a type declared inside a function is not hoisted, and the refusal says so", () => {
    const r = reject(`
function f(): number {
  const v: Local = { n: 3 };
  type Local = { n: number };
  return v.n;
}
console.log(f());`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'Local'");
    expect(r.hint).toContain("top level");
  });

  // A CLASS also declares a type (`parseClass` registers the instance shape), and classes
  // are NOT part of the hoisting fixpoint. So an interface with a class-typed field must
  // not be hoisted past the class: resolving it early would erase `C` to `number` and the
  // refusal would move to the VALUE (`'get' arg 0 expects {c:number}`) — the exact
  // misdirection NT1030 exists to end. The refusal has to stay on the TYPE.
  test("an interface with a class-typed field is not hoisted past the class, and the refusal names the type", () => {
    const r = reject(`
function get(b: Box): number { return b.c.n; }
class C { n: number; constructor(n: number) { this.n = n; } }
interface Box { c: C; }
const b: Box = { c: new C(7) };
console.log(get(b));`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'Box'"); // the TYPE is named...
    expect(r.message).not.toContain("'get'"); // ...never the value that used it
  });

  // `interface N { next: N | null }` — a linked list — USED to be refused here, and the
  // assertion was that it was named as recursion rather than as an ordering problem. It now
  // COMPILES, via the nominal `@Name` back-edge; the positive case is in the
  // "self-recursion" block below. What is still refused is a MUTUAL cycle, two tests down,
  // and that one still has to be told apart from a forward reference.

  // The blast-radius guard: a name BOUND BY AN IMPORT keeps the old fallback. Imported
  // types resolve through the linker (modules.ts seeds `typeEnv` before the real parse),
  // and a name whose seeding failed upstream must still be reported upstream — so the
  // parser declines to judge any name an import binds, even when nothing seeded it.
  test("an IMPORTED type name still falls back, unrefused", () => {
    const r = reject(`
import type { SomeTypeFromElsewhere } from "./nowhere.ts";
const n: SomeTypeFromElsewhere = 3;
console.log(n + 1);`);
    expect(r.code).not.toBe("NT2003"); // never blamed on the annotation
  });

  // THE HOLE THIS BLOCK CLOSES. A name declared NOWHERE — not in this file, not imported,
  // not a builtin — used to erase to `number` right here, and the program was then refused
  // downstream by an NT2001 blaming whatever VALUE was annotated with it. `g` is fine;
  // `{x: 41}` is fine; the typo is `Nope`. tsc says "Cannot find name 'Nope'" and points
  // at the annotation, and so must we.
  test("a type name declared nowhere is refused AT THE ANNOTATION, not at the call site", () => {
    const r = reject(`
function g(t: Nope): number { return t.x + 1; }
console.log(g({ x: 41 }));`);
    expect(r.code).toBe("NT2003");
    expect(r.message).toContain("Cannot find name 'Nope'");
    expect(r.message).not.toContain("'g'"); // never the function...
    expect(r.message).not.toContain("expects number"); // ...and never the value
  });

  // The SAME erasure, one door over. A CLASS declares a type too, and classes are not part
  // of the hoisting fixpoint (their instance shape only exists once `parseClass` runs), so
  // a class named in an annotation ABOVE its declaration found nothing in `typeAliases` and
  // fell through to `number`. `declaredClassNames` already knew better — it was only
  // consulted in hoist mode, so the main parse walked straight past it into the erasure.
  //
  // Reordering DOES fix this one (the same program with `class MyC` first compiles and
  // matches node), so it is the ordering diagnostic, not "cannot find name".
  test("a class named as a type above its declaration is refused on the TYPE, not the value", () => {
    const r = reject(`
function f(x: MyC): number { return x.n; }
class MyC { n: number; constructor(n: number) { this.n = n; } }
console.log(f(new MyC(7)));`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'MyC'");
    expect(r.message).toContain("before its declaration");
    expect(r.message).not.toContain("'f'"); // not the function that used it
    expect(r.message).not.toContain("expects number"); // not the value it was applied to
    expect(r.hint).toContain("class");
  });

  // THE OVER-REFUSAL GUARD. A generic DECLARATION's own parameter is declared right there
  // in the `<…>`, but `skipGenerics` throws the names away — so `T` in the body reached the
  // fallback looking exactly like a name that exists nowhere. It compiled before NT2003 and
  // it has to keep compiling: the parameter erases to `number` as it always did, and only
  // the false refusal is gone. Caught by probing generic declarations after the fact, not by
  // the corpus, which happens not to contain one.
  test("a generic type/interface declaration's own parameter is not a missing name", async () => {
    await matchesNode(`
interface Box<T> { v: T }
const b: Box<number> = { v: 3 };
console.log(b.v);`);
    await matchesNode(`
type Wrap<T> = { inner: T };
const w: Wrap<number> = { inner: 7 };
console.log(w.inner);`);
  });

  // SPECULATION SAFETY, and it is the biggest structural risk in the whole refusal.
  // `tryCallTypeArgs` parses `<…>` after a primary as a call's type arguments and backtracks
  // on any throw — so `i < n` speculatively resolves `n` as a TYPE NAME and lands on exactly
  // the path NT2003 now throws from. It is safe only because the throw is caught: the throw
  // is what tells the speculation this was not a type. Measured over the corpus, this fires
  // 199 times, so a refusal that escaped the speculative frame would break every comparison
  // in the tree at once.
  test("a comparison whose operands are not types still parses as a comparison", async () => {
    await matchesNode(`
const n = 3;
const s = "abc";
let i = 0;
while (i < n) { i = i + 1; }
console.log(i, i < n, n < s.length, i < s.length);`);
  });

  // The ambient escape: a name TypeScript's own lib declares is never "declared nowhere".
  // The list is deliberately generous — a name wrongly out of it is a false refusal on valid
  // code, which is strictly worse than the erasure NT2003 replaces.
  test("builtin/ambient type names are not refused", async () => {
    await matchesNode(`
function f(x: any, y: unknown, z: Readonly<number>): number { return x + y + z; }
console.log(f(1, 2, 3));`);
  });

  // The whole point of the ambient list is to CHANGE NOTHING for the names on it: whatever
  // a lib-declared name did before — compile, or fail downstream on the erasure — it must
  // still do. The one thing it must never become is "Cannot find name", because these names
  // are declared by TypeScript's own lib and no program has to declare them. So the
  // assertion is only `not NT2003`, deliberately: pinning the specific outcome would make
  // this test fail whenever an unrelated lane teaches nativets one of these types, which is
  // exactly what happened to `ReadonlyMap` here.
  test("an ambient name nativets does not model is never 'Cannot find name'", () => {
    for (const src of [
      `const m: ReadonlyMap<string, number> = new Map();\nconsole.log(m.size);`,
      `const w: WeakMap<string, number> = new Map();\nconsole.log(1);`,
      `function f(x: ArrayLike<number>): number { return 1; }\nconsole.log(f([1]));`,
    ]) expect(reject(src).code).not.toBe("NT2003");
  });

  // ...and the reordered program is the proof that the advice in that hint is true.
  test("moving the class above its first use compiles and matches node", async () => {
    await matchesNode(`
class MyC { n: number; constructor(n: number) { this.n = n; } }
function f(x: MyC): number { return x.n; }
console.log(f(new MyC(7)));`);
  });

  // MUTUAL recursion. Before hoisting this could only be described as "Q used before its
  // declaration" — true but misleading, since moving Q up just moves the failure to P.
  // The hoisting fixpoint knows the difference: Q is stuck on P and P is stuck on Q, so
  // this is a CYCLE and is reported as one, naming the type it closes through.
  //
  // A cycle of RECORDS now compiles (Lane C, the block at the bottom of this file). What is
  // still refused is a cycle whose members have nowhere to put a back-edge: `@Name` is a
  // POINTER into a slot, and an array alias has no slot. The message must still name it as
  // recursion rather than as an ordering problem, which is what this pins.
  test("an unrepresentable mutual cycle reports as recursion, naming the type it closes through", () => {
    const r = reject(`
type P = Q[];
type Q = P[];
const p: P = [];
console.log(p.length);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("recursive type 'Q'");
    expect(r.message).toContain("through 'P'");
    expect(r.message).not.toContain("before its declaration"); // NOT an ordering problem
    expect(r.hint).toContain("Reordering cannot help");
  });

  // A class declares a TYPE too, and it had its OWN erasure — a separate code path from
  // `resolveNamed`, so the refusal above never covered it. `parseClass` resolves the class
  // name inside its own body to a self MARKER (so `bump(): Counter` works before the
  // instance shape exists) and then substituted the marker for the real shape at the end.
  // A FIELD naming the class cannot take that substitution — the shape would contain
  // itself — so the marker was rewritten to `number` instead, unconditionally and with no
  // diagnostic. That is the same recursion `interface N { next: N }` is refused for, in the
  // other spelling, and it must be told the same way.
  // These two USED to assert a refusal. The class spelling was routed through the same
  // `@Name` back-edge as the interface spelling — one shape must not have two
  // representations — so they now assert the behaviour, differentially against node.
  test("a self-recursive CLASS field compiles and matches node", async () => {
    await matchesNode(`
class Scope {
  depth: number;
  parent?: Scope;
  constructor(depth: number) { this.depth = depth; }
}
const root = new Scope(0);
console.log(root.depth);
console.log(root.parent);`);
  });

  // Every CARRIER of a back-edge declares: a bare field, an array, a Map value, a function
  // return. The reference is just a field type, so the carrier is the existing machinery.
  test("a class field carries the back-edge through array/Map/optional/function forms", () => {
    for (const field of ["kids: N[];", "next?: N;", "by: Map<string, N>;", "self: () => N;"]) {
      const r = reject(`
class N {
  v: number;
  ${field}
  constructor(v: number) { this.v = v; }
}
console.log(1);`);
      expect({ field, code: r.code }).toEqual({ field, code: "" });
    }
  });

  // The guard on the guard: a method may still name its own class in a SIGNATURE. That is
  // what the self marker exists for and it is not recursion — the instance shape does not
  // contain itself, the method merely mentions it — so this must keep compiling.
  test("a method naming its own class in a signature still compiles and matches node", async () => {
    await matchesNode(`
class Counter {
  n: number;
  constructor(n: number) { this.n = n; }
  bump(): Counter { return new Counter(this.n + 1); }
}
console.log(new Counter(2).bump().n);`);
  });

  // Declaration order is the whole difference: the same source, reordered, compiles.
  test("the same alias declared after its members compiles", () => {
    const r = reject(`
interface A { kind: "A"; a: number; }
interface B { kind: "B"; b: number; }
type E = A | B;
const x: E = { kind: "A", a: 7 };
console.log(x.kind);`);
    expect(r.code).toBe("");
  });
});

/*
 * RECURSIVE TYPES, step 1 (Lane B): SELF-recursion via the nominal `@Name` encoding.
 *
 * `Ty` is a flat string, so a self-containing type has no finite STRUCTURAL encoding —
 * that is what NT1030 has been saying. The fix is a nominal back-edge: a type that
 * contains itself keeps its structural shape at the top level and encodes the recursive
 * position as a REFERENCE, `@N`, whose shape lives in a table on the Program. So
 * `interface N { v: number; next?: N }` is `{v:number,next:?U@N}` — finite, and still a
 * plain string, so `===` remains type comparison at every one of the ~400 sites that
 * assume it.
 *
 * Only declarations in a CYCLE get a reference; every non-recursive type keeps its exact
 * previous encoding, which is what makes this additive.
 *
 * Cases are DERIVED (no microsoft/TypeScript checkout on this machine — re-verified).
 * The shapes are the compiler's own: `interface N { next?: N }` is the linked-list shape
 * behind src/ast.ts's cycle, and `class Scope { parent: Scope | null }` is literally
 * src/checker.ts:93, the compiler's symbol table.
 */
describe("recursive types — self-recursion (@Name)", () => {
  test("a self-recursive interface compiles when the recursive field is absent", async () => {
    await matchesNode(`
interface N { v: number; next?: N }
const a: N = { v: 1 };
console.log(a.v);
console.log(a.next);`);
  });

  // One level DEEP: the recursive field actually holds a node. This is the case the flat
  // encoding could not express at all — `next` is a pointer back to the same shape.
  test("a self-recursive interface holds a node in its recursive field", async () => {
    await matchesNode(`
interface N { v: number; next?: N }
const inner: N = { v: 2, next: undefined };
const a: N = { v: 1, next: inner };
console.log(a.v);
console.log(a.next);`);
  });

  // `T | null` rather than `T | undefined` — the `?N` arm, and the spelling src/checker.ts's
  // `class Scope { parent: Scope | null }` uses.
  test("a self-recursive interface with a `| null` back-edge compiles", async () => {
    await matchesNode(`
interface N { kind: "N"; v: number; next: N | null; }
const b: N = { kind: "N", v: 2, next: null };
console.log(b.v);
console.log(b.kind);`);
  });

  /*
   * A HEAP OUT-OF-BOUNDS, and it predates this lane — the shape is Lane B's self-recursion.
   *
   *     interface N { v: number; next?: N }
   *     const a: N = { v: 1, next: { v: 2 } };   // exit 255, EMPTY stdout
   *
   * `retypeLiteral` rewrites a literal into its annotated target's SLOT LAYOUT, and it
   * matched on `isObjectTy(baseTy(target))` — which is false for the back-edge `@N`. So the
   * inner literal kept its own one-field shape and codegen emitted `nt_obj_new(1)` for a
   * block every reader types as two slots. Reading `.next` off it walks past the end of the
   * allocation. Binding the same value to a local first (`const inner: N = { v: 2 }`)
   * annotates it directly and was always fine, which is why nothing caught it.
   *
   * The fix is one word in two places: unfold the back-edge before asking whether the target
   * is an object. That is the same unfold `assignable` already does, which is exactly why
   * the program was ACCEPTED and then miscompiled.
   */
  test("an inline literal in a recursive field gets the target's slot layout, not its own", async () => {
    await matchesNode(`
interface N { v: number; next?: N }
const a: N = { v: 1, next: { v: 2 } };
console.log(a.v);
console.log(a.next === undefined);`);
  });

  /*
   * READING THROUGH the inner literal is the access that walked off the end, so it is pinned
   * separately — and NOT differentially, because a second, unrelated divergence sits on top
   * of it: nativets WRITES `undefined` into an optional field with no initializer (an
   * instance is a heap block and every slot is real), so `util.inspect` shows the key where
   * node, which never created it, omits it. That is pre-existing and not recursion-specific
   * (`interface M { v: number; s?: string }` with `const m: M = { v: 1 }` prints
   * `{ v: 1, s: undefined }` against node's `{ v: 1 }`) — a separate lane's call. What this
   * asserts is the part that WAS memory-unsafe: the program runs to completion and prints
   * the nested value instead of dying with an empty stdout.
   */
  test("reading through an inline literal in a recursive field no longer walks off the end", async () => {
    const r = await compileAndRun(`
interface N { v: number; next?: N }
const a: N = { v: 1, next: { v: 2, next: { v: 3 } } };
console.log(a.v);
console.log(a.next);`);
    expect(r.exitCode).toBe(0);                       // was 255
    expect(r.stdout).toBe("1\n{ v: 2, next: { v: 3, next: undefined } }\n"); // was ""
  });

  // The back-edge must have a POINTER to live in. A self-referential alias with no object
  // to hang the reference off is refused rather than encoded into a guess.
  test("a self-recursive alias that is not an object type is refused", () => {
    const r = reject(`
type L = L[];
const x: L = [];
console.log(1);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("not an object type");
  });
});

/*
 * RECURSIVE TYPES, step 2 (Lane C): MUTUAL recursion — an SCC of declarations.
 *
 * Self-recursion (above) needs one back-edge, and the parser can mint it while parsing the
 * declaration itself: the name being declared IS the reference. A mutual cycle cannot be
 * resolved that way — `interface A { b?: B }` needs B's shape, which needs A's — so the
 * hoisting fixpoint STALLS and every member was refused NT1030.
 *
 * The fix is the same encoding applied to the whole strongly-connected component: once the
 * fixpoint proves a set of names is stuck on each other, every member is re-parsed with
 * EVERY name in that set resolving to its `@Name` back-edge. Each member then has a finite
 * shape whose recursive positions are references, and the table on the Program resolves
 * them.
 *
 * This is the shape that gates src/ast.ts: 45 of its 64 top-level type declarations are one
 * SCC, closed by `TemplateLiteral.exprs: Expr[]`.
 */
describe("recursive types — MUTUAL recursion (the SCC)", () => {
  // Gate (a): the smallest possible cycle. Neither declaration can be resolved without the
  // other, and neither is self-recursive, so nothing above this reaches it.
  test("a two-type mutual cycle compiles and matches node", async () => {
    await matchesNode(`
interface A { n: number; b?: B }
interface B { s: string; a?: A }
const a: A = { n: 1 };
console.log(a.n);
console.log(a.b);`);
  });

  /*
   * Gate (b) — the shape that actually gates src/ast.ts: a DISCRIMINATED UNION whose member
   * recurses back through the union. `type Expr = … | Negate`, `interface Negate { operand:
   * Expr }`. `test/unions/ast-shape.ts` had to hold children as arena INDICES to write this
   * at all, and said so as a measurement.
   *
   * THE UNION-MEMBER RULE. A union member may NOT be a bare `@Name`: the representation has
   * no box (SH2), so `unionDiscriminant` needs each member's SHAPE to prove the tag sits at
   * the same slot index in every one. So the encoding expands ONE LEVEL at the member
   * boundary and references only BELOW it —
   *     U<{kind:"Negate",operand:@Expr}|…>     not   U<@Negate|…>
   * — which stays finite because the expansion is one level, not transitive.
   */
  test("a discriminated union whose member recurses through the union narrows correctly", async () => {
    await matchesNode(`
interface Num { kind: "Num"; value: number; }
interface Negate { kind: "Negate"; operand: Expr; }
type Expr = Num | Negate;

function show(e: Expr): string {
  switch (e.kind) {
    case "Num": return "" + e.value;
    case "Negate": return "-(" + show(e.operand) + ")";
  }
  return "?";
}

const inner: Expr = { kind: "Num", value: 7 };
const e: Expr = { kind: "Negate", operand: inner };
console.log(show(e));
console.log(e.kind);`);
  });

  /*
   * A component is encoded ALL OR NOTHING — a back-edge is minted only where it resolves, so
   * one member nativets cannot represent takes the whole cycle down with it. That is sound
   * and it is also a MEASUREMENT HAZARD: forty-four correct declarations then report as
   * plain recursion and the real blocker is invisible behind the refusal in front of it.
   *
   * This is not hypothetical — it is exactly what src/ast.ts does today. 41 of its 45
   * cycle members encode; the four that do not are general unions the subset has no
   * representation for (`ArrowFunction.body: Expr | Stmt[]`, an array arm next to a
   * discriminated-union arm). The MESSAGE stays the recursion refusal, deliberately: it is
   * what `test/selfhost-ratchet.baseline.json` records as this module's blocker identity,
   * and no blocker moved. The HINT is where the truth goes.
   */
  test("a cycle abandoned for one member's own refusal says so, naming that refusal", () => {
    const r = reject(`
interface Leaf { kind: "Leaf"; v: number; }
interface Wrap { kind: "Wrap"; inner: Tree; }
interface Odd  { kind: "Odd"; body: Tree | number[]; }
type Tree = Leaf | Wrap | Odd;
const t: Tree = { kind: "Leaf", v: 1 };
console.log(t.kind);`);
    expect(r.code).toBe("NT1030");
    // The message is the recursion refusal, unchanged — blocker identity does not move.
    expect(r.message).toContain("recursive type");
    // The hint names the member that actually stopped it, and its own code.
    expect(r.hint).toContain("the recursion itself is not what stopped this file");
    expect(r.hint).toContain("'Odd'");
    expect(r.hint).toContain("NT1009");
  });
});

/*
 * RECURSIVE TYPES, step 3 (Lane C): the DEEP-WALK refusals.
 *
 * Three passes walk a value by its STATIC type: `structuredClone`, the actor-message deep
 * copy, and `JSON.stringify`. All three are type-directed, and a recursive type is the one
 * shape where the type is finite but the value it describes need not be — so the walk has to
 * be told to stop, or it aliases (an unhandled `@N` returned unchanged) or unrolls forever.
 *
 * Each one is closed here with its OWN gate rather than by relying on a neighbour's. The
 * actor path was ALREADY refused before this, but incidentally: `msgLeafOk` fell through on
 * `@N` because `isObjectTy("@N")` is false. That is two bugs cancelling, not a guarantee —
 * and the same walk reached by `structuredClone`, which has no leaf check, produced a real
 * silent wrong answer (see the first test).
 */
describe("recursive types — the deep-walk refusals", () => {
  /*
   * THE BUG THIS CLOSES, reproduced. On the tree before this lane:
   *
   *     interface N { v: number; next?: N }
   *     const inner: N = { v: 2 };
   *     const a: N = { v: 1, next: inner };
   *     const b = structuredClone(a);
   *     console.log(a.next === b.next);   // node: false     nativets: TRUE
   *
   * `genDeepClone` is a type-directed walk with no case for `@N`, so it hit the final
   * `return v` — value semantics — and stored the SENDER's pointer into the clone. Not a
   * crash and not a leak: a silent wrong answer, which CLAUDE.md calls the worst outcome
   * available. Refused now, since a correct deep copy of a possibly-cyclic value needs a
   * seen-set the type-directed walk does not have.
   */
  test("structuredClone of a recursive value is refused, not aliased", () => {
    const r = reject(`
interface N { v: number; next?: N }
const inner: N = { v: 2 };
const a: N = { v: 1, next: inner };
const b = structuredClone(a);
console.log(b.v);`);
    expect(r.code).not.toBe("");        // must not compile
    expect(r.message).toContain("structuredClone");
    expect(r.message).toContain("recursive");
  });

  // The ACTOR half of the same walk, pinned as a DELIBERATE refusal. It was already
  // rejected before this lane, but only because `isObjectTy("@N")` is false and a back-edge
  // fell off the end of `msgLeafOk` — the refusal had no author and no test, so nothing
  // stopped a later lane from teaching `msgLeafOk` about `@N` and reopening the alias.
  test("an actor message of a recursive type is refused, deliberately", () => {
    const r = reject(`
interface N { v: number; next?: N }
const a: N = { v: 1 };
send(1, a);`);
    expect(r.code).toBe("NT1021");
  });

  /*
   * `JSON.stringify` is the third walk. It is ALREADY refused (NT1005, by the exhaustive
   * fallthrough) and this pins that, because the refusal is what stands between a recursive
   * type and an unbounded unroll — and it belongs to a different lane, so nothing here would
   * notice it being relaxed. `genJsonStringify` now also guards the back-edge itself, so the
   * safety does not depend on one gate in another file staying where it is.
   */
  test("JSON.stringify of a recursive value is refused", () => {
    const r = reject(`
interface N { v: number; next?: N }
const a: N = { v: 1 };
console.log(JSON.stringify(a));`);
    expect(r.code).toBe("NT1005");
  });

  // The generated serializer is a walk over the static type, so a deep NON-recursive type
  // must still serialize — the guard is about the back-edge, not about nesting.
  test("JSON.stringify of a deep NON-recursive value still matches node", async () => {
    await matchesNode(`
const o = { a: { b: { c: { d: 1 } } }, xs: [[1, 2], [3]] };
console.log(JSON.stringify(o));`);
  });

  /*
   * `@@mutable` + RECURSIVE — the one combination that can build a real CYCLE, refused.
   *
   * A recursive value is a TREE as long as nobody can write into it: linearity forbids two
   * owners, so `a.next = b; b.next = a` is NT1601 and `link(o: N) { this.next = o }` is
   * NT1604. But `@@mutable class N { next?: N; loop() { this.next = this } }` compiled and
   * ran, and `this` is not a second owner — so the graph closes.
   *
   * MEASURED, and it corrected the reason this refusal was written down for. The predicted
   * failure was a LEAK (drop is shallow, so a cycle is never freed). Against a control it is
   * not: `__objLive()` is 1 after the identical class WITHOUT the cycle, so the leak is the
   * pre-existing shallow-drop one and the cycle adds nothing to it. What the cycle actually
   * costs is a SILENT WRONG ANSWER, which is worse:
   *
   *     console.log(b)   node:     <ref *1> N { v: 7, next: [Circular *1] }
   *                      nativets: N { v: 7, next: N { v: 7, next: N { v: 7, next: [N] } } }
   *
   * `genInspect` unfolds the back-edge and stops on util.inspect's DEPTH limit, which is a
   * cap on nesting and not a cycle detector — node tracks identity and prints `[Circular]`.
   * Every walk over a value (inspect, and the deep copies above) assumes a tree. Refused
   * until one of them can see a cycle.
   */
  test("a @@mutable class with a recursive field is refused", () => {
    const r = reject(`
//@@mutable
class N { v: number; next?: N; constructor(v: number) { this.v = v; } loop(): void { this.next = this; } }
const b = new N(7);
b.loop();
console.log(b);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'@@mutable class N' is RECURSIVE");
    expect(r.hint).toContain("CYCLE");
    expect(r.hint).toContain("[Circular *1]"); // what node prints, and we cannot
  });

  // Same refusal in the RECORD spelling. A cycle is not reachable there today — linearity
  // stops it (`a.next = b; b.next = a` is NT1601) — but leaning on that would be the same
  // "it happens to be blocked elsewhere" that made the structuredClone alias possible. One
  // recursion, told one way.
  test("a @@mutable record with a recursive field is refused, in the same words", () => {
    const r = reject(`
//@@mutable
type Cell = { v: number; next?: Cell };
const a: Cell = { v: 1 };
console.log(a.v);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'@@mutable record Cell' is RECURSIVE");
  });

  // The blast radius: `@@mutable` on a NON-recursive declaration is untouched, and so is a
  // recursive declaration without `@@mutable`. Both are what src/*.ts actually contains.
  test("@@mutable without recursion, and recursion without @@mutable, both still compile", async () => {
    await matchesNode(`
//@@mutable
type Cell = { n: number };
const c: Cell = { n: 1 };
c.n = c.n + 1;
interface N { v: number; next?: N }
const a: N = { v: 1, next: { v: 2 } };
console.log(c.n, a.v, a.next === undefined);`);
  });

  /*
   * THE FALSE POSITIVE these guards nearly shipped with, and the reason `hasTypeRef` is a
   * pre-filter and not a decision. `Ty` is a flat string and the test for a back-edge was
   * `t.includes("@")` — but `@` is not a forbidden character in a string-literal TAG or in a
   * property KEY, so `{ "x@y": 1 }` read as recursive and structuredClone refused a program
   * node runs. Same landmine as `objectFields("@N")` returning a phantom record: a substring
   * test over a structural encoding is not a structural question.
   */
  test("an `@` in a property key or a tag value is not a back-edge", async () => {
    await matchesNode(`
const o = { "x@y": 1, b: 2 };
console.log(JSON.stringify(o));
const c = structuredClone(o);
console.log(c.b);`);
    await matchesNode(`
interface U { kind: "user@host"; n: number }
interface G { kind: "group"; n: number }
type T = U | G;
const t: T = { kind: "user@host", n: 1 };
console.log(JSON.stringify(t));`);
  });

  // Non-recursive structuredClone is untouched — the refusal is about the back-edge, not
  // about deep copying.
  test("structuredClone of a NON-recursive nested value still deep-copies", async () => {
    await matchesNode(`
const o = { a: { n: 1 }, b: [1, 2] };
const c = structuredClone(o);
console.log(c.a.n, c.b[1], o.a === c.a);`);
  });
});
