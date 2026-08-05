// calc-tui.ts — an interactive TERMINAL-UI calculator (docs/examples.md C-c).
//
// The achievable cross-platform "UI": raw single-key stdin (readKey / rawMode,
// the Host I/O raw-mode primitive) + ANSI escapes drawn as ordinary strings.
// Runs in every platform's terminal (incl. the iOS sim / Android shell) from one
// source, byte-for-byte identical under `node` and nativets.
//
// The arithmetic engine is the precedence-climbing evaluator from calculator.ts
// (copied inline — no modules). Written in the IMMUTABLE subset (Stage 29): the
// expression is built by string concatenation and the UI state is threaded as a
// fresh record each keystroke (`step` returns a NEW state, never mutates).
//
// The interactive behaviour is factored into two PURE, node-differential-testable
// functions:
//   render(state) -> string   the ANSI frame drawn for a state
//   step(state, key) -> state  the key handler (append / eval / clear / quit)
// so the logic is tested directly against node without a live terminal, and an
// end-to-end run is checked by feeding a piped keystroke script (readKey degrades
// to byte-reads off piped stdin — see test/calc-tui.test.ts).

// ---------------------------------------------------------------------------
// Arithmetic engine (identical to examples/calculator.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure UI core: state = { expr, result, done }.
//   expr   — the expression being typed
//   result — the last evaluated result (as a string; "" before any `=`)
//   done   — set once the user presses `q`
// ---------------------------------------------------------------------------

// Which keys extend the expression: digits, the binary operators, parens, dot.
function isInputKey(k: string): boolean {
  return "0123456789+-*/%().".indexOf(k) >= 0;
}

// The key handler — PURE: returns a brand-new state, never mutates its input.
//   q            -> quit (done = true)
//   c            -> clear (expr and result reset)
//   = or Enter   -> evaluate the current expression (v1 assumes it is well-formed)
//   input key    -> append to the expression (and drop any stale result)
//   anything else-> ignored (state unchanged)
function step(
  state: { expr: string; result: string; done: boolean },
  key: string
): { expr: string; result: string; done: boolean } {
  if (key === "q") {
    return { expr: state.expr, result: state.result, done: true };
  }
  if (key === "c") {
    return { expr: "", result: "", done: false };
  }
  if (key === "=" || key === "\n" || key === "\r") {
    if (state.expr.length === 0) {
      return { expr: state.expr, result: "", done: false };
    }
    const v: number = evaluate(state.expr);
    return { expr: state.expr, result: "" + v, done: false };
  }
  if (isInputKey(key)) {
    return { expr: state.expr + key, result: "", done: false };
  }
  return { expr: state.expr, result: state.result, done: state.done };
}

// Render one ANSI frame for a state — PURE. `\x1b[2K\r` erases the current line
// and returns the cursor to its start, so console.log reprints the display in
// place (a simple single-line redraw; see docs/examples.md C-c).
function render(state: { expr: string; result: string; done: boolean }): string {
  const shown: string = state.expr.length === 0 ? "_" : state.expr;
  const tail: string = state.result.length === 0 ? "" : " = " + state.result;
  return "\x1b[2K\rcalc> " + shown + tail;
}

// The one-time hint/banner line.
function hintLine(): string {
  return "keys: 0-9  + - * / %  ( ) .   '=' or Enter = evaluate   c = clear   q = quit";
}

// ==== INTERACTIVE MAIN ====
// (The pure-function tests strip everything from this marker onward and drive
//  step()/render() directly against the node oracle.)

console.log(hintLine());
rawMode(true);
let state: { expr: string; result: string; done: boolean } = { expr: "", result: "", done: false };
console.log(render(state));
while (!state.done) {
  const k: string = readKey();
  if (k.length === 0) break; // EOF (piped script exhausted)
  state = step(state, k);
  console.log(render(state));
}
rawMode(false);
console.log("");
console.log("bye");
