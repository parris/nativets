// calc-cli.ts — the calculator as a real cross-platform CLI app (docs/examples.md C-b).
//
// Reads an arithmetic expression from the command line and prints its value:
//
//   nativets run examples/calc-cli.ts -- 2 + 3 '*' 4     ->  14
//   ./calc "2 * (3 + 4) - 1"                              ->  13
//
// The engine is the same precedence-climbing evaluator as calculator.ts; the only
// new thing is INPUT — `process.argv` (Host I/O FFI). It compiles + runs identically
// under `node` and nativets, and cross-compiles to macOS / Linux / iOS / Android
// unchanged (the runtime host layer is libc-only). Written in the immutable subset
// (no `.push` / `arr[i] = v`; token accumulation is functional spread).

function isDigit(c: string): boolean {
  return "0123456789".indexOf(c) >= 0;
}

function tokenize(s: string): { kind: string; num: number }[] {
  let acc: { kind: string; num: number }[] = [{ kind: "^", num: 0 }]; // sentinel at 0
  let i: number = 0;
  while (i < s.length) {
    const c: string = s.charAt(i);
    if (c === " ") {
      i = i + 1;
    } else if (isDigit(c) || c === ".") {
      let j: number = i;
      while (j < s.length && (isDigit(s.charAt(j)) || s.charAt(j) === ".")) {
        j = j + 1;
      }
      acc = [...acc, { kind: "num", num: parseFloat(s.slice(i, j)) }];
      i = j;
    } else {
      acc = [...acc, { kind: c, num: 0 }];
      i = i + 1;
    }
  }
  return acc;
}

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

function parsePrimary(toks: { kind: string; num: number }[], pos: number): { value: number; pos: number } {
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
    return { value: inner.value, pos: inner.pos + 1 };
  }
  return { value: toks[pos].num, pos: pos + 1 };
}

function parseExpr(toks: { kind: string; num: number }[], pos: number, minPrec: number): { value: number; pos: number } {
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

function evaluate(s: string): number {
  const toks = tokenize(s);
  const r = parseExpr(toks, 1, 0); // index 0 is the sentinel
  return r.value;
}

// --- CLI: the whole tail of argv joined with spaces is the expression. ---
const args: string[] = process.argv.slice(2);
const expr: string = args.join(" ");
if (expr.length === 0) {
  console.log("usage: calc <expression>   e.g. calc 2 + 3 '*' 4");
} else {
  console.log(evaluate(expr));
}
