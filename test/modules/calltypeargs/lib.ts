/*
 * EXPLICIT call-site type arguments (`countOf<Point>(xs)`, `CallExpr.typeArgs`) inside a
 * NON-ENTRY module, naming that module's own class and its own recursive type.
 *
 * `Renamer.expr`'s `NewExpr` arm rewrote `typeArgs`; its `CallExpr` arm did not. So a
 * `f<T>(…)` in an imported module kept its module's PRE-rename spelling of `T` while the
 * declaration it names was alpha-renamed, and the two spellings of one type met at the
 * call:
 *
 *   [NT2001] '_m0_countOf$Point_x_number_' arg 0 expects Point{x:number}[],
 *                                                    got _m0_Point{x:number}[]
 *
 * — the same "walker that visits the node and misses one of its fields" as `nonnull`,
 * `loopvar` and `arrow-retannot` next door, and the same two-spellings-of-one-type
 * signature `rewriteTy`'s header records. `typeArgs` is set by the PARSER (it is a
 * resolved structural encoding by the time the linker runs, not a bare name), so it is
 * live at link time exactly as `retAnnot` is — unlike `paramTys`, `retTy` and
 * `ForOfStmt.valTy`, which the checker fills in afterwards.
 *
 * Both maps `rewriteTy` threads are covered, because they are separate and fixing one
 * would leave the other: `tags` (a class instance tag, `Point{…}`) and `refs` (a nominal
 * back-edge into a recursive declaration, `@Expr`). The type argument also names the
 * SPECIALIZATION, so a stale spelling on either side is a distinct mangled function — the
 * entry declares its own `Point`/`Expr` with a different layout to pin them apart.
 */
export class Point {
  x: number;
  constructor(x: number) { this.x = x; }
}

export interface Num { kind: "Num"; value: number }
export interface Neg { kind: "Neg"; inner: Expr }
export type Expr = Num | Neg;

export function countOf<T>(xs: T[]): number { return xs.length; }

/** The `tags` half: an explicit type argument naming this module's CLASS. */
export function leadPoint(): number {
  const ps: Point[] = [new Point(7), new Point(9)];
  const head = ps[0]!.x;              // borrowed BEFORE `ps` is handed to the generic
  return countOf<Point>(ps) * 100 + head;
}

/** The `refs` half: an explicit type argument naming this module's RECURSIVE type, so the
 *  encoding carries an `@Expr` back-edge rather than a class tag. */
export function leadExpr(): number {
  const es: Expr[] = [{ kind: "Neg", inner: { kind: "Num", value: 3 } }, { kind: "Num", value: 1 }];
  return countOf<Expr>(es);
}

/** `new C<T>(…)` was ALREADY renamed (the `NewExpr` arm). Kept so the fix cannot be
 *  "achieved" by moving the rewrite off that arm onto this one. */
export function boxed(): number {
  const m = new Map<string, Point>().set("a", new Point(5));
  const got = m.get("a");
  return got === undefined ? -1 : got.x;
}
