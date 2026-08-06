/*
 * SH2, behavior 2b — `switch (s.kind)` narrows each arm to the member(s) that can
 * reach it. This is the shape nativets' own AST is matched with (`switch (node.kind)`),
 * so it is the case SH2 exists for.
 *
 * Borrowed from microsoft/TypeScript
 *   tests/cases/conformance/types/union/discriminatedUnionTypes1.ts  (`area2`, `area3`)
 *   tests/cases/conformance/types/union/discriminatedUnionTypes2.ts  (`f11`, the
 *     switch-with-`default` shape)
 * plus the FALLTHROUGH cases those files do not cover, which are the ones where
 * narrowing to a case's own tag alone would be unsound.
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

function area2(s: Shape): number {
  switch (s.kind) {
    case "square": return s.size * s.size;
    case "rectangle": return s.width * s.height;
    case "circle": return PI * s.radius * s.radius;
  }
  return 0;
}

// `default:` narrows to whatever the explicit cases did NOT list — here, Circle.
function describe(s: Shape): string {
  switch (s.kind) {
    case "square":
      return "square of " + s.size;
    case "rectangle":
      return "rect " + s.width + "x" + s.height;
    default:
      return "circle of " + s.radius;
  }
}

// EMPTY-case fallthrough: the shared body runs for BOTH tags, so inside it only the
// discriminant (common to every member) may be read — not a member-specific field.
function isRound(s: Shape): boolean {
  switch (s.kind) {
    case "square":
    case "rectangle":
      return false;
    case "circle":
      return s.radius > 0;
  }
  return false;
}

// NON-TERMINATED fallthrough: "square" runs its own body and then falls into
// "rectangle"'s, so that second body is reachable with EITHER tag.
function tagTwice(s: Shape): string {
  let out = "";
  switch (s.kind) {
    case "square":
      out += "sq:";
    case "rectangle":
      out += "[" + s.kind + "]";
      break;
    case "circle":
      out += "ci:" + s.radius;
      break;
  }
  return out;
}

console.log(area2({ kind: "square", size: 3 }));
console.log(area2({ kind: "rectangle", width: 3, height: 4 }));
console.log(area2({ kind: "circle", radius: 2 }));

console.log(describe({ kind: "square", size: 1 }));
console.log(describe({ kind: "rectangle", width: 2, height: 3 }));
console.log(describe({ kind: "circle", radius: 4 }));

console.log(isRound({ kind: "square", size: 1 }));
console.log(isRound({ kind: "circle", radius: 1 }));

console.log(tagTwice({ kind: "square", size: 1 }));
console.log(tagTwice({ kind: "rectangle", width: 1, height: 1 }));
console.log(tagTwice({ kind: "circle", radius: 9 }));
