import { GREETING, LIMIT, shout, underLimit } from "./config.ts";

console.log(GREETING);
console.log(LIMIT);
console.log(shout("world"));
console.log(underLimit(2), underLimit(5));

// A top-level const of the ENTRY module, read from an entry-module function too.
const SCALE = 10;
function scaled(n: number): number {
  return n * SCALE;
}
console.log(scaled(LIMIT));
