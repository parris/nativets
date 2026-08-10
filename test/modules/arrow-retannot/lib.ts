/*
 * An arrow's DECLARED return type (`(x): T => …`, `ArrowFunction.retAnnot`) inside a
 * NON-ENTRY module, where `T` mentions one of that module's recursive types.
 *
 * `Renamer.expr`'s `ArrowFunction` arm rewrote `paramTys` and `retTy` and MISSED
 * `retAnnot` — the same "walker that visits the node and misses one of its fields" as the
 * `nonnull` and `loopvar` cases next door. `retAnnot` is the only one of those three Ty
 * slots that holds anything at LINK time: the parser sets it (expanding the alias into it,
 * so it is a full structural encoding, not a name), while `paramTys` and `retTy` are
 * written by the checker, which runs after the link. So every annotated arrow in every
 * imported module kept its module's PRE-rename `@N`.
 *
 * The unrenamed type does not stay inside the arrow — the arrow's declared type IS what
 * the checker hands back, so it escapes into the enclosing function and collides with that
 * function's own (correctly renamed) `returnAnnot`. Both are the same type, so the refusal
 * printed two identical-looking spellings:
 *
 *   [NT2001] return type U<…inner:@Expr> does not match declared U<…inner:@_m0_Expr>
 *
 * — exactly the failure `rewriteTy`'s header records for the class-TAG half, one field
 * short of fixed.
 */
export interface Num { kind: "Num"; value: number }
export interface Neg { kind: "Neg"; inner: Expr }
export type Expr = Num | Neg;

/** EXPRESSION body: `typeArrowReturn`'s first branch, and the blocking shape minimized
 *  from src/ast.ts:1874 (`mapExprList`). */
export function makeNum(v: number): Expr {
  const g = (n: number): Expr => ({ kind: "Num", value: n });
  return g(v);
}

/** BLOCK body: `typeArrowReturn`'s second branch reaches `retAnnot` down its own path, so
 *  renaming one branch's copy and not the other's would still leave half the bug. */
export function makeNeg(v: number): Expr {
  const g = (n: number): Expr => { return { kind: "Neg", inner: { kind: "Num", value: n } }; };
  return g(v);
}

export function depth(e: Expr): number {
  if (e.kind === "Num") return 1;
  return 1 + depth(e.inner);
}
export function tagOf(e: Expr): string { return e.kind; }
