// A `?:` ARM in a consuming position MOVES — E0507/E0382 through a conditional.
//
// `Analyzer.expr`'s `ConditionalExpr` walked both arms with a hard-coded `consume: false`,
// discarding the caller's `consume`. So the move checker could not see through a `?:` at
// all, and every NT1604/NT1601 rule was bypassable by laundering the move through one:
//
//   const y: string[] = x;         // error[NT1604]: cannot move out of `x`
//   const y: string[] = c ? x : o; // the IDENTICAL move — compiled, exit 0
//
// That is the exact shape `AsExpr` was fixed for in 481c463, one node type over, and it
// is not a refusal-only defect. Under ASan the declarator shape is a `heap-use-after-free`
// in `nt_arr_free`, and returning a plain union member is an "attempting double-free" —
// both SILENT on a plain macOS run, because the allocator's abort discards buffered
// stdout, so the binary exits 0 having printed a prefix of the right answer.
// `move(x)` in an arm WAS caught (its own case consumes), which is why the IMPLICIT move
// survived so long. test/drops.test.ts carries the ASan gate and the `c ? x : o` shape.
//
// The arms inherit `consume`; the TEST is always a borrow. Reading THROUGH the result
// (`(c ? x : o).length`) is still a borrow, and that is what keeps the useful shapes.
//
// One diagnostic per annotated line, deliberately: this harness matches a single `//~`
// per line, and `c ? x : o` reports on BOTH arms. So the consequent and the alternate get
// their own case here rather than sharing one.

// ---- the moves, refused ----

// the CONSEQUENT arm moves...
function moveInConsequent(x: string[], c: boolean): number {
  const y: string[] = c ? x : ["z"]; //~ ERROR NT1604
  return y.length;
}

// ...and so does the ALTERNATE, which is a separate `this.expr` call and could regress
// on its own.
function moveInAlternate(o: string[], c: boolean): number {
  const y: string[] = c ? ["z"] : o; //~ ERROR NT1604
  return y.length;
}

// RETURNING through a `?:` hands the caller's value out — the headline bypass.
function returnBorrowedParam(x: string[], c: boolean): string[] {
  return c ? x : ["z"]; //~ ERROR NT1604
}

// A `?:` nested inside another `?:` arm gets the same treatment, or the fix is one
// laundering step deep.
function nestedArm(x: string[], c: boolean, d: boolean): string[] {
  return c ? (d ? x : ["z"]) : ["w"]; //~ ERROR NT1604
}

// An element MOVES into an array literal, so the arm under it does too.
function intoArrayLiteral(x: string[], c: boolean): number {
  const box: string[][] = [c ? x : ["z"]]; //~ ERROR NT1604
  return box.length;
}

// ---- the borrows, still legal ----

// Reading a field/method THROUGH the result never moves: the receiver is borrowed.
// This is what keeps `(e.kind === "A" ? e : f).kind` — the union-join shape — compiling.
function readThroughResult(x: string[], o: string[], c: boolean): number {
  return (c ? x : o).length;
}

// Fresh values in both arms are nobody else's — no binding is left dangling.
function freshArms(c: boolean): number {
  const y: string[] = c ? ["a"] : ["b", "c"];
  return y.length;
}

// The TEST is a borrow even when the `?:` itself is consumed.
function testIsABorrow(x: string[], c: boolean): number {
  const y: string[] = x.length > 0 ? ["a"] : ["b"];
  return y.length + (c ? 1 : 0);
}

console.log(
  moveInConsequent(["a"], true),
  moveInAlternate(["b"], true),
  returnBorrowedParam(["a"], true).length,
  nestedArm(["a"], true, true).length,
  intoArrayLiteral(["a"], true),
  readThroughResult(["a"], ["b"], true),
  freshArms(true),
  testIsABorrow(["a"], true),
);
