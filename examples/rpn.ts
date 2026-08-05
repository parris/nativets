// rpn.ts — a Reverse-Polish-Notation (postfix) calculator in the nativets subset.
//
//   nativets run examples/rpn.ts -- 3 4 + 5 '*'   ->  35
//   ./rpn "3 4 + 5 *"                              ->  35
//
// It reads the expression from `process.argv` — either as already-split tokens
// (`3 4 + 5 *`) or as a single string that it splits on spaces — falling back to
// a hardcoded default when no args are given. Evaluation is a classic RPN stack
// machine, written in the IMMUTABLE array subset (Stage 29): the stack is a
// `number[]` that is never mutated in place — a push is `stack = [...stack, v]`
// and a pop reads `stack[stack.length - 1]` then `stack = stack.slice(0, ...)`.
// No `.push`, no `arr[i] = v`, no classes. It compiles + runs identically under
// plain `node` and under nativets (byte-for-byte), and cross-compiles unchanged.

// Is `t` one of the four supported binary operators?
function isOp(t: string): boolean {
  return t === "+" || t === "-" || t === "*" || t === "/";
}

// Apply a binary operator to the two operands (a op b).
function applyOp(op: string, a: number, b: number): number {
  if (op === "+") return a + b;
  if (op === "-") return a - b;
  if (op === "*") return a * b;
  return a / b;
}

// Evaluate a whitespace-token stream in Reverse Polish Notation. `tokens` is a
// borrow (we only ever read it); the stack is a fresh owned array we rebuild
// immutably on every push/pop. Empty tokens (from a trailing/leading space in a
// single-string arg) are skipped so `"3 4 +"` and `["3","4","+"]` agree.
function evalRPN(tokens: string[]): number {
  let stack: number[] = [];
  for (const tok of tokens) {
    if (tok.length === 0) {
      // skip empty token (e.g. double space)
    } else if (isOp(tok)) {
      // pop b, then a — reading the top slot, then shrinking the stack.
      const b: number = stack[stack.length - 1];
      stack = stack.slice(0, stack.length - 1);
      const a: number = stack[stack.length - 1];
      stack = stack.slice(0, stack.length - 1);
      stack = [...stack, applyOp(tok, a, b)];
    } else {
      // an operand: parse and push.
      stack = [...stack, parseFloat(tok)];
    }
  }
  return stack[stack.length - 1];
}

// --- CLI: argv tokens, or a single string to split, or a hardcoded default. ---
const args: string[] = process.argv.slice(2);

let tokens: string[] = ["3", "4", "+", "5", "*"]; // default: (3 + 4) * 5 = 35
if (args.length === 1) {
  // one arg: a whole expression string like "3 4 + 5 *" — split on spaces.
  tokens = args[0].split(" ");
} else if (args.length > 1) {
  // already split by the shell into separate tokens.
  tokens = args;
}

console.log(evalRPN(tokens));
