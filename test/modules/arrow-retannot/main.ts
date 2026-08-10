import { makeNum, makeNeg, depth, tagOf } from "./lib.ts";

/*
 * The entry module declares its OWN recursive `Expr`, with a DIFFERENT layout and a
 * different field ORDER. The entry keeps its source names, so an unrenamed `@Expr` left
 * behind in lib.ts resolves to THIS shape in the merged table — one module's nodes read
 * through the other's slots. That is the `rectypes` hazard reached through `retAnnot`
 * rather than through a shape's own body, so the fixture pins the layouts apart and not
 * merely "it compiles".
 */
interface Leaf { tag: "Leaf"; label: string; n: number }
interface Wrap { tag: "Wrap"; label: string; kid: Expr }
type Expr = Leaf | Wrap;

const mine: Expr = { tag: "Wrap", label: "outer", kid: { tag: "Leaf", label: "inner", n: 3 } };
console.log(mine.tag, mine.label);
if (mine.tag === "Wrap") console.log(mine.kid.tag, mine.kid.label);

const a = makeNum(7);
console.log(tagOf(a), depth(a));

const b = makeNeg(4);
console.log(tagOf(b), depth(b));

// An annotated arrow in the ENTRY module keeps its own spelling — the rename must not
// reach it, so this is the other half of the same guarantee.
const local = (n: number): Expr => ({ tag: "Leaf", label: "own", n });
const c = local(9);
console.log(c.tag, c.label);
