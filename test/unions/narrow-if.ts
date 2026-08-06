/*
 * SH2, behavior 2a — `if (s.kind === "…")` NARROWS `s` to that member inside the arm,
 * so the member's own fields become accessible.
 *
 * Borrowed from microsoft/TypeScript
 *   tests/cases/conformance/types/union/discriminatedUnionTypes1.ts  (`area1`)
 * — the `if / else if / else if / else` chain over `Square | Rectangle | Circle`,
 * verbatim in shape, printed so node can be the oracle. One substitution: `Math.PI`
 * is an unrelated gap (nativets has `Math.floor` etc. but no `Math` CONSTANTS —
 * `Math.PI` is `NT2001: 'Math' is not defined`), so the borrowed case spells out its
 * exact double instead. Nothing about the union changes.
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

const PI = 3.141592653589793; // === Math.PI

function area1(s: Shape): number {
  if (s.kind === "square") {
    return s.size * s.size;
  } else if (s.kind === "circle") {
    return PI * s.radius * s.radius;
  } else if (s.kind === "rectangle") {
    return s.width * s.height;
  } else {
    return 0;
  }
}

// the reversed test (`"…" === s.kind`) narrows the same way
function isBig(s: Shape): boolean {
  if ("rectangle" === s.kind) {
    return s.width > 10;
  }
  return false;
}

console.log(area1({ kind: "square", size: 3 }));
console.log(area1({ kind: "rectangle", width: 3, height: 4 }));
console.log(area1({ kind: "circle", radius: 2 }));
console.log(isBig({ kind: "rectangle", width: 20, height: 1 }));
console.log(isBig({ kind: "square", size: 99 }));

// narrowing works on a local binding too, not only on a parameter
const shapes: Shape[] = [
  { kind: "square", size: 2 },
  { kind: "circle", radius: 1 },
  { kind: "rectangle", width: 5, height: 6 },
];
for (const s of shapes) {
  if (s.kind === "rectangle") {
    console.log("rect " + s.width + "x" + s.height);
  } else if (s.kind === "square") {
    console.log("square " + s.size);
  } else {
    console.log("circle " + s.radius);
  }
}
