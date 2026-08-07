// The shape `src/checker.ts` needs: `Record<string, number | "var">`, whose value
// type is `number | "var"`. A string-LITERAL arm widens to `string` before the union
// is built (the same `widenLiteralTys` collapse that makes `type Dir = "n" | "s"` a
// plain `string`), so this is `number | string` and needs no new machinery.

function show(v: number | "var"): string {
  if (typeof v === "number") return "n" + (v + 1);
  return "s" + v.toUpperCase();
}
console.log(show(1));
console.log(show("var"));

// ...so the two spellings really are the SAME type, and a value crosses freely.
// (`Ty` is a string precisely so `===` is type comparison; members are sorted, so
// arm ORDER cannot change the tag numbering.)
function flip(v: string | number): number | string { return v; }
console.log(show(2), flip("var"), flip(3));
