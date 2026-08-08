/*
 * Forward-referenced and recursive TYPE NAMES.
 *
 * The parser is single-pass: `typeAliases` accumulates as it goes, and `resolveNamed`
 * fell back to `number` for any name not yet registered. So a type alias written ABOVE
 * its members silently became `number`, and the program was then rejected downstream by
 * NT2001 blaming the VALUE ("'x' declared number but initialized with {…}") — a message
 * that names neither the type nor the real cause. That misdirection is what made
 * `ForStmt.init: VarDecl | Expr | null` in src/ast.ts read as a union-representation
 * problem for a whole round: `Expr` (ast.ts:550, members from 601) had already been
 * erased to `number` before the union code ever saw it.
 *
 * These pin the diagnostic: refuse at the TYPE, name it, and say which of the two causes
 * it is. Only names DECLARED IN THIS FILE are refused — a name from elsewhere still falls
 * back as before, so the imported-type path is untouched.
 *
 * Cases are DERIVED, not mined: there is no TypeScript conformance checkout on this
 * machine (see docs/self-hosting.md and the env notes). Both shapes come from real
 * compiler source — the alias-before-members shape is `Expr` in src/ast.ts, and the
 * self-recursive shape is `BinaryExpr.left: Expr` (src/ast.ts:685).
 */

import { test, expect, describe } from "bun:test";
import { sourceToIR } from "../src/driver.ts";

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
  // The `Expr` shape, minimized: the alias is declared above the members it unions.
  // Every member erases, the union of N identical `number`s collapses to one arm, and
  // the alias silently becomes `number`.
  test("a type alias used before its members are declared is refused, naming the type", () => {
    const r = reject(`
type E = A | B;
interface A { kind: "A"; a: number; }
interface B { kind: "B"; b: number; }
const x: E = { kind: "A", a: 7 };
console.log(x.kind);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'A'"); // the erased TYPE is named...
    expect(r.message).not.toContain("'x'"); // ...and the value is NOT blamed
    expect(r.message).toContain("declared"); // says it is a source-order problem
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

  // MUTUAL recursion. Whichever of the pair is parsed first hits the other as a forward
  // reference, so that is the wording it gets — and reordering genuinely cannot fix it,
  // which is why the forward-reference hint says so rather than promising a fix.
  test("mutually recursive types report as a forward reference, and the hint admits reordering will not help", () => {
    const r = reject(`
interface P { kind: "P"; child: Q; }
interface Q { kind: "Q"; parent: P; }
const p: P = { kind: "P", child: { kind: "Q", parent: null } };
console.log(p.kind);`);
    expect(r.code).toBe("NT1030");
    expect(r.message).toContain("'Q'"); // P is parsed first, so Q is the forward one
    expect(r.message).toContain("before its declaration");
    expect(r.hint).toContain("EACH OTHER"); // the hint does not promise reordering works
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
