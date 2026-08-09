/*
 * A MUTUAL cycle, exported — the shape of src/ast.ts, minimized. `Expr` unions two members
 * and `Call.callee` closes the cycle back through the union, so the encoding mints `@Expr`
 * inside `Call`'s shape and `@Call` inside `Expr`'s. Renaming only a shape's OWN name left
 * every sibling reference dangling in the merged table.
 *
 * `Node` is here to COLLIDE with main.ts's own `Node`, which is recursive too and has a
 * different layout and different field ORDER. The back-edge is nominal, so if the link did
 * not rename this one's references, main's `@Node` would resolve to whichever shape landed
 * in the table last — and the two are structurally distinct, so the wrong one is a wrong
 * slot, not merely a wrong name.
 */
export interface Num { kind: "Num"; value: number }
export interface Call { kind: "Call"; callee: Expr; args: Expr[] }
export type Expr = Num | Call;

// The tag deliberately CONTAINS `@Node` — a `@` is legal inside a string literal and lands
// verbatim in the encoding, so a rename that scans for `@Name` without skipping quoted runs
// rewrites this tag into a different string (`hasTypeRef`'s documented trap, ast.ts).
export interface Node { tag: "lib@Node"; kids: Node[]; label: string }

export function depth(e: Expr): number {
  if (e.kind === "Num") return 1;
  return 1 + depth(e.callee);
}
