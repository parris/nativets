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

  // The blast-radius guard: a name that is not declared in this file keeps the old
  // fallback. Imported types resolve through the linker, and every module in src/ relies
  // on that path — refusing it here would be a far larger change than this diagnostic.
  test("a type name not declared in this file still falls back, unrefused", () => {
    const r = reject(`
const n: SomeTypeFromElsewhere = 3;
console.log(n + 1);`);
    expect(r.code).toBe(""); // compiles, exactly as before
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
});
