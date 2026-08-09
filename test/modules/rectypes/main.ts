import { depth } from "./ast.ts";
import type { Expr, Node as LibNode } from "./ast.ts";

interface Node { n: number; tag: "main"; kids: Node[] }

const inner: Expr = { kind: "Num", value: 7 };
const call: Expr = { kind: "Call", callee: inner, args: [] };

// Reading THROUGH the imported back-edge: `call.callee` is typed `@Expr`, and its `.kind`
// is the discriminant read every AST walk starts with (src/ast.ts:1383 `freshArray`).
if (call.kind === "Call") console.log(call.callee.kind);
console.log(depth(call));

// Two same-named recursive types, one per module, with different layouts AND different
// field order — so resolving one through the other's shape reads the wrong slot.
const mine: Node = { n: 1, tag: "main", kids: [{ n: 2, tag: "main", kids: [] }] };
const theirs: LibNode = { tag: "lib@Node", kids: [{ tag: "lib@Node", kids: [], label: "y" }], label: "x" };
console.log(mine.kids);
console.log(theirs.kids);
console.log(mine.kids[0].n, theirs.kids[0].label);
console.log(mine.kids[0]?.tag, theirs.kids[0]?.label, theirs.tag);
