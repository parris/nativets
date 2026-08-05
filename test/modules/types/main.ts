import type { Named } from "./shapes.ts";
import { describe, type Point } from "./shapes.ts";

const p: Point = { x: 3, y: 4 };
console.log(describe(p));

const who: Named = { name: "ada", age: 36 };
console.log(`${who.name} is ${who.age}`);

function label(n: Named): string {
  return n.name.toUpperCase();
}
console.log(label(who));
