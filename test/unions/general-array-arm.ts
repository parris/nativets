// The shape `src/ast.ts` needs: `number | number[]` (there, `body: Expr | Stmt[]`).
// The arms have no field in common, so `typeof` is the only discriminant — and it
// separates them, "number" vs "object". An array arm rides in the box's value slot
// as the ordinary pointer `toSlot` already packs.

function total(v: number | number[]): number {
  if (typeof v === "object") {
    let s = 0;
    for (const n of v) s = s + n;
    return s;
  }
  return v;
}

console.log(total(5));
console.log(total([1, 2, 3]));

// ...and an UN-narrowed one still renders, because the box carries its own tag.
const a: number | number[] = [1, 2, 3];
const b: number | number[] = 9;
console.log(a);
console.log(b);
console.log(typeof a, typeof b);

// `Array.isArray` is the idiomatic discriminant for this shape, so it narrows too —
// on both branches, including through a negated early return.
function sum(v: number | number[]): number {
  if (Array.isArray(v)) { let s = 0; for (const n of v) s = s + n; return s; }
  return v;
}
function size(v: number | number[]): number {
  if (!Array.isArray(v)) return v;
  return v.length;
}
console.log(sum([1, 2, 3]), sum(7));
console.log(size([1, 2, 3]), size(7));
