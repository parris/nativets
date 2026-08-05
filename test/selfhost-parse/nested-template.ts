// A template literal nested inside a `${…}` substitution. The lexer used to end the
// OUTER template at the inner backtick, so `src/ast.ts`'s `objectType` and a dozen
// `src/codegen.ts` emit sites were unparseable ("Unexpected token 'eof'" / a stray `\`).
//
// Also covers: an array-of-object-type annotation `{ key: string; ty: Ty }[]` (which
// already parsed — it was the nested template on the same line that failed), and a
// nested template whose text contains an escape.

type Ty = string;

function objectType(fields: { key: string; ty: Ty }[]): Ty {
  return `{${fields.map((f) => `${f.key}:${f.ty}`).join(",")}}`;
}

console.log(objectType([{ key: "a", ty: "number" }, { key: "b", ty: "string" }]));

// Three levels deep.
const name = "x";
console.log(`a${`b${`c${name}`}`}d`);

// A nested template carrying an escape (the `\n` case from codegen's emit sites).
const inner = "body";
console.log(`store ${`\n${inner}`}!`);

// A brace inside a string inside a substitution must not close the substitution early.
console.log(`v=${["}", "{"].join("")}`);

// A nested template inside a nested arrow inside a substitution.
const xs: number[] = [1, 2, 3];
console.log(`[${xs.map((n) => `#${n}`).join(" ")}]`);
