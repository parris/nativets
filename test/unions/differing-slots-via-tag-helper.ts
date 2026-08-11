/*
 * A field that is in EVERY member but at DIFFERENT SLOTS, read through a PER-TAG helper.
 *
 * `unionCommonField` refuses `x.ty` here and is right to: a field read lowers to one
 * `getelementptr` at a constant slot, and `ty` sits at slot 2, 3 and 1 in the three
 * members below. The sound workaround the diagnostic recommends ("give each tag its own
 * arm") is a helper that switches on the tag and reads the NARROWED member's own field,
 * so the compiler resolves each offset separately.
 *
 * This is not a hypothetical: `src/ast.ts`'s `exprTy` is exactly this function for the
 * 30-member `Expr` union, and `src/checker.ts` reads `.ty` off un-narrowed expressions in
 * several places. The fixture pins that the helper shape both COMPILES and gives node's
 * answer for every member — including the `undefined` a member may carry, which is the
 * part a slot-confused read would return as a garbage pointer rather than as absent.
 *
 * Borrowed shape: TypeScript conformance `tests/cases/conformance/types/union` —
 * discriminated unions whose members do not share a layout.
 */

interface NumLit { kind: "NumLit"; value: number; ty?: string }
interface StrLit { kind: "StrLit"; raw: string; cooked: string; ty?: string }
interface Hole { kind: "Hole"; ty?: string }

type Node = NumLit | StrLit | Hole;

// `ty` is at slot 2 / slot 3 / slot 1. One arm per tag, so each read resolves against the
// narrowed member's own layout. Grouping the arms would reintroduce the slot assumption.
function nodeTy(n: Node): string | undefined {
  switch (n.kind) {
    case "NumLit": return n.ty;
    case "StrLit": return n.ty;
    case "Hole": return n.ty;
    default: return undefined;
  }
}

// The caller shape from `rejectVacuousCollectionTest`: an optional receiver, an early
// return on absence, then a test on the recovered value.
function describeNode(n: Node | undefined): string {
  if (n === undefined) return "(none)";
  const t = nodeTy(n);
  if (t === undefined) return `${n.kind}: untyped`;
  return `${n.kind}: ${t}`;
}

const a: Node = { kind: "NumLit", value: 7, ty: "number" };
const b: Node = { kind: "StrLit", raw: "\"hi\"", cooked: "hi" };
const c: Node = { kind: "Hole", ty: "never" };

console.log(describeNode(a));
console.log(describeNode(b));
console.log(describeNode(c));
console.log(describeNode(undefined));

// The tag is still readable directly — the discriminant is at slot 0 in every member,
// which is the degenerate case of the same rule.
console.log(a.kind, b.kind, c.kind);

// And the helper still answers correctly when the receiver is reached through another
// field read, the shape `rejectDiscardedMutator` uses (`e.callee.object.ty`).
interface Wrap { inner: Node }
const w: Wrap = { inner: b };
console.log(describeNode(w.inner));
const t2 = nodeTy(w.inner);
console.log(t2 === undefined ? "absent" : t2);

// The helper in a TERNARY arm against `undefined` (`rejectDiscardedMutator`'s `ownerTy`):
// the two arms have to agree on `string | undefined`, and the absent arm must produce the
// same absence the helper does.
const owner: Node = { kind: "Hole" };
const ownerTy = owner.kind === "Hole" ? nodeTy(owner) : undefined;
console.log(ownerTy === undefined ? "no owner ty" : ownerTy);

// The recovered local narrowed by `=== undefined` inside an `||` early return
// (`checkExhaustiveTailSwitch`), so the tail sees a plain `string`.
function tagOrDefault(n: Node): string {
  const ty = nodeTy(n);
  if (ty === undefined || ty.length === 0) return "<none>";
  return ty.toUpperCase();
}
// `w.inner`, not `b`: `b` was MOVED into `w` above and this compiler refuses the second
// use (NT1601). node has no such rule, so reading it back through its new owner is the
// spelling that means the same thing to both.
console.log(tagOrDefault(a), tagOrDefault(w.inner), tagOrDefault(c));

// `.map` with an INLINE arrow over an array of union (heap) elements, joined — the shape
// `rejectDiscardedMutator` builds its argument list with. The callback returns a string
// per element, so nothing aliases the owning array.
// Fresh literals, not `[a, b, c]`: `b` is already owned by `w` above, and an array
// literal MOVES its elements (NT1601) — node has no such rule, so this is the fixture
// staying inside the subset rather than a limitation being demonstrated.
const nodes: Node[] = [
  { kind: "NumLit", value: 7, ty: "number" },
  { kind: "StrLit", raw: "\"hi\"", cooked: "hi" },
  { kind: "Hole", ty: "never" },
];
const rendered = nodes.map((n) =>
  n.kind === "NumLit" ? String(n.value)
  : n.kind === "StrLit" ? JSON.stringify(n.cooked)
  : "_").join(", ");
console.log(rendered);
console.log(nodes.length);
console.log(describeNode(nodes[0]!));
