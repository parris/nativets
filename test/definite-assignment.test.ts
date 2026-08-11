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

  /*
   * 11b. `break` LEAVES THE SWITCH — it does not leave the function.
   *
   * This was a MISCOMPILE, not a refusal. The pass marked any case body ending in
   * `break` as "diverged", so a switch whose every arm ended in `break` was itself
   * "diverging" — the statements after it were never analyzed at all, and every
   * diverged path was dropped from the assignment INTERSECTION. `f(2)` below took the
   * `default:` arm, assigned nothing, and read `x` anyway: node prints `undefined`,
   * we printed the slot's zero, `0`. The refusal is the correct answer here.
   */
  test("a switch whose arms all `break` does NOT make the code after it unreachable", () => {
    expectRefused(`
function f(c: number): number {
  let x: number;
  switch (c) {
    case 1: x = 1; break;
    default: break;
  }
  return x;
}
console.log(f(2));
`, "NT1600");
  });

  /*
   * 11c. …and a `break` from the MIDDLE of a case body lands at the switch's exit too.
   * The same miscompile, reached the other way: the arm's END was assigned, so the arm
   * was merged in as if the break path did not exist. `f(1, true)` printed `0`, node
   * prints `undefined`. This is why the break paths are collected as they are MET and
   * not inferred from how the body finished.
   */
  test("a `break` from the middle of a case body is still a path out of the switch", () => {
    expectRefused(`
function f(c: number, b: boolean): number {
  let x: number;
  switch (c) {
    default: {
      if (b) { break; }
      x = 1;
      break;
    }
  }
  return x;
}
console.log(f(1, true));
`, "NT1600");
  });

  /*
   * 11d. The `do…while` form of the same defect. Its body always runs, so unlike a
   * `while` its assignments ARE kept — which is exactly what made the break path matter:
   * `f(true)` leaves before `n = 7` and read the slot's zero, `0`, where node prints
   * `undefined`. (The `while`/`for` loops keep nothing, so they never had this hole.)
   */
  test("a `break` out of a do-while body skips the rest of it", () => {
    expectRefused(`
function f(c: boolean): number {
  let n: number;
  do {
    if (c) { break; }
    n = 7;
  } while (false);
  return n;
}
console.log(f(true));
`, "NT1600");
  });

  /*
   * 11e. `continue` runs the TEST, and the test can then end the loop — so it is a way
   * out of a `do…while` body just as `break` is, and the fourth spelling of the same
   * wrong answer. `continue` is NOT a way out of a `switch`, though: it jumps past the
   * switch's exit to the enclosing loop's head, which is why the two are collected
   * separately and a `switch` passes the `continue` paths through to the loop.
   */
  test("a `continue` out of a do-while body is a way out of it too", () => {
    expectRefused(`
function f(): number {
  let n: number;
  do { continue; } while (false);
  return n;
}
console.log(f());
`, "NT1600");
  });

  // ...and the same loop without the escape still compiles — the body ran, so `n` is set.
  test("a do-while with no escape still proves its body's assignment", async () => {
    await expectNode(`
let n: number;
do { n = 7; break; } while (false);
console.log(n);
`);
  });

  // A `break` inside a NESTED loop belongs to that loop, not to the switch around it.
  test("a break in a nested loop is not charged to the enclosing switch", async () => {
    await expectNode(`
function f(c: number): number {
  let x: number;
  switch (c) {
    default: {
      x = 0;
      while (true) { x = 9; break; }
      break;
    }
  }
  return x;
}
console.log(f(1));
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

/*
 * THE CLASS-FIELD ANALOGUE of everything above, which had no coverage at all.
 *
 * A field slot is a real slot in the instance's heap block, so "absent" has to be
 * WRITTEN — the same reason `let s: string | undefined;` is genuinely initialized to
 * `undefined` (test 12). `parseClass` did write it, but only for the `x?: T` SPELLING:
 * the fill was gated on the `?` token rather than on the field's TYPE. Written as the
 * equivalent explicit union `x: T | undefined`, the slot stayed zero.
 *
 * The two spellings denote the SAME type — `parseClass` runs both through
 * `makeNullable("undefined", ty)` and gets the same `Ty` back — so nothing downstream
 * could tell them apart, and a read of the unwritten slot dereferenced NULL.
 *
 * Severity: `x: number | undefined` with no initializer is VALID strict TypeScript.
 * `tsc --strict` accepts it (`undefined` is in the declared type, so
 * strictPropertyInitialization is satisfied), node prints `undefined`, and the compiled
 * binary died with SIGSEGV — exit 139 against node's 0. A memory-safety failure on a
 * program the type checker signs off on is the worst outcome this compiler has.
 */
describe("definite assignment — class fields", () => {
  // 23. THE DEFECT. `x` is never assigned by the constructor and its type admits
  //     `undefined`, so it reads as `undefined` — exactly as the `x?: T` spelling below.
  test("a `T | undefined` field the constructor never assigns reads as undefined", async () => {
    await expectNode(`
class C {
  x: number | undefined;
  y: number;
  constructor(y: number) { this.y = y; }
}
const c = new C(7);
console.log(c.x === undefined, c.x, c.y);
`);
  });

  // 24. THE REGRESSION GUARD: the `?` spelling already worked and must keep working.
  //     It is the same type and must give the same answer.
  test("the `x?: T` spelling of the same field agrees", async () => {
    await expectNode(`
class C {
  x?: number;
  y: number;
  constructor(y: number) { this.y = y; }
}
const c = new C(7);
console.log(c.x === undefined, c.x, c.y);
`);
  });

  // 25. A POINTER-SHAPED field is where the unwritten slot actually segfaulted rather
  //     than merely reading a zero — `string` is a heap pointer, so the read
  //     dereferenced NULL instead of printing `0`.
  test("a `string | undefined` field the constructor never assigns reads as undefined", async () => {
    await expectNode(`
class C {
  s: string | undefined;
  n: number;
  constructor(n: number) { this.n = n; }
}
const c = new C(3);
console.log(c.s === undefined, c.n);
`);
  });

  // 26. …and the fill must not overwrite a field the constructor DOES assign.
  test("a nullable field the constructor does assign keeps the assigned value", async () => {
    await expectNode(`
class C {
  x: number | undefined;
  constructor(x: number) { this.x = x; }
}
console.log(new C(5).x);
`);
  });

  /*
   * 27. THE OTHER HALF OF THE SAME ROOT CAUSE. The uninitialized-field refusal was
   * gated on `!hadExplicitCtor`, so the moment a class had ANY constructor the guard
   * stopped running — and the constructor was never checked for actually assigning
   * every field. A NON-nullable field left unassigned then read the slot's zero:
   *
   *     node   -> 7 undefined      (exit 0)
   *     before -> 7 0              (exit 0)   <- silent wrong answer, no diagnostic
   *
   * Both exit 0, so nothing anywhere in the tree noticed. `tsc --strict` rejects this
   * program (TS2564, "Property 'z' has no initializer and is not definitely assigned
   * in the constructor"), which is why no fixture carried the shape — but rejecting it
   * is the compiler's own job, not tsc's, and printing `0` for `undefined` is exactly
   * the outcome the prime directive puts last.
   *
   * There is no value of type `number` to hand back, so this is a REFUSAL, on the same
   * reasoning test 3 above gives for `let s: string; console.log(s);`.
   */
  test("a non-nullable field the constructor never assigns is refused", () => {
    const e = expectRefused(`
class C {
  y: number;
  z: number;
  constructor(y: number) { this.y = y; }
}
console.log(new C(7).z);
`, "NT1015");
    expect(e.diag.message).toContain("'z'");
    expect(e.diag.message).toContain("never assigned by its constructor");
    // NOT the generic "this class feature is deferred" hint — nothing is deferred here.
    expect(e.diag.hint).toContain("has no such value");
  });

  /*
   * 29. THE HINT'S OWN ADVICE, COMPILED. The refusal above names three ways out; a hint
   * that names a fix which does not work is worse than no hint at all. Each one is run
   * against node here, so the hint cannot rot into a lie without this failing.
   */
  test("every fix the refusal's hint suggests actually compiles and matches node", async () => {
    // (a) assign it in the constructor
    await expectNode(`
class C {
  y: number;
  z: number;
  constructor(y: number) { this.y = y; this.z = 99; }
}
console.log(new C(7).y, new C(7).z);
`);
    // (b) give it an initializer
    await expectNode(`
class C {
  y: number;
  z: number = 99;
  constructor(y: number) { this.y = y; }
}
console.log(new C(7).y, new C(7).z);
`);
    // (c) widen the type to include `undefined`
    await expectNode(`
class C {
  y: number;
  z: number | undefined;
  constructor(y: number) { this.y = y; }
}
console.log(new C(7).y, new C(7).z);
`);
  });

  // 28. …and the guard must still pass a constructor that assigns every field,
  //     including from a nested/conditional position.
  test("a constructor that assigns every field still compiles", async () => {
    await expectNode(`
class C {
  y: number;
  z: number;
  constructor(y: number, c: boolean) {
    this.y = y;
    if (c) { this.z = 1; } else { this.z = 2; }
  }
}
console.log(new C(7, true).z, new C(7, false).z);
`);
  });
});
