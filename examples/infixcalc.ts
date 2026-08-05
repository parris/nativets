// infixcalc.ts — an infix expression evaluator in the nativets subset.
//
//   nativets run examples/infixcalc.ts -- "3 + 4 * 5"   ->  3 + 4 * 5 = 23
//   ./infixcalc "(3 + 4) * 5"                            ->  (3 + 4) * 5 = 35
//
// It reads an expression from `process.argv` (all args joined with a space), or
// runs a hardcoded demo set when given none. The classic three-pass pipeline:
//   1. tokenize(src)  -> a string[] of tokens (numbers, `+ - * / ( )`, and the
//                        marker "u" for a *unary* minus, detected from context).
//   2. toRPN(toks)    -> the shunting-yard algorithm: reorder into Reverse-Polish
//                        by operator precedence + associativity (binary ops are
//                        left-assoc; unary minus is right-assoc and binds tightest).
//   3. evalRPN(rpn)   -> a stack machine over the postfix form.
//
// Written entirely in the IMMUTABLE array subset (Stage 29): every stack/queue is
// a `string[]`/`number[]` that is NEVER mutated in place — a push is
// `xs = [...xs, v]` and a pop reads `xs[xs.length - 1]` then
// `xs = xs.slice(0, xs.length - 1)`. No `.push`, no `arr[i] = v`, no classes. It
// compiles + runs identically under plain `node` and under nativets, byte-for-byte.

// Is the character a digit or a decimal point (i.e. part of a number literal)?
function isDigit(c: string): boolean {
  return "0123456789.".indexOf(c) >= 0;
}

// Does the token begin a number literal? (Its first char is a digit / dot.)
function isNumTok(t: string): boolean {
  return t.length > 0 && isDigit(t.charAt(0));
}

// Is the token one of the four binary operators?
function isBinOp(t: string): boolean {
  return t === "+" || t === "-" || t === "*" || t === "/";
}

// Is the token an operator we pop during shunting-yard (binary or unary minus)?
function isOperator(t: string): boolean {
  return t === "u" || isBinOp(t);
}

// Operator precedence: unary minus binds tightest, then `* /`, then `+ -`.
// A `(` gets 0 so it never triggers popping and acts as a stack barrier.
function prec(op: string): number {
  if (op === "u") return 3;
  if (op === "*" || op === "/") return 2;
  if (op === "+" || op === "-") return 1;
  return 0;
}

// Apply a binary operator to its two operands (a op b).
function applyOp(op: string, a: number, b: number): number {
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  return a / b;
}

// --- Pass 1: tokenize -------------------------------------------------------
// Walk the source char-by-char, emitting number / operator / paren tokens. A
// `-` is UNARY (emitted as the marker "u") when it appears at the start or right
// after another operator or an opening paren; otherwise it is a binary subtract.
function tokenize(src: string): string[] {
  let toks: string[] = [];
  let prev: string = ""; // "num" | "op" | "(" — kind of the previous token
  let i: number = 0;
  while (i < src.length) {
    const c: string = src.charAt(i);
    if (c === " ") {
      i = i + 1;
    } else if (isDigit(c)) {
      let num: string = "";
      while (i < src.length && isDigit(src.charAt(i))) {
        num += src.charAt(i);
        i = i + 1;
      }
      toks = [...toks, num];
      prev = "num";
    } else if (c === "-" && (prev === "" || prev === "op" || prev === "(")) {
      toks = [...toks, "u"]; // unary minus
      prev = "op";
      i = i + 1;
    } else if (isBinOp(c)) {
      toks = [...toks, c];
      prev = "op";
      i = i + 1;
    } else if (c === "(") {
      toks = [...toks, "("];
      prev = "(";
      i = i + 1;
    } else if (c === ")") {
      toks = [...toks, ")"];
      prev = "num"; // a closing paren behaves like an operand for the next `-`
      i = i + 1;
    } else {
      i = i + 1; // ignore anything unexpected
    }
  }
  return toks;
}

// --- Pass 2: shunting-yard (infix -> RPN) ----------------------------------
function toRPN(toks: string[]): string[] {
  let out: string[] = []; // the output (postfix) queue
  let ops: string[] = []; // the operator stack
  for (const t of toks) {
    if (isNumTok(t)) {
      out = [...out, t];
    } else if (t === "u") {
      // unary minus: right-associative + highest precedence, so just push it.
      ops = [...ops, t];
    } else if (isBinOp(t)) {
      // left-associative: pop while the top operator has >= precedence.
      while (
        ops.length > 0 &&
        isOperator(ops[ops.length - 1]) &&
        prec(ops[ops.length - 1]) >= prec(t)
      ) {
        out = [...out, ops[ops.length - 1]];
        ops = ops.slice(0, ops.length - 1);
      }
      ops = [...ops, t];
    } else if (t === "(") {
      ops = [...ops, t];
    } else if (t === ")") {
      // pop until the matching "(", then discard the "(".
      while (ops.length > 0 && ops[ops.length - 1] !== "(") {
        out = [...out, ops[ops.length - 1]];
        ops = ops.slice(0, ops.length - 1);
      }
      if (ops.length > 0) {
        ops = ops.slice(0, ops.length - 1); // drop the "("
      }
    }
  }
  // drain remaining operators to the output.
  while (ops.length > 0) {
    out = [...out, ops[ops.length - 1]];
    ops = ops.slice(0, ops.length - 1);
  }
  return out;
}

// --- Pass 3: evaluate the RPN with a stack machine -------------------------
function evalRPN(rpn: string[]): number {
  let st: number[] = [];
  for (const t of rpn) {
    if (t === "u") {
      const a: number = st[st.length - 1];
      st = st.slice(0, st.length - 1);
      st = [...st, 0 - a];
    } else if (isBinOp(t)) {
      const b: number = st[st.length - 1];
      st = st.slice(0, st.length - 1);
      const a: number = st[st.length - 1];
      st = st.slice(0, st.length - 1);
      st = [...st, applyOp(t, a, b)];
    } else {
      st = [...st, parseFloat(t)];
    }
  }
  return st[st.length - 1];
}

// The whole pipeline for one expression string.
function evaluate(expr: string): number {
  return evalRPN(toRPN(tokenize(expr)));
}

// --- CLI: joined argv, or a hardcoded demo set when given none. -------------
const args: string[] = process.argv.slice(2);

if (args.length === 0) {
  const demos: string[] = [
    "3 + 4 * 5",
    "(3 + 4) * 5",
    "-3 + 4",
    "2 * -(1 + 2)",
    "10 / 4 - 1",
    "1 + 2 + 3 + 4 + 5",
    "2 * 3 + 4 * 5",
    "((1 + 2) * (3 + 4))",
  ];
  for (const e of demos) {
    console.log(e + " = " + evaluate(e));
  }
} else {
  const expr: string = args.join(" ");
  console.log(expr + " = " + evaluate(expr));
}
