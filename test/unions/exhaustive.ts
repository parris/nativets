/*
 * SH2, behavior 3 — EXHAUSTIVENESS.
 *
 * Borrowed from microsoft/TypeScript
 *   tests/cases/conformance/types/union/discriminatedUnionTypes1.ts  (`area2`)
 * — the switch that is a function's whole body, with no `default` and no trailing
 * return. TypeScript accepts it *because* it is exhaustive: every member is covered,
 * so control cannot reach the end of the function.
 *
 * That is exactly the case nativets must diagnose when a member IS missing. Falling
 * out of a `number` function does not produce node's `undefined` here — it produces
 * a value (today, `0`), i.e. a silent wrong answer, which is the one thing this
 * project refuses to do. The rejection half lives in test/unions.test.ts.
 */

interface Square {
  kind: "square";
  size: number;
}

interface Rectangle {
  kind: "rectangle";
  width: number;
  height: number;
}

interface Circle {
  kind: "circle";
  radius: number;
}

type Shape = Square | Rectangle | Circle;

const PI = 3.141592653589793; // === Math.PI (see narrow-if.ts)

// exhaustive: no `default`, no trailing return — every member returns
function area2(s: Shape): number {
  switch (s.kind) {
    case "square": return s.size * s.size;
    case "rectangle": return s.width * s.height;
    case "circle": return PI * s.radius * s.radius;
  }
}

// exhaustive by `default`, which covers whatever the explicit cases left
function name(s: Shape): string {
  switch (s.kind) {
    case "square": return "square";
    default: return "round-ish";
  }
}

// a switch that is NOT the function's tail needs no coverage — the statement after
// it is the author's own fallback, and node runs this exactly the same way.
function sides(s: Shape): number {
  switch (s.kind) {
    case "square": return 4;
    case "rectangle": return 4;
  }
  return 0;
}

console.log(area2({ kind: "square", size: 3 }));
console.log(area2({ kind: "rectangle", width: 3, height: 4 }));
console.log(area2({ kind: "circle", radius: 2 }));
console.log(name({ kind: "square", size: 1 }));
console.log(name({ kind: "circle", radius: 1 }));
console.log(sides({ kind: "rectangle", width: 1, height: 1 }));
console.log(sides({ kind: "circle", radius: 1 }));
