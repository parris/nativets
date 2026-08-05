// A parenthesized expression in a ternary arm must NOT be read as an arrow parameter
// list. `cond ? (x as T) : y` and `cond ? (x) : y` both end in `)` followed by `:`,
// which used to be enough for `looksLikeArrow` to commit to the arrow grammar.
// Straight from `src/ast.ts` (`baseTy` / `eraseTypeParams`).

type Ty = string;

function isNullable(t: Ty): boolean {
  return t.length > 2 && t[0] === "?";
}

function baseTy(t: Ty): Ty {
  return isNullable(t) ? (t.slice(2) as Ty) : t;
}

function eraseTypeParams(t: Ty): Ty {
  return t.length > 0 ? (t.replace("T", "number") as Ty) : t;
}

console.log(baseTy("?Unumber"));
console.log(baseTy("number"));
console.log(eraseTypeParams("T[]"));

// The same shape without the `as`: a plain parenthesized expression in a ternary arm.
const n = 7;
const label = n > 3 ? (n) : 0;
console.log(label);
const pick = n > 3 ? (n + 1) : (n - 1);
console.log(pick);

// ...and a parenthesized MEMBER expression, which used to die on the `.`.
const o = { v: 41 };
console.log(n > 3 ? (o.v) : 0);

// A real arrow with a return-type annotation still parses as an arrow.
const twice = (x: number): number => x * 2;
console.log(twice(21));
