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
