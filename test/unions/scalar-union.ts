// A GENERAL union — arms that are not all object types, so there is no discriminant
// field to read. `typeof` is the discriminant instead.
//
// This is the shape the compiler's own source needs: `checker.ts` has
// `Record<string, number | "var">` (which widens to `number | string`), and
// `ast.ts` has `number | number[]`.

function show(v: number | string): string {
  if (typeof v === "number") return "num:" + (v + 1);
  return "str:" + v.toUpperCase();
}

console.log(show(41));
console.log(show("hi"));
