// A PARENTHESIZED type. `parseTypeAtom` treated a leading `(` as the start of a
// function type's parameter list, so `(() => Scope) | null` (src/checker.ts's
// `genericBase` field) and a parenthesized return annotation both failed with
// "Expected identifier".

type Make = () => number;

// Parenthesized around a function type, then made nullable.
let base: (() => number) | null = null;
console.log(base === null);
base = () => 41;
console.log(base === null);

// A parenthesized function type as a parameter annotation, and as a return annotation.
function callIt(f: (() => number)): number {
  return f() + 1;
}
// (The inner param is annotated: contextual typing THROUGH a parenthesized return
// annotation is the separate `higher-order-compose` gap, not a parse problem.)
const adder = (x: number): ((a: number) => number) => (a: number) => a + x;

console.log(callIt(() => 41));
console.log(adder(40)(2));

// Redundant parens around ordinary types are transparent.
const n: (number) = 7;
const xs: (number)[] = [1, 2, 3];
const m: Make = () => 3;
console.log(n, xs.length, m());
