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

  // `interface N { next: N | null }` — a linked list. The self-reference resolves while
  // N itself is still being parsed, so it can never be registered in time. Reordering
  // cannot fix this one, which is why it gets its own wording.
  test("a self-recursive type is refused as recursive, not as a forward reference", () => {
    const r = reject(`
interface N { kind: "N"; v: number; next: N | null; }
const b: N = { kind: "N", v: 2, next: null };
console.log(b.v);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'N'");
    expect(r.message).toContain("itself"); // named as recursion, not as ordering
    expect(r.message).not.toContain("'b'");
    // ...and it must NOT be told to reorder, which cannot work here. Sharing the
    // forward-reference hint would be the same misdirection in a new place.
    expect(r.hint).toContain("Reordering cannot help");
    expect(r.hint).not.toContain("move the declaration");
  });

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
  test("mutually recursive types report as recursion, naming the type the cycle closes through", () => {
    const r = reject(`
interface P { kind: "P"; child: Q; }
interface Q { kind: "Q"; parent: P; }
const p: P = { kind: "P", child: { kind: "Q", parent: null } };
console.log(p.kind);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("recursive type 'Q'");
    expect(r.message).toContain("through 'P'");
    expect(r.message).not.toContain("before its declaration"); // NOT an ordering problem
    expect(r.hint).toContain("Reordering cannot help");
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
