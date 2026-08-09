// main.ts ⇄ dep.ts, but the edge that CLOSES the cycle is `import type` — which node
// and bun erase, so this program runs fine under both (it prints 42). nativets still
// refuses it; the diagnostic has to say WHY, and which edge is the type-only one.
import { widen } from "./dep.ts";

export interface Cell { n: number; }

const c: Cell = { n: 41 };
console.log(widen(c));
