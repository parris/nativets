import { leadPoint, leadExpr, boxed, countOf } from "./lib.ts";

/*
 * The entry module declares its OWN `Point` and its OWN recursive `Expr`, both with a
 * different layout, and calls the imported generic with an explicit type argument naming
 * them. The entry keeps its source names, so this pins the other half of the guarantee:
 * the rename must NOT reach the entry's spelling, and the two modules' identically-named
 * declarations must monomorphize APART rather than one reading through the other's slots.
 */
class Point {
  label: string;
  constructor(label: string) { this.label = label; }
}

interface Leaf { tag: "Leaf"; label: string }
interface Wrap { tag: "Wrap"; kid: Expr }
type Expr = Leaf | Wrap;

console.log(leadPoint());
console.log(leadExpr());
console.log(boxed());

const mine: Point[] = [new Point("own"), new Point("other"), new Point("third")];
console.log(countOf<Point>(mine));

const tree: Expr[] = [{ tag: "Wrap", kid: { tag: "Leaf", label: "deep" } }];
console.log(countOf<Expr>(tree));
