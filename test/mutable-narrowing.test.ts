/*
 * NARROWING A FIELD THE CHECKER CANNOT TRACK — and the hint that used to recommend the
 * code the author had already written.
 *
 * `Checker.accessPath` records a narrowing fact only for a STABLE access path. It
 * declines `this`, a `@@mutable` receiver, a `?.` link and anything computed, because an
 * alias can store a different value into such a field between the guard and the read.
 * That rule is sound and stays. What was wrong was what the compiler SAID about it:
 *
 *     //@@mutable
 *     interface P { name: string; def?: string }
 *     function f(p: P): void { if (p.def) console.log(p.def.length); }
 *
 *     error[NT2001]: 'p.def' is possibly undefined
 *       = help: … or prove it non-nullish first — `if (p.def) { … }`, …
 *
 * The guard it asked for is on the same line. A reader who trusts the hint writes it
 * again, gets the same error, and has no way to learn from the compiler that no guard on
 * that spelling can ever work. `narrowAdvice` already had the truthful wording for the
 * union-field read; only the nullish path had not learned it.
 *
 * THE REPLACEMENT IS COMPILED, NOT ASSERTED. A hint is trusted exactly when the reader is
 * unsure, so one that routes into another refusal is worse than none — eleven of those
 * were found in this tree in a single day. Every spelling this hint now recommends is
 * built and run against node below.
 *
 * The un-narrowable rule itself is NOT relaxed here: `@@mutable` is what makes an aliased
 * write observable, which is the whole reason the fact cannot be recorded.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, emitIR, runWithNodeAttrs } from "./harness.ts";

/** Compile-only: the diagnostic a source is rejected with, or `null` if it compiles. */
function rejectionOf(source: string): { code: string; message: string; hint?: string } | null {
  try {
    emitIR(source);
    return null;
  } catch (e) {
    const d = (e as { diag?: { code: string; message: string; hint?: string } }).diag;
    return d ?? { code: "?", message: String(e) };
  }
}

/** node is the oracle. The pragma is a comment to node, so the SAME source runs there. */
async function expectMatchesNodeAttrs(source: string) {
  const oracle = await runWithNodeAttrs(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  expect(ours.stdout.length).toBeGreaterThan(0);
}

const MUTABLE_GUARDED = `
//@@mutable
interface P { name: string; def?: string }
function f(p: P): void { if (p.def) console.log(p.def.length); else console.log(-1); }
f({ name: "a", def: "xyz" });
f({ name: "b" });
`;

const THIS_GUARDED = `
class Box {
  private def?: string;
  constructor(d?: string) { this.def = d; }
  show(): void { if (this.def) console.log(this.def.length); else console.log(-1); }
}
new Box("xyz").show();
new Box().show();
`;

describe("a nullish read through an un-narrowable receiver", () => {
  test("a `@@mutable` field is still refused — the aliasing rule is not relaxed", () => {
    const r = rejectionOf(MUTABLE_GUARDED);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.message).toContain("'p.def' is possibly undefined");
  });

  test("the hint no longer recommends the guard that is already written", () => {
    const hint = rejectionOf(MUTABLE_GUARDED)!.hint ?? "";
    expect(hint.length).toBeGreaterThan(0);
    // The old text. It named `if (p.def) { … }` as the fix at a read whose author wrote
    // exactly that one line up.
    expect(hint).not.toContain("prove it non-nullish first");
    // The new text says WHY no guard on this spelling can work, and what does.
    expect(hint).toContain("STABLE access path");
    expect(hint).toContain("@@mutable");
    expect(hint).toContain("const v = p.def;");
  });

  test("`this.<field>` gets the same truthful hint (accessPath declines `this` too)", () => {
    const hint = rejectionOf(THIS_GUARDED)!.hint ?? "";
    expect(hint).toContain("STABLE access path");
    expect(hint).toContain("const v = this.def;");
  });

  // ---- the advice, COMPILED --------------------------------------------------------
  test("the hint's `bind it first` spelling compiles and matches node (`@@mutable`)", async () => {
    await expectMatchesNodeAttrs(`
//@@mutable
interface P { name: string; def?: string }
function f(p: P): void {
  const v = p.def;
  if (v) console.log(v.length); else console.log(-1);
}
f({ name: "a", def: "xyz" });
f({ name: "b" });
`);
  });

  test("the hint's `bind it first` spelling compiles and matches node (`this`)", async () => {
    await expectMatchesNodeAttrs(`
class Box {
  private def?: string;
  constructor(d?: string) { this.def = d; }
  show(): void {
    const v = this.def;
    if (v) console.log(v.length); else console.log(-1);
  }
}
new Box("xyz").show();
new Box().show();
`);
  });

  test("the hint's `?.` spelling compiles and matches node", async () => {
    await expectMatchesNodeAttrs(`
//@@mutable
interface P { name: string; def?: string }
function f(p: P): void { console.log(p.def?.length ?? -1); }
f({ name: "a", def: "xyz" });
f({ name: "b" });
`);
  });
});

describe("a STABLE receiver is untouched", () => {
  // The mutation guard. Swap the condition for a blanket `true` and this fails: an
  // ordinary record's dotted field DOES narrow, so the original hint is the right one
  // there and the "bind it first" text would be advice for a problem the reader does
  // not have.
  test("an undecorated record narrows through the guard and compiles", async () => {
    await expectMatchesNodeAttrs(`
interface P { name: string; def?: string }
function f(p: P): void { if (p.def) console.log(p.def.length); else console.log(-1); }
f({ name: "a", def: "xyz" });
f({ name: "b" });
`);
  });

  test("an unguarded read on an undecorated record keeps the original hint", () => {
    const r = rejectionOf(`
interface P { name: string; def?: string }
function f(p: P): void { console.log(p.def.length); }
f({ name: "a", def: "xyz" });
`);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.hint ?? "").toContain("prove it non-nullish first");
    expect(r!.hint ?? "").not.toContain("STABLE access path");
  });
});

/*
 * WHY THE RULE IS LOAD-BEARING — and what it costs, measured.
 *
 * The file above says the aliasing rule "is sound and stays" and leaves it there. That is
 * an assertion about a counterexample nobody had written down, on a rule that is the
 * FIRST BLOCKER of three of this compiler's own modules, so the next lane to look at it
 * has to re-derive the argument from scratch. Both halves are pinned here instead.
 *
 * THE COUNTEREXAMPLE. It is not aliasing that does it — an aliased write is already
 * NT1607 ("`q` is an alias of `p`, which still owns the value"). It is a CALL:
 *
 *     //@@mutable interface P { name: string; def?: string }
 *     function clear(p: P): void { p.def = undefined; }
 *     function f(p: P): void { if (p.def) { clear(p); console.log(p.def.length); } }
 *     try { f({ name: "a", def: "xyz" }); } catch { console.log("caught"); }
 *     console.log("done");
 *
 * node prints "caught\ndone" and exits 0. Delete the `isMutableTy` test from
 * `Checker.accessPath` and this compiles, then PANICS: exit 255, and the `try/catch` node
 * uses to survive it does not exist at runtime. That is a wrong answer, not a refusal —
 * the "compiles, then exit 255 with empty stdout" shape, which is why the decline is not
 * an over-approximation that can simply be dropped. The engine of it — a callee writing a
 * caller's field in place, and the caller observing it — is compiled against node below,
 * because that is the fact everything above depends on.
 *
 * WHAT IT COSTS. Measured on the stage-1 program (bun run test/blocker-metric.ts), by
 * per-function diff:
 *
 *   164/717 baseline
 *   168/717 with `Param` and `Declarator` tagged `//@@mutable`   (+4: the tag clears one
 *           NT1606 and costs FIVE optional-field narrowings, `if (d.init) go(d.init)` and
 *           `d.ty === undefined || isArrayTy(d.ty)`)
 *   160/717 with the same tags AND the decline removed          (-4, and zero new failures)
 *
 * So the narrowing rule is the WHOLE cost of the `@@mutable` route for the AST types, and
 * the entire prize for solving it is four functions. Every one of the five sites reads the
 * narrowed field as an ARGUMENT of the first call after the guard — where no call has yet
 * COMPLETED — so a sound rule exists, but it needs evaluation-order-sensitive
 * invalidation (statement granularity is not enough: `f(clear(p), p.def.length)` would
 * slip through it), and its failure mode is the panic above. That trade is a design
 * decision, not a lane's to take.
 */
describe("the aliasing rule's counterexample (why `accessPath` declines `@@mutable`)", () => {
  test("a CALLEE writes the caller's field in place, and the caller sees it", async () => {
    await expectMatchesNodeAttrs(`
//@@mutable
interface P { name: string; def?: string }
function clear(p: P): void { p.def = undefined; }
function f(p: P): void {
  const before = p.def;
  clear(p);
  console.log(before === undefined ? "before-gone" : "before-here");
  console.log(p.def === undefined ? "after-gone" : "after-here");
}
f({ name: "a", def: "xyz" });
`);
  });

  test("an ALIASED write is refused before it gets that far (NT1607, not narrowing)", () => {
    const r = rejectionOf(`
//@@mutable
interface P { name: string; def?: string }
function f(p: P): void {
  const q = p;
  q.def = undefined;
  console.log(p.def === undefined ? "gone" : "here");
}
f({ name: "a", def: "xyz" });
`);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT1607");
  });

  // The guard on the relaxation. Remove `|| this.isMutableTy(bt)` from `accessPath` and
  // this stops being refused and starts being a panic where node prints "caught".
  test("the counterexample itself stays REFUSED", () => {
    const r = rejectionOf(`
//@@mutable
interface P { name: string; def?: string }
function clear(p: P): void { p.def = undefined; }
function f(p: P): void {
  if (p.def) { clear(p); console.log("len=" + String(p.def.length)); }
}
try { f({ name: "a", def: "xyz" }); } catch (e) { console.log("caught"); }
console.log("done");
`);
    expect(r).not.toBeNull();
    expect(r!.code).toBe("NT2001");
    expect(r!.hint ?? "").toContain("STABLE access path");
  });

  // …and the bound-local rewrite the hint recommends is still correct UNDER that
  // mutation: `v` holds the value the guard proved, so node and we both print 3.
  test("`bind it first` survives the mutation the rule is about", async () => {
    await expectMatchesNodeAttrs(`
//@@mutable
interface P { name: string; def?: string }
function clear(p: P): void { p.def = undefined; }
function f(p: P): void {
  const v = p.def;
  if (v) { clear(p); console.log(v.length); } else console.log(-1);
}
f({ name: "a", def: "xyz" });
console.log("done");
`);
  });
});
