/*
 * Narrowing a discriminated union across the SHORT CIRCUIT of `&&` / `||`.
 *
 * Shape borrowed from `microsoft/TypeScript`
 * `tests/cases/conformance/controlFlow/controlFlowBinaryAndExpression.ts` and
 * `controlFlowBinaryOrExpression.ts` (which do it for `typeof`), applied to the
 * discriminated-union form of `tests/cases/conformance/types/union/
 * discriminatedUnionTypes1.ts`.
 *
 * The right operand of `&&` only runs when the left was TRUE, and the right operand
 * of `||` only when the left was FALSE — so a tag test on the left proves the member
 * for the right, exactly as it does for an `if` arm. This is the shape `src/ast.ts`'s
 * `freshArray` is written in:
 *
 *     if (e.kind === "CallExpr" && e.callee.kind === "MemberExpr") …
 */

interface Square { kind: "square"; size: number }
interface Circle { kind: "circle"; radius: number }
interface Label { kind: "label"; text: string }
type Shape = Square | Circle | Label;

// `&&` — the positive tag test proves the member for the right operand.
function bigSquare(s: Shape): boolean {
  return s.kind === "square" && s.size > 10;
}

// `&&` with a NEGATED tag test — the right operand sees the REMAINING members, and a
// field they still share is readable on the sub-union only after a second narrowing.
function notASquare(s: Shape): boolean {
  return s.kind !== "square" && s.kind === "circle";
}

// `||` — the right operand runs when the left was false, so `!==` on the left proves
// the tag matched.
function squareIsSmall(s: Shape): boolean {
  return s.kind !== "square" || s.size < 10;
}

// `||` with a POSITIVE test on the left proves the tag did NOT match on the right, so
// the right operand sees the remaining member — here a two-member union, where "the
// rest" is a single member and its own fields are readable.
type Tagged = Square | Label;
function shortLabel(s: Tagged): boolean {
  return s.kind === "square" || s.text.length < 3;
}

// Chained: three operands, each narrowing the next.
function chained(s: Shape): boolean {
  return s.kind === "circle" && s.radius > 1 && s.radius < 100;
}

// The ELSE arm of an `if` whose condition is a `||` of two tag tests: neither held, so
// De Morgan leaves exactly the third member. (`microsoft/TypeScript`
// `tests/cases/conformance/controlFlow/controlFlowBinaryOrExpression.ts`.)
function label(s: Shape): string {
  if (s.kind === "square" || s.kind === "circle") return "round-or-square";
  return s.text;
}

// Inside an `if`, which is where the compiler's own source uses it.
function report(s: Shape): string {
  if (s.kind === "label" && s.text.length > 3) return `long label ${s.text}`;
  if (s.kind === "square" && s.size === 4) return "four";
  return "other";
}

const sq: Shape = { kind: "square", size: 20 };
const sm: Shape = { kind: "square", size: 2 };
const ci: Shape = { kind: "circle", radius: 5 };
const la: Shape = { kind: "label", text: "hello" };

console.log(bigSquare(sq), bigSquare(sm), bigSquare(ci));
console.log(notASquare(sq), notASquare(ci), notASquare(la));
console.log(squareIsSmall(sq), squareIsSmall(sm), squareIsSmall(la));
const tsq: Tagged = { kind: "square", size: 20 };
const tlong: Tagged = { kind: "label", text: "hello" };
const tshort: Tagged = { kind: "label", text: "hi" };
console.log(shortLabel(tsq), shortLabel(tlong), shortLabel(tshort));
console.log(chained(ci), chained(sq));
console.log(label(sq), label(ci), label(la));
console.log(report(la), report(sm), report(ci));
