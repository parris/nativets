/*
 * SH2 — the case this milestone exists for: nativets' OWN AST dispatch shape.
 *
 * `docs/self-hosting.md` calls discriminated unions "the crux" because `src/ast.ts`
 * declares `Expr` as a union of node interfaces and every later pass matches it with
 * `switch (node.kind)`. This fixture is that shape as an evaluator: a
 * `type Node = NumberLiteral | Negate | BinaryExpr`, an array of them, and both
 * dispatch forms the compiler actually uses (`switch (n.kind)` and an if-chain).
 *
 * ONE deliberate difference from `src/ast.ts`, and it is a MEASUREMENT, not a
 * workaround for convenience: the real `Negate.operand` is an `Expr`, i.e. the type
 * is RECURSIVE — and a recursive type cannot be written in nativets at all today,
 * union or not. `Ty` is a flat string (`{v:number,next:{v:number,…}}` would be
 * infinite), so a self-reference resolves to `number`:
 *
 *     interface N { v: number; next: N }   // `next` erases to `number`, pre-existing
 *
 * so children are held as INDICES into a node array — the arena form a self-hosted
 * compiler would need today. A node is passed BY VALUE (`evaluate(nodes[i])`, an
 * argument position, which borrows) rather than bound out of the array first: a
 * union is a linear value, so `const n = nodes[i]` is NT1605, exactly as it already
 * is for an object element (Stage 28). See the note in test/unions.test.ts.
 *
 * Not borrowed from the TypeScript conformance suite: this is the compiler's own
 * source shape, which is what SH2 is measured against.
 */

interface NumberLiteral {
  kind: "NumberLiteral";
  value: number;
}

interface Negate {
  kind: "Negate";
  operand: number; // index into `nodes`
}

interface BinaryExpr {
  kind: "BinaryExpr";
  op: string;
  left: number; // index into `nodes`
  right: number;
}

type Node = NumberLiteral | Negate | BinaryExpr;

// (1 + 2) * -(3 - 7)
const nodes: Node[] = [
  { kind: "NumberLiteral", value: 1 }, // 0
  { kind: "NumberLiteral", value: 2 }, // 1
  { kind: "BinaryExpr", op: "+", left: 0, right: 1 }, // 2
  { kind: "NumberLiteral", value: 3 }, // 3
  { kind: "NumberLiteral", value: 7 }, // 4
  { kind: "BinaryExpr", op: "-", left: 3, right: 4 }, // 5
  { kind: "Negate", operand: 5 }, // 6
  { kind: "BinaryExpr", op: "*", left: 2, right: 6 }, // 7
];

function evaluate(n: Node): number {
  switch (n.kind) {
    case "NumberLiteral":
      return n.value;
    case "Negate":
      return -evaluate(nodes[n.operand]);
    case "BinaryExpr": {
      const l = evaluate(nodes[n.left]);
      const r = evaluate(nodes[n.right]);
      if (n.op === "+") return l + r;
      if (n.op === "-") return l - r;
      if (n.op === "*") return l * r;
      return l / r;
    }
  }
}

// the OTHER dispatch shape the compiler uses: an if-chain over the same tag
function show(n: Node): string {
  if (n.kind === "NumberLiteral") {
    return "" + n.value;
  }
  if (n.kind === "Negate") {
    return "-(" + show(nodes[n.operand]) + ")";
  }
  return "(" + show(nodes[n.left]) + " " + n.op + " " + show(nodes[n.right]) + ")";
}

console.log(show(nodes[7]));
console.log(evaluate(nodes[7]));

// walking the whole arena — a union flows through an array and a for-of alike
for (const n of nodes) {
  if (n.kind === "BinaryExpr") {
    console.log("op " + n.op);
  } else if (n.kind === "Negate") {
    console.log("neg of " + n.operand);
  } else {
    console.log("lit " + n.value);
  }
}
