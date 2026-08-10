/*
 * RETURNING an object literal that omits an optional field.
 *
 *     interface F { a: number; b?: number }
 *     function f(): F { return { a: 1 }; }
 *
 * `tsc` accepts this and node runs it. nativets refused it:
 *
 *     error[NT2001]: return type {a:number} does not match declared {a:number,b:?Unumber}
 *
 * The rule was never assignability — `assignable()` has handled optional fields
 * structurally for a long time. It was that nothing RESHAPED the literal on the `return`
 * path. The declaration path reshapes (`retypeLiteral`, checker.ts VarDecl), the argument
 * path reshapes (`fitsArg`), the arrow EXPRESSION body reshapes (`typeArrowReturn`) — and
 * `return` had neither: it called the bare `fitsParam` identity predicate. So the identical
 * value was accepted as a `const` initializer or as an argument and refused as a `return`.
 *
 * WHY THESE ASSERT STDOUT AND EXIT CODE, NOT "it compiles". The naive fix — swapping
 * `fitsParam` for the `assignable` predicate at the `return` site — makes every program
 * below compile CLEAN and then die: the callee builds `{a:1}` in its own one-raw-double
 * layout while the caller reads slot 1 as a pointer to a nullable box. Measured on this
 * lane before the fix: empty stdout, exit 255. A test that only asserted "no NT2001" would
 * pass on the memory-unsafe version. Only the node differential separates the two.
 *
 * The live site is `bodyFrame` (src/checker.ts), which returns `{ body, binds }` against
 * `interface BodyFrame { body; binds; closureAssigned? }` — the first blocker of
 * checker.ts, codegen.ts and ownership.ts alike.
 */

import { test, expect, describe } from "bun:test";

import { compileAndRun, runWithNode } from "./harness.ts";
import { sourceToIR } from "../src/driver.ts";
import { NTError } from "../src/diagnostics.ts";

/** Compile+run and `node`-run the same source; both streams must agree exactly. */
async function matchesNode(source: string): Promise<void> {
  const oracle = runWithNode(source);
  const ours = await compileAndRun(source);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("a returned object literal reshapes to the declared return layout", () => {
  const F = "interface F { a: number; b?: number }\n";

  test("the optional field is OMITTED (was: NT2001)", async () => {
    await matchesNode(
      `${F}function f(): F { return { a: 1 }; }\n` +
      "const r = f();\nconsole.log(r.a);\nconsole.log(r.b ?? -1);\n",
    );
  });

  test("the optional field is PRESENT", async () => {
    await matchesNode(
      `${F}function f(): F { return { a: 1, b: 2 }; }\n` +
      "const r = f();\nconsole.log(r.a);\nconsole.log(r.b ?? -1);\n",
    );
  });

  // Both spellings in ONE program: two `return`s of DIFFERENT literal shapes must land in
  // the same declared layout, or the caller reads one of them wrong.
  test("two returns, one with the optional field and one without", async () => {
    await matchesNode(
      `${F}function f(n: number): F { if (n > 0) { return { a: n, b: n * 2 }; } return { a: n }; }\n` +
      "const p = f(3);\nconsole.log(`${p.a}|${p.b ?? -1}`);\n" +
      "const q = f(-1);\nconsole.log(`${q.a}|${q.b ?? -1}`);\n",
    );
  });

  // Nesting falls out of `retypeLiteral` recursing into field types — the reason to reuse
  // the declaration path rather than special-case the top level of a `return`.
  test("an optional field NESTED inside an object field", async () => {
    await matchesNode(
      "interface Inner { x?: number }\ninterface Outer { in: Inner; tag?: string }\n" +
      "function f(): Outer { return { in: {} }; }\n" +
      "const o = f();\nconsole.log(`${o.in.x ?? -1}|${o.tag ?? \"t\"}`);\n",
    );
  });

  // An arrow with a BLOCK body routes its returns through the same statement check as a
  // `function`, so it gets the reshape from the same edit.
  test("an arrow with a block body returns the literal", async () => {
    await matchesNode(
      `${F}const f = (): F => { return { a: 7 }; };\n` +
      "const r = f();\nconsole.log(`${r.a}|${r.b ?? -1}`);\n",
    );
  });

  // A method's `return`, same path.
  test("a class method returns the literal", async () => {
    await matchesNode(
      `${F}class C { m(): F { return { a: 9 }; } }\n` +
      "const r = new C().m();\nconsole.log(`${r.a}|${r.b ?? -1}`);\n",
    );
  });

  // ARRAY of records, the `fitsArg` array arm's twin: the elements are the literals that
  // need rebuilding, and the declared element layout is the array's, not the literal's.
  test("an array literal of records with an omitted optional", async () => {
    await matchesNode(
      `${F}function f(): F[] { return [{ a: 1 }, { a: 2, b: 3 }]; }\n` +
      "const xs = f();\nconsole.log(xs.map((x) => `${x.a}|${x.b ?? -1}`).join(\",\"));\n",
    );
  });

  // The `bodyFrame` shape itself, reduced: two required fields and a trailing optional,
  // built with shorthand properties. (The real one takes `binds` as a PARAMETER and hands
  // it out, which is a separate, deliberate ownership refusal — NT1604, "cannot move out
  // of `binds`: it is borrowed". That is checker.ts's next blocker, not this one, so the
  // array is built locally here to keep this test about the type reshape.)
  test("the `bodyFrame` shape — two required fields, one omitted optional", async () => {
    await matchesNode(
      "interface BodyFrame { body: number; binds: string[]; closureAssigned?: string[] }\n" +
      "function bodyFrame(body: number): BodyFrame { const binds: string[] = [\"x\", \"y\"]; return { body, binds }; }\n" +
      "const fr = bodyFrame(4);\n" +
      "console.log(`${fr.body}|${fr.binds.join(\"/\")}|${(fr.closureAssigned ?? []).length}`);\n",
    );
  });
});

/*
 * The refusal that must SURVIVE. A `return` of a non-literal whose type is merely
 * structurally compatible has a layout already fixed by its own declaration, and there is
 * nothing to rewrite — accepting it is the exit-255 dereference, not the feature. This is
 * the same boundary `fitsArg` draws for arguments, and it is what keeps the widening from
 * becoming the miscompile.
 */
describe("a non-literal return of a merely structurally-compatible type is still refused", () => {
  test("a variable of the narrower shape cannot be returned as the wider one", () => {
    const src =
      "interface F { a: number; b?: number }\n" +
      "function f(): F { const v = { a: 1 }; return v; }\n" +
      "console.log(f().a);\n";
    let err: unknown;
    try { sourceToIR(src, "entry.ts"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NTError);
    expect((err as NTError).diag.code).toBe("NT2001");
    expect(runWithNode(src).stdout).toBe("1\n");
  });

  /*
   * ...and it says WHY, because this lane is what made the boundary surprising: the literal
   * form of the same value now compiles. A refusal whose neighbour is accepted and which
   * offers no way out is the worst kind.
   *
   * Both recommendations are COMPILED below rather than asserted as prose. A hint naming a
   * fix that does not work is a lie, and this tree has caught eleven of them.
   */
  test("the refusal names two fixes, and BOTH of them compile and match node", async () => {
    const src =
      "interface Opts { a: number; b?: number }\n" +
      "function f(): Opts { const v = { a: 1 }; return v; }\n" +
      "const o = f();\nconsole.log(o.a, o.b);\n";
    let err: unknown;
    try { sourceToIR(src, "entry.ts"); } catch (e) { err = e; }
    const hint = (err as NTError).diag.hint ?? "";
    expect(hint).toContain("write the literal in the `return` itself");
    expect(hint).toContain("ANNOTATE it with the declared return type");

    // fix 1 — write the literal in the `return`.
    await matchesNode(
      "interface Opts { a: number; b?: number }\n" +
      "function f(): Opts { return { a: 1 }; }\n" +
      "const o = f();\nconsole.log(o.a, o.b);\n",
    );
    // fix 2 — annotate the local, which reshapes it at its own declaration.
    await matchesNode(
      "interface Opts { a: number; b?: number }\n" +
      "function f(): Opts { const v: Opts = { a: 1 }; return v; }\n" +
      "const o = f();\nconsole.log(o.a, o.b);\n",
    );
  });

  // The hint is for the SURPRISING refusal only. A return type that is simply wrong needs
  // no advice, and a hint that fires on everything is read as noise.
  test("a genuinely wrong return type gets no hint", () => {
    const src = "function f(): string { return 1; }\nconsole.log(f());\n";
    let err: unknown;
    try { sourceToIR(src, "entry.ts"); } catch (e) { err = e; }
    expect((err as NTError).diag.code).toBe("NT2001");
    expect((err as NTError).diag.hint).toBeUndefined();
  });
});
