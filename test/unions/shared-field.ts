/*
 * A field present in EVERY surviving member, at the SAME slot, with the SAME type, is
 * readable without narrowing all the way down to one member.
 *
 * This is the compiler's own first self-hosting blocker, reduced. `src/ast.ts`:
 *
 *     case "BinaryExpr": case "LogicalExpr": return exprLoc(e.left);
 *
 * tsc accepts it because `left` is in both surviving members. We accept it because it is
 * ALSO at slot 1 in both, with the same type — a union value IS the member pointer, so
 * agreeing slots is what makes the read a single `getelementptr` with no tag test. A
 * field at DIFFERENT slots stays refused (see unions.test.ts), because there is no one
 * offset to load it from.
 *
 * Borrowed from the TypeScript conformance suite's discriminated-union shape
 * (tests/cases/conformance/types/union/discriminatedUnionTypes1.ts), specialized to the
 * fall-through-two-cases spelling that our own AST walker uses.
 */

interface Num { kind: "Num"; value: number; }
interface Bin { kind: "Bin"; left: Node; right: Node; }
interface Log { kind: "Log"; left: Node; right: Node; }
type Node = Num | Bin | Log;

/** Two cases share one arm; `left` is slot 1 in both, so it reads without a tag test. */
function depth(n: Node): number {
  switch (n.kind) {
    case "Num": return 0;
    case "Bin":
    case "Log": {
      const l = depth(n.left);
      const r = depth(n.right);
      return 1 + (l > r ? l : r);
    }
  }
}

/**
 * The ELSE arm of a tag test on a three-member union is the two-member sub-union
 * `Bin | Log` — so this reaches the same rule by the other narrowing path, without a
 * `switch`.
 */
function leftmost(n: Node): number {
  if (n.kind === "Num") return n.value;
  return leftmost(n.left);
}

/** The DISCRIMINANT is the degenerate case of the same rule — same slot, every member. */
function tag(n: Node): string { return n.kind; }

function num(v: number): Node { return { kind: "Num", value: v }; }

const tree: Node = { kind: "Bin", left: { kind: "Log", left: num(1), right: num(2) }, right: num(3) };

console.log(depth(tree));
console.log(leftmost(tree));
console.log(tag(tree));
console.log(depth(num(9)));
console.log(leftmost(num(9)));
