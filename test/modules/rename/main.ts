import { paint as apply, RED as primary, BLUE } from "./colors.ts";

// The local name `paint` is free even though the imported function is called paint.
function paint(n: number): string {
  return `#${n}`;
}

console.log(apply("sky", BLUE));
console.log(apply("rose", primary));
console.log(paint(7));
