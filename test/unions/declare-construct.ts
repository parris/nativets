/*
 * SH2, behavior 1 — a discriminated union can be DECLARED, CONSTRUCTED and PASSED AROUND.
 *
 * Borrowed from microsoft/TypeScript
 *   tests/cases/conformance/types/union/discriminatedUnionTypes1.ts
 * (the `Square | Rectangle | Circle` shape union). Narrowing is behavior 2 — this
 * case only reads the DISCRIMINANT, which every member carries at the same slot.
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

function tagOf(s: Shape): string {
  return s.kind;
}

const sq: Shape = { kind: "square", size: 2 };
const rect: Shape = { kind: "rectangle", width: 3, height: 4 };

console.log(tagOf(sq));
console.log(tagOf(rect));
console.log(tagOf({ kind: "circle", radius: 1 }));

// a union-typed value flows through a local binding and back out
const again: Shape = sq;
console.log(tagOf(again));
