/*
 * Definite assignment — `let x: T;` with no initializer.
 *
 * THE DEFECT THIS CLOSES: `Declarator.init` used to be NON-optional, so the parser
 * SYNTHESIZED an `UndefinedLiteral` for a bare `let x: T;`. That made
 *
 *     let s: string;              // legal TypeScript
 *     let s: string = undefined;  // correctly rejected
 *
 * INDISTINGUISHABLE downstream, and the checker rejected both with NT2001
 * ("'s' declared string but initialized with undefined"). node runs the first one
 * fine. The fix makes the distinction REPRESENTABLE (`init?: Expr`) and then decides
 * the bare form by definite-assignment analysis.
 *
 * THE RULE, and why it is not "just accept it": node prints `undefined` for a read
 * before assignment, but the binding's declared type is `string` — we have no value of
 * type `string` to produce and no slot to hold `undefined` in, so codegen could only
 * serve the slot's zero (`(null)`). That is the silent wrong answer the prime directive
 * forbids. A read on a path that has not assigned is REFUSED (NT1600). Assigned on ALL
 * paths compiles.
 *
 * The refusals below are DELIBERATE divergences from node, recorded in
 * docs/divergences.md: node prints a value for `let s: string; if (c) s = "a";
 * console.log(s)`, and we reject it.
 *
 * Cases are DERIVED — not taken from test262 or the TypeScript conformance suite.
 * rustc's E0381 ("used binding is possibly-uninitialized") is the model for the
 * analysis, and NT1600 mirrors that code, matching the rustc-numbering convention the
 * ownership pass already follows (NT1601 ≈ E0382).
 */
import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile + run, and assert we agree with node byte-for-byte (stdout AND exit code). */
async function expectNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

/** Assert the compiler REFUSES `source` with `code` (a refusal, never a wrong answer). */
function expectRefused(source: string, code: string): NTError {
  let err: unknown;
  try {
    sourceToIR(source);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NTError);
  expect((err as NTError).diag.code).toBe(code);
  return err as NTError;
}

describe("definite assignment — `let x: T;` with no initializer", () => {
  // 1. the straight-line case: assigned, then read
  test("a bare declaration assigned before use compiles", async () => {
    await expectNode(`
let s: string;
s = "hi";
console.log(s);
`);
  });

  // 2. the same for a non-string type — the slot's zero differs, the rule does not
  test("a bare number declaration assigned before use compiles", async () => {
    await expectNode(`
let n: number;
n = 5;
console.log(n + 1);
`);
  });

  // 3. read with NO assignment at all. node prints `undefined`; at type `string` we
  //    have no such value, and the slot's zero would print `(null)`. Refuse.
  test("a read with no assignment at all is refused", () => {
    const e = expectRefused(`
let s: string;
console.log(s);
`, "NT1600");
    expect(e.diag.message).toContain("'s' is used before being assigned");
    expect(e.diag.hint).toContain("string | undefined");
  });

  // 4. assigned on ONE branch only — not assigned on all paths
  test("assignment on only one branch of an `if` is refused", () => {
    expectRefused(`
const c: boolean = true;
let s: string;
if (c) s = "a";
console.log(s);
`, "NT1600");
  });

  // 5. assigned on BOTH branches — the merge is an intersection, and both sides have it
  test("assignment on both branches of an if/else compiles", async () => {
    await expectNode(`
const c: boolean = true;
let s: string;
if (c) s = "a"; else s = "b";
console.log(s);
`);
  });

  // 6. a DIVERGING branch contributes nothing to the merge — the guard-clause idiom
  test("an early return makes the remaining path definitely assigned", async () => {
    await expectNode(`
function f(c: boolean): string {
  let s: string;
  if (!c) return "early";
  s = "late";
  return s;
}
console.log(f(true), f(false));
`);
  });

  // 7. THE cli.ts SHAPE: assigned in a `try`, handler diverges via process.exit
  test("assigned in a try whose catch exits compiles", async () => {
    await expectNode(`
let s: string;
try { s = "read"; } catch { console.error("bad"); process.exit(1); }
console.log(s);
`);
  });

  // 8. a catch that FALLS THROUGH leaves the binding unassigned on that path. The
  //    handler starts from the try's ENTRY state: the throw may precede the assignment.
  test("assigned in a try whose catch falls through is refused", () => {
    expectRefused(`
let s: string;
try { s = "read"; } catch { console.error("bad"); }
console.log(s);
`, "NT1600");
  });

  // 9. assigned in BOTH the try and the catch — assigned on every path out
  test("assigned in both the try and the catch compiles", async () => {
    await expectNode(`
let s: string;
try { s = "read"; } catch { s = "fallback"; }
console.log(s);
`);
  });

  // 10. a loop body may run ZERO times, so what it assigns is not assigned after it
  test("assignment inside a while body is refused after the loop", () => {
    expectRefused(`
let n: number;
let i = 0;
while (i < 3) { n = i; i = i + 1; }
console.log(n);
`, "NT1600");
  });

  // 11. …but a `do…while` body always runs once
  test("assignment inside a do-while body compiles after the loop", async () => {
    await expectNode(`
let n: number;
do { n = 7; } while (false);
console.log(n);
`);
  });

  // 12. THE REGRESSION GUARD. A type that ADMITS `undefined` is genuinely initialized
  //     to `undefined` by a bare declaration — this compiled before the change and must
  //     keep compiling, printing exactly what node prints.
  test("`let s: string | undefined;` still starts as undefined", async () => {
    await expectNode(`
let s: string | undefined;
console.log(s);
s = "now";
console.log(s);
`);
  });

  // 13. THE OTHER REGRESSION GUARD (test/corpus/gap_cases.json `null-undefined-typeof`).
  //     An UNANNOTATED `let x;` has type `undefined` here, so it too is genuinely
  //     initialized and never reaches definite assignment — it printed `undefined` before
  //     the change and must keep doing so. An early cut of this lane refused it, which
  //     broke that corpus case.
  test("`let x;` with no annotation still has type undefined", async () => {
    await expectNode(`
const a = null;
let b;
console.log(a);
console.log(b);
console.log(typeof a);
console.log(typeof b);
`);
  });

  // 13b. a `const` can never be assigned later, so an absent initializer is not a
  //      definite-assignment question — it is the hard error node gives too
  //      ("'const' declarations must be initialized").
  test("`const x: T;` with no initializer is refused as a const error", () => {
    const e = expectRefused(`
const c: number;
console.log(c);
`, "NT2001");
    expect(e.diag.message).toContain("`const` with no initializer");
  });

  // 14. a compound assignment READS the target first, so it cannot be the first write.
  //     `x += 1` carries its target as a bare string, not an Identifier node — the case
  //     a node-only walk would miss.
  test("a compound assignment to an unassigned binding is refused", () => {
    expectRefused(`
let n: number;
n += 1;
console.log(n);
`, "NT1600");
  });

  // 15. so does `x++` — same bare-string target, same reason
  test("an increment of an unassigned binding is refused", () => {
    expectRefused(`
let n: number;
n++;
console.log(n);
`, "NT1600");
  });

  // 16. a read nested inside a larger expression is still a read
  test("a read nested in an expression is refused", () => {
    expectRefused(`
let n: number;
console.log([1, 2, 3].map((x) => x + n).join(","));
`, "NT1600");
  });

  // 17. the binding is usable normally once every path has assigned it
  test("a definitely-assigned binding behaves like any other", async () => {
    await expectNode(`
function pick(c: boolean): number {
  let n: number;
  if (c) { n = 10; } else { n = 20; }
  n = n + 1;
  return n;
}
console.log(pick(true), pick(false));
`);
  });

  /* ----------------------------------------------------------------
   * The two holes the first cut of this pass had. Both were caught by probing
   * rather than by the cases above, and both produced a WRONG ANSWER, not a crash —
   * so both get a regression test naming what the wrong answer was.
   * ---------------------------------------------------------------- */

  // 18. An ARROW body is its own control-flow region. Analyzing only `FuncDecl` bodies
  //     left `() => { let a: string; return a; }` unchecked, and it PRINTED `(null)`
  //     where node prints `undefined`.
  test("an arrow function body is analyzed too", () => {
    expectRefused(`
const f = (): string => { let a: string; return a; };
console.log(f());
`, "NT1600");
  });

  // 19. This analysis is NAME-based, and so was codegen (one slot per name per
  //     function). An inner `let s` shadowing a tracked outer `s` looked exactly like
  //     an assignment to the outer one, so the outer read passed on the inner one's
  //     proof and the program printed one line instead of two — hence a blanket
  //     "redeclared" refusal, which was the only safe answer while the two bindings
  //     shared a frame slot.
  //
  //     `alphaRenameShadows` now gives them DIFFERENT names before this pass runs, so
  //     they are distinguishable and the special case is gone. The program is still
  //     refused, but by the ordinary rule and with the accurate reason: the OUTER `s`
  //     genuinely never gets a value (node prints `inner` then `undefined`), exactly
  //     like `let s: string; console.log(s);` one test up.
  test("shadowing does not launder a still-unassigned binding", () => {
    const e = expectRefused(`
let s: string;
{ let s: string = "inner"; console.log(s); }
console.log(s);
`, "NT1600");
    expect(e.diag.message).toContain("used before being assigned");
  });

  // 19b. …and the mirror image, which the blanket refusal used to reject too: the outer
  //      binding IS assigned, so shadowing it is an ordinary, correct program.
  test("shadowing an assigned binding is accepted", async () => {
    const r = await compileAndRun(`
let s: string;
s = "outer";
{ let s: string = "inner"; console.log(s); }
console.log(s);
`);
    expect(r.stdout).toBe("inner\nouter\n");
    expect(r.exitCode).toBe(0);
  });

  /* ----------------------------------------------------------------
   * 20-21. Making `init` OPTIONAL was the right fix, but it is a change every
   * declarator walker in the compiler has to have learned. The capture-write pass
   * (NT1031) is newer than this feature and had NOT: both of its walkers read
   * `d.init` unconditionally and switched on `.kind` of `undefined`, so the compiler
   * CRASHED with a raw `TypeError` — no NT code, no span, no hint.
   *
   * That is worse than either outcome the prime directive contemplates: not a wrong
   * answer, but not a refusal either. Both programs below are ordinary TypeScript that
   * node runs without complaint, and the bare `let` is never even the thing under
   * analysis — it just has to be SOMEWHERE the pass walks.
   * ---------------------------------------------------------------- */

  // 20. `refsInStmt` — the enclosing body is scanned for other uses of the captured
  //     name, and an uninitialized `let` ANYWHERE in that body crashed the scan.
  //     `count` is mentioned only inside the closure, so NT1031 does not apply and the
  //     program compiles; `spare` is unrelated to the capture and merely has to be
  //     present for the walker to trip over it.
  test("a bare declaration beside a capturing closure does not crash the compiler", async () => {
    await expectNode(`
let spare: string;
let count = 0;
const bump = () => { count = count + 1; return count; };
spare = "ok";
console.log(bump(), bump(), spare);
`);
  });

  // 21. `escapingWritesStmts` — the same hazard on the other side of the rule, where
  //     the bare declaration is INSIDE the closure whose writes are being collected.
  test("a bare declaration inside a closure does not crash the compiler", async () => {
    await expectNode(`
const label = (): string => {
  let out: string;
  out = "inner";
  return out;
};
console.log(label());
`);
  });

  /*
   * 22. THE ANALYSIS REACHES A BLOCK ARROW'S STATEMENTS AT ALL.
   *
   * `checkDefiniteAssignment` runs `daBlock` on the top-level body and then walks the
   * whole tree SHAPE-BLIND, re-running it on each nested function body it recognizes.
   * "Recognizes" is the load-bearing word: it identifies a nested body by asking whether
   * the node's statement-list field is an array. `ArrowFunction` used to spell that field
   * `body` (shared with the expression form) and now spells it `stmts`, so a walk still
   * asking about `body` finds nothing, runs no analysis inside any block arrow, and
   * SILENTLY ACCEPTS the read this test refuses — the exact silent-wrong-answer class the
   * prime directive forbids, and invisible to every other test in this file because they
   * all put the unassigned read at the top level.
   *
   * Test 21 above is its twin and does NOT catch it: an arrow that assigns before reading
   * compiles either way.
   */
  test("an unassigned read INSIDE a block-bodied arrow is refused, like one at the top level", () => {
    const e = expectRefused(`
const label = (): string => {
  let out: string;
  return out;
};
console.log(label());
`, "NT1600");
    expect(e.diag.message).toContain("'out' is used before being assigned");
  });
});
