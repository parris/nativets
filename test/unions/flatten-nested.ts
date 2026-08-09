/*
 * UNION FLATTENING — a union arm that is itself a union contributes its MEMBERS.
 *
 * DERIVED, not borrowed: there is no `microsoft/TypeScript` checkout on this machine
 * (verified — four lanes have now reported it), so this models the real declaration
 * that needs it, `src/ast.ts`'s `ForStmt.init: VarDecl | Expr | null`, where `Expr`
 * is itself a 27-member discriminated union. TypeScript flattens `A | (B | C)` to
 * `A | B | C`; nativets used to refuse it as a "general union" because the nested
 * arm is a `U<…>` and not an object type.
 *
 * The flattened union is an ORDINARY discriminated union afterwards — same unboxed
 * representation, same `unionDiscriminant` proof that `kind` sits at slot 0 in every
 * member — so narrowing, arrays and exhaustiveness all work unchanged.
 */

interface Square { kind: "square"; size: number }
interface Circle { kind: "circle"; radius: number }
interface Triangle { kind: "triangle"; base: number; height: number }

type Round = Circle;
type Straight = Square | Triangle;

// The forcing case: `Straight` is a nested `U<…>` arm, `Round` an alias of one member.
type Shape = Round | Straight;

function area(s: Shape): number {
  switch (s.kind) {
    case "square": return s.size * s.size;
    case "circle": return 3 * s.radius * s.radius;
    default: return (s.base * s.height) / 2;
  }
}

function name(s: Shape): string {
  if (s.kind === "circle") return "circle";
  if (s.kind === "square") return "square";
  return "triangle";
}

console.log(area({ kind: "square", size: 4 }));
console.log(area({ kind: "circle", radius: 2 }));
console.log(area({ kind: "triangle", base: 6, height: 3 }));

console.log(name({ kind: "circle", radius: 1 }));
console.log(name({ kind: "triangle", base: 1, height: 1 }));

// Flattening is order-independent and de-duplicates: `Square` appears both on its
// own and inside `Straight`, and the result is still a three-member union.
type Shape2 = Square | Straight | Circle;
function area2(s: Shape2): number { return area(s); }
console.log(area2({ kind: "triangle", base: 10, height: 4 }));

// Stored in an array and walked — the element type is the flattened union.
const shapes: Shape[] = [
  { kind: "square", size: 2 },
  { kind: "circle", radius: 3 },
  { kind: "triangle", base: 4, height: 5 },
];
let total = 0;
for (const s of shapes) total = total + area(s);
console.log(total);

// A single `null` arm hoists OUT of an N>2 union into the nullable encoding, so
// `Shape | null` and `Round | Straight | null` are the same type.
function areaOrZero(s: Round | Straight | null): number {
  if (s === null) return 0;
  return area(s);
}
console.log(areaOrZero(null));
// Bound first, deliberately. Passing an object LITERAL straight to a `Union | null`
// parameter is NT2001 today — the literal is not retyped against the nullable's union
// base, so its tag widens to `string` and matches no member. That is PRE-EXISTING and
// not about flattening: it reproduces on a plain two-arm `Square | Circle | null`.
const three: Shape = { kind: "square", size: 3 };
console.log(areaOrZero(three));
