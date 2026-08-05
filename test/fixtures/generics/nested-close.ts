// Nested generics close with a single `>>` / `>>>` token, because the lexer sees the
// shift operators — right everywhere except a type-argument list. Regression: this made
// `new Map<string, Set<Expr>>()` in the compiler's OWN source unparseable (NT0001), which
// is how the self-host tracker caught it. The close is split; shifts still lex as shifts.
// (instantiated at a SCALAR: T = number[] would move a linear element out of an
// array, which NT1605 correctly rejects.)
function first<T>(xs: T[]): T { return xs[0]; }
const nested: number[][] = [[1, 2], [3]];
console.log(nested[0].length, first<number>(nested[0]));

const m = new Map<string, number>();
const m2 = m.set("a", 1).set("b", 2);
console.log(m2.get("b") ?? -1, m2.size);

// shift operators are untouched
console.log(1 << 3, 256 >> 2, -8 >>> 28);
let z = 8;
z >>= 1;
z <<= 2;
console.log(z);
