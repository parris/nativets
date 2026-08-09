/*
 * SH2, behavior 2f — a NULLISH guard on a `E | undefined` / `E | null` leaves a value
 * the TAG narrowing can still narrow.
 *
 * The two narrowings are different mechanisms: a nullish guard is a control-flow
 * NarrowFact (`withFacts`), a tag test is a shadow BINDING (`narrowInto`). Before this
 * fixture the tag test read the binding's DECLARED type, saw `?UU<…>` rather than a
 * `U<…>`, and declined — so the diagnostic asked for the `if (x.kind === "…")` that was
 * already written one line above. Every in-place spelling of the nullish guard was
 * affected (`!e`, `e === undefined`, `if (e) { … }`, `if (e !== undefined) { … }`), on
 * both `?U` and `?N`, for both `if` and `switch`, and for a parameter as well as a
 * local. Only the spellings that introduce a NEW binding (`const q = e!`, `e ?? d`)
 * worked, which is exactly the tell.
 *
 * Shape borrowed from microsoft/TypeScript
 *   tests/cases/conformance/controlFlow/controlFlowOptionalChain.ts — a discriminated
 * union behind an optional value, guarded once and then switched on.
 */

interface A { kind: "A"; left: number }
interface B { kind: "B"; right: number }
type E = A | B;

function mkA(n: number): E { return { kind: "A", left: n }; }
function mkB(n: number): E { return { kind: "B", right: n }; }
function opt(e: E, on: boolean): E | undefined { return on ? e : undefined; }
function optN(e: E, on: boolean): E | null { return on ? e : null; }

/* truthiness guard + early return, then `if` on the tag */
function f1(e: E | undefined): number {
  if (!e) return -1;
  if (e.kind === "A") return e.left;
  return e.right;
}

/* `=== undefined` guard + early return, then `switch` on the tag */
function f2(e: E | undefined): number {
  if (e === undefined) return -1;
  switch (e.kind) {
    case "A": return e.left;
    case "B": return e.right;
  }
}

/* `!== undefined` guard with the work INSIDE the taken branch */
function f3(e: E | undefined): number {
  if (e !== undefined) {
    if (e.kind === "A") return e.left * 10;
    return e.right * 10;
  }
  return -1;
}

/* a `| null` union, guarded in place, narrowed in the block */
function f4(e: E | null): number {
  if (e) {
    if (e.kind === "B") return e.right + 100;
    return e.left + 100;
  }
  return -1;
}

/* a LOCAL rather than a parameter — `let`, reassigned before the guard */
function f5(on: boolean): number {
  let e: E | undefined = undefined;
  e = opt(mkB(4), on);
  if (!e) return -1;
  if (e.kind === "A") return e.left;
  return e.right;
}

/* the whole guard in ONE `&&` chain — the nullish fact has to be live when the tag test
 * to its right is read, or there is no union there to discriminate */
function f6(e: E | undefined): number {
  if (e !== undefined && e.kind === "A" && e.left > 3) return e.left;
  // spelled `e !== undefined`, not `e &&`: a BARE nullable as a `&&` operand is a
  // separate, pre-existing refusal (`'&&' operands must be matching …`) — node's `a && b`
  // evaluates to `a` when `a` is falsy, so its type is a general union, which is a
  // different gap from this one. See docs/divergences.md.
  if (e !== undefined && e.kind === "B") return e.right;
  return 0;
}

/* the `||` mirror: the right operand runs on the left's FALSE branch */
function f7(e: E | undefined): boolean {
  return e === undefined || e.kind === "B" || e.left === 0;
}

console.log(f1(opt(mkA(7), true)));
console.log(f1(opt(mkA(7), false)));
console.log(f1(opt(mkB(3), true)));
console.log(f2(opt(mkA(7), true)));
console.log(f2(opt(mkB(3), true)));
console.log(f2(opt(mkA(7), false)));
console.log(f3(opt(mkA(2), true)));
console.log(f3(opt(mkB(5), true)));
console.log(f3(opt(mkA(2), false)));
console.log(f4(optN(mkA(1), true)));
console.log(f4(optN(mkB(1), true)));
console.log(f4(optN(mkA(1), false)));
console.log(f5(true));
console.log(f5(false));
console.log(f6(opt(mkA(7), true)));
console.log(f6(opt(mkA(1), true)));
console.log(f6(opt(mkB(9), true)));
console.log(f6(opt(mkA(7), false)));
console.log(f7(opt(mkA(0), true)));
console.log(f7(opt(mkA(5), true)));
console.log(f7(opt(mkB(5), true)));
console.log(f7(opt(mkA(5), false)));
