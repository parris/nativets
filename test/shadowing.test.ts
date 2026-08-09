/*
 * BLOCK-SCOPED SHADOWING — one frame slot per NAME was the bug.
 *
 * Codegen lowers a function to a single flat frame whose allocas are keyed by SOURCE
 * NAME (`addLocal` returns early when the name is already known). Every JS block scope
 * inside that function therefore shared storage with every other, so:
 *
 *   const a: number = 1;
 *   if (a > 0) { const a: number = 2; console.log(a); }
 *   console.log(a);                 // node: 2 then 1.  nativets: 2 then 2.
 *
 * — a silent wrong answer on about the most basic construct the language has, exit 0 on
 * both sides. Three worse shapes hid behind it:
 *
 *   - at DIFFERENT TYPES the first declaration's type wins, so the second reads its
 *     value at the wrong LLVM type: `{ const a: string = "two"; }` under an outer
 *     `const a: number` printed `2.127e-314` — a string pointer bit-cast to a double —
 *     or crashed the compiler outright with an internal error;
 *   - SIBLING blocks collide too. `{ const a: number = 1; } { const a: string = "x"; }`
 *     has no shadowing at all, just two disjoint scopes reusing a name, and it was
 *     equally wrong;
 *   - with a LINEAR type (an array, a closure env) the inner scope's drop freed storage
 *     the outer name still reads: a DOUBLE FREE, exit 255. That is why exit code is
 *     asserted on every case here — `expectMatchesNode` asserts both, and this class of
 *     defect shows up as a nonzero exit with perfectly correct stdout.
 *
 * THE FIX is alpha-renaming (`alphaRenameShadows`, src/checker.ts): a declaration in a
 * nested scope whose name is already bound in the frame is renamed to `name.N`, and
 * every reference resolved through the checker's own scope rules is rewritten with it.
 * The `.` cannot occur in a source identifier, so a fresh name never collides — the same
 * device `freshenHofArrow` already used for inlined callbacks.
 *
 * BEHAVIOUR LIST mined from test262 `test/language/block-scope/` (`syntax/redeclaration`
 * and the `shadowing` cases under `leave/`) plus `test/language/statements/const/` and
 * `.../let/` — specifically `block-local-closure-set-before-initialization`,
 * `fn-name-*`, and the `dstr`/`scope-*` families, which are where the loop-per-iteration
 * and catch-parameter cases come from. TypeScript-specific shapes (annotations, a
 * shadow at a DIFFERENT annotated type) are DERIVED: there is no `microsoft/TypeScript`
 * checkout on this machine, so no conformance case could be cited for them.
 */

import { test, expect, describe } from "bun:test";
import { expectMatchesNode } from "./harness.ts";

/**
 * node is the oracle for BOTH streams. The exit code is not decoration: the linear-type
 * form of this bug is a double free, which prints node's exact stdout and then dies at
 * 255, so a stdout-only assertion would have called it a pass.
 */
async function sameAsNode(source: string, expected?: string): Promise<void> {
  const { ours, oracle } = await expectMatchesNode(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  if (expected !== undefined) expect(ours.stdout).toBe(expected);
}

describe("block-scoped shadowing", () => {
  /* 1. The reported repro. test262 block-scope/leave/x-after-break-* shape: an inner
   *    binding must not survive its block. */
  test("`const` shadowed in an `if` block", async () => {
    await sameAsNode(`
const a: number = 1;
if (a > 0) { const a: number = 2; console.log(a); }
console.log(a);
`, "2\n1\n");
  });

  /* 2. `let` behaves identically — the bug was in storage, not in mutability.
   *    (test262 block-scope/syntax/redeclaration/let-declaration-*.) */
  test("`let` shadowed in an `if` block", async () => {
    await sameAsNode(`
let a: number = 1;
if (a > 0) { let a: number = 2; console.log(a); }
console.log(a);
`, "2\n1\n");
  });

  /* 3. A bare block, with nothing to make the scope look conditional.
   *    (test262 block-scope/leave/verify-block-scope-is-a-scope.) */
  test("a bare block", async () => {
    await sameAsNode(`
const a: number = 1;
{ const a: number = 2; console.log(a); }
console.log(a);
`, "2\n1\n");
  });

  /* 4. Two levels deep: each block gets its own slot, not one extra between them. */
  test("shadowed at two levels", async () => {
    await sameAsNode(`
const a: number = 1;
{ const a: number = 2; { const a: number = 3; console.log(a); } console.log(a); }
console.log(a);
`, "3\n2\n1\n");
  });

  /* 5. SIBLING scopes — the shape that shows this was never really about *shadowing*.
   *    Neither block shadows the other; they merely reuse a name, at different types,
   *    and the second read the first one's slot at the first one's type. Printed
   *    `2.161e-314` (a string pointer as a double) before the fix. Derived: a shadow at
   *    a different ANNOTATED type is TypeScript-specific and there is no
   *    `microsoft/TypeScript` checkout here to cite a conformance case from. */
  test("sibling blocks reusing a name at different types", async () => {
    await sameAsNode(`
{ const a: number = 1; console.log(a); }
{ const a: string = "two"; console.log(a); }
`, "1\ntwo\n");
  });

  /* 6. The same at a different type, nested — this one used to crash the compiler with
   *    an internal error (`no member lowering for .length on string`) as often as it
   *    printed garbage, because the outer declaration's type won. */
  test("shadowed at a different type", async () => {
    await sameAsNode(`
const a: number = 1;
{ const a: string = "two"; console.log(a); }
console.log(a);
`, "two\n1\n");
  });

  /* 7. A loop BODY is a fresh scope per iteration (test262
   *    block-scope/leave/for-loop-block-let-declaration-only-shadows-outer-*). */
  test("shadowed in a `for` body", async () => {
    await sameAsNode(`
const a: number = 1;
for (let i = 0; i < 2; i++) { const a: number = i + 10; console.log(a); }
console.log(a);
`, "10\n11\n1\n");
  });

  test("shadowed in a `while` body", async () => {
    await sameAsNode(`
const a: number = 1;
let n = 0;
while (n < 2) { const a: number = n + 10; console.log(a); n++; }
console.log(a);
`, "10\n11\n1\n");
  });

  /* 8. The `for` HEAD is its own scope, distinct from the enclosing one: the loop
   *    counter used to leak its final value into the outer `const`. */
  test("a `for` init binding shadows an outer one", async () => {
    await sameAsNode(`
const i: number = 99;
for (let i = 0; i < 2; i++) { console.log(i); }
console.log(i);
`, "0\n1\n99\n");
  });

  test("a `for-of` element binding shadows an outer one", async () => {
    await sameAsNode(`
const x: number = 1;
for (const x of [10, 20]) { console.log(x); }
console.log(x);
`, "10\n20\n1\n");
  });

  /* 9. `try` / `catch` / the catch BINDING. The catch parameter was the worst of the
   *    set: `catch (e)` over an outer `const e: number` stored the caught string into
   *    the number slot, so BOTH reads printed `2.16e-314`. */
  test("shadowed inside a `try` block", async () => {
    await sameAsNode(`
const a: number = 1;
try { const a: number = 2; console.log(a); } catch (e) { console.log("x"); }
console.log(a);
`, "2\n1\n");
  });

  test("a `catch` binding shadows an outer one", async () => {
    await sameAsNode(`
const e: number = 1;
try { throw "boom"; } catch (e) { console.log(e); }
console.log(e);
`, "boom\n1\n");
  });

  test("shadowed inside a `catch` handler", async () => {
    await sameAsNode(`
const a: number = 1;
try { throw "b"; } catch (err) { const a: number = 2; console.log(a); }
console.log(a);
`, "2\n1\n");
  });

  /* 10. A `switch` body is ONE scope shared by every case, so a `const` in one case must
   *     not be given a second slot by another case — but it must still not collide with
   *     the enclosing scope. */
  test("shadowed inside a `switch` case", async () => {
    await sameAsNode(`
const a: number = 1;
switch (a) { case 1: { const a: number = 7; console.log(a); break; } }
console.log(a);
`, "7\n1\n");
  });

  /* 11. A PARAMETER shadowed by a block-level declaration in the same function — the
   *     only in-frame form the old model got wrong that is not a block/block pair. */
  test("a block declaration shadows a parameter", async () => {
    await sameAsNode(`
function p(a: number): number { { const a: number = 99; console.log(a); } return a; }
console.log(p(5));
`, "99\n5\n");
  });

  /* 12. Separate FRAMES were always correct; they must stay that way, and the fix must
   *     not rename anything in them (an arrow body, a nested function body, and a
   *     nested block inside a function). */
  test("an arrow body has its own frame", async () => {
    await sameAsNode(`
const a: number = 1;
const f = (): number => { const a: number = 2; return a; };
console.log(f());
console.log(a);
`, "2\n1\n");
  });

  test("a nested function body has its own frame", async () => {
    await sameAsNode(`
const a: number = 1;
function g(): number { const a: number = 2; return a; }
console.log(g());
console.log(a);
`, "2\n1\n");
  });

  /* 13. CLOSURES. The reason this bug had to be fixed rather than merely refused: the
   *     inner block's drop freed an env the outer name still called through, which is a
   *     double free (exit 255) rather than a wrong answer, and the ownership pass grew a
   *     `shadowedNames` disqualification to route around it. */
  test("a shadowed closure binding", async () => {
    await sameAsNode(`
const f = (k: number): number => k + 1;
{ const f = (k: number): number => k + 20; console.log(f(1)); }
console.log(f(1));
`, "21\n2\n");
  });

  /* 14. …and the same with a LINEAR value, where the exit code was the whole story:
   *     this exited 255 with no output at all. */
  test("a shadowed array binding", async () => {
    await sameAsNode(`
const xs: number[] = [1, 2];
{ const xs: number[] = [3, 4, 5]; console.log(xs.length); }
console.log(xs.length);
`, "3\n2\n");
  });

  test("a shadowed string binding", async () => {
    await sameAsNode(`
const s: string = "out";
{ const s: string = "in"; console.log(s); }
console.log(s);
`, "in\nout\n");
  });

  /* 15. A closure declared in a nested scope must capture THAT scope's binding, not the
   *     enclosing frame's — the hazard the rename itself could have introduced, since a
   *     capture is resolved by name inside a separate LLVM function. */
  test("an arrow captures the renamed inner binding, not the outer one", async () => {
    await sameAsNode(`
function run(): number {
  const a: number = 2;
  { const a: number = 30; const g = (): number => a + 1; return g(); }
}
console.log(run());
`, "31\n");
  });

  /* 16. THE ONE SHAPE STILL WRONG, pinned so it cannot silently get worse.
   *
   *     A reference that precedes its own declarator in the same block resolves to the
   *     OUTER binding, because this pass binds a name where it is declared rather than
   *     on scope entry. Entry-binding is the correct JS model and was tried: it resolves
   *     the reference to the inner `g` all right, whose slot is still uninitialized
   *     there, so `f()` called through garbage and the program died at 255 — strictly
   *     worse than the wrong answer. Forward-referencing a `const` arrow is unsupported
   *     anyway (the same program with no outer `g` to absorb the reference is NT1003).
   *
   *     What this lane DOES fix here is the second line: the outer `g` used to read the
   *     inner one's slot and print `5`. See docs/divergences.md. */
  test("known gap: a forward reference inside the shadowing block reads the outer binding", async () => {
    const { ours, oracle } = await expectMatchesNode(`
const g = (): number => 100;
{
  const f = (): number => g() + 1;
  const g = (): number => 5;
  console.log(f());
}
console.log(g());
`);
    expect(oracle.stdout).toBe("6\n100\n");
    expect(ours.stdout).toBe("101\n100\n"); // line 1 still wrong; line 2 is the fix
    expect(ours.exitCode).toBe(0); // and NOT a call through an uninitialized slot
  });

  /* 17. Reassignment through the shadowed name writes the INNER slot only. */
  test("assignment inside the shadowing block does not touch the outer binding", async () => {
    await sameAsNode(`
let a: number = 1;
{ let a: number = 2; a = a + 40; console.log(a); }
console.log(a);
`, "42\n1\n");
  });
});
