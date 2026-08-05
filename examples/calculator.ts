// calculator.ts — an arithmetic EXPRESSION ENGINE written in the nativets subset.
//
// It tokenizes a string, parses it with a precedence-climbing (Pratt-style)
// parser, and evaluates it — supporting integer + decimal literals,
// `+ - * / %`, unary minus/plus, parentheses, and correct
// precedence/associativity. It runs identically under plain `node` and under
// nativets (byte-for-byte), and demonstrates itself on hardcoded expressions.
//
// Written in the *current* nativets language subset (docs/examples.md C-a):
//   - Arrays are IMMUTABLE (Stage 29): no `.push` / `arr[i] = v`. The tokenizer
//     accumulates tokens by functional spread into a reassigned local
//     (`acc = [...acc, tok]`), never by mutating in place.
//   - Array parameters are BORROWS: a function may read/index them but cannot
//     return one, so the parser only ever *reads* the token array.
//   - The token accumulator starts genuinely EMPTY (`let acc: T[] = []`): an
//     empty array literal takes its element type from the annotation.
//   - No classes: tokens are structural records `{kind, num}`; parse results are
//     records `{value, pos}` returned from mutually-recursive functions.

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function isDigit(c: string): boolean {
  return "0123456789".indexOf(c) >= 0;
}

// Produce a flat token stream. Token kinds: "num" (with `num` set), and the
// single-char operators/parens "+", "-", "*", "/", "%", "(", ")".
function tokenize(s: string): { kind: string; num: number }[] {
  let acc: { kind: string; num: number }[] = [];
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === " ") {
      i = i + 1;
    } else if (isDigit(c) || c === ".") {
      // Read a run of digits and dots into one numeric literal.
      let j: number = i;
      while (j < s.length && (isDigit(s.charAt(j)) || s.charAt(j) === ".")) {
        j = j + 1;
      }
      const lit: string = s.slice(i, j);
      acc = [...acc, { kind: "num", num: parseFloat(lit) }];
      i = j;
    } else {
      // An operator or paren — a single-character token.
      acc = [...acc, { kind: c, num: 0 }];
      i = i + 1;
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing) + evaluator
// ---------------------------------------------------------------------------

function precedence(op: string): number {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/" || op === "%") return 2;
  return 0;
}

function isBinaryOp(op: string): boolean {
  return op === "+" || op === "-" || op === "*" || op === "/" || op === "%";
}

function applyOp(op: string, a: number, b: number): number {
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  if (op === "/") return a / b;
  return a % b;
}

// Parse a primary: unary +/-, a parenthesized sub-expression, or a number
// literal. Returns the value plus the index just past what it consumed.
function parsePrimary(
  toks: { kind: string; num: number }[],
  pos: number
): { value: number; pos: number } {
  // NOTE: read fields off the indexed element *inline* (`toks[pos].kind`).
  // Binding the element to a local (`const t = toks[pos]`) would move a linear
  // object out of the array — rejected NT1605.
  const kind: string = toks[pos].kind;
  if (kind === "-") {
    const r = parsePrimary(toks, pos + 1);
    return { value: -r.value, pos: r.pos };
  }
  if (kind === "+") {
    const r = parsePrimary(toks, pos + 1);
    return { value: r.value, pos: r.pos };
  }
  if (kind === "(") {
    const inner = parseExpr(toks, pos + 1, 0);
    // Consume the matching ")".
    return { value: inner.value, pos: inner.pos + 1 };
  }
  return { value: toks[pos].num, pos: pos + 1 };
}

// Precedence-climbing core: parse a prefix, then fold in every following binary
// operator whose precedence is >= minPrec. Left-associative: the right operand
// is parsed with `precedence(op) + 1`.
function parseExpr(
  toks: { kind: string; num: number }[],
  pos: number,
  minPrec: number
): { value: number; pos: number } {
  const first = parsePrimary(toks, pos);
  let value: number = first.value;
  let p: number = first.pos;
  while (p < toks.length && isBinaryOp(toks[p].kind) && precedence(toks[p].kind) >= minPrec) {
    const op: string = toks[p].kind;
    const rhs = parseExpr(toks, p + 1, precedence(op) + 1);
    value = applyOp(op, value, rhs.value);
    p = rhs.pos;
  }
  return { value: value, pos: p };
}

// Tokenize + parse + evaluate one expression string to a number.
function evaluate(s: string): number {
  const toks = tokenize(s);
  const r = parseExpr(toks, 0, 0);
  return r.value;
}

// ---------------------------------------------------------------------------
// Demo: hardcoded expressions (argv/stdin input is a follow-on once Host I/O
// FFI lands — see docs/examples.md C-b).
// ---------------------------------------------------------------------------

const cases: string[] = [
  "2 + 3 * 4",
  "(2 + 3) * 4",
  "-5 + 2",
  "10 / 4",
  "2 * (3 + 4) - 1",
  "10 % 3",
  "3.5 + 1.5",
  "2 - -3",
  "-(2 + 3)",
  "100 / 8 / 2",
  "1 + 2 - 3 + 4",
  "2 * 3 % 4",
  "((1 + 2) * (3 + 4)) - 5",
  "0.1 + 0.2",
];

for (const expr of cases) {
  console.log(expr + " = " + evaluate(expr));
}
