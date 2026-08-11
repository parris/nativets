/*
 * `**=` — the exponentiation compound assignment (ES2016).
 *
 * The lexer has tokenized `**=` since it was written (`PUNCT_3`, src/lexer.ts), but no
 * parser path consumed it, so `a **= 2` came out as `error[NT0001]: Expected ';' but found
 * '**='` — a clean refusal, and node prints `9`.
 *
 * THE TRAP THIS FILE EXISTS TO CLOSE. `**` is NOT in `ARITH` (it is not an LLVM binary
 * instruction — it is `Number::exponentiate`, lowered to `js_pow`, because C `pow` gets a
 * unit base with a non-finite exponent wrong: `(-1) ** Infinity` is `NaN` in node and `1`
 * in C). Every compound-assign site read `ARITH.has(bare)` and fell to
 * `BITFN.get(bare)!` otherwise. For `**=` that is `BITFN.get("**")` — `undefined` — so
 * wiring the PARSE without the lowering would have emitted `call double @undefined(...)`,
 * i.e. turned a clean refusal into a broken build. So parse and lowering land together,
 * and the lowering lives in ONE place (`compoundArith`) rather than being written out
 * three times.
 *
 * Every case is differential against node, the specification.
 */

import { describe, expect, test } from "bun:test";
import { compileAndRun, runWithNode } from "./harness.ts";
import { readFileSync } from "node:fs";

/** Compile+run ours and assert stdout AND exit code match `node` on the same source. */
async function matchesNode(src: string): Promise<string> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("`**=` is `x = x ** v`", () => {
  test("a local binding", async () => {
    expect(await matchesNode([
      "let a = 3;",
      "a **= 2;",
      "console.log(a);",
      "let b = 2;",
      "b **= 3 - 1;",   // the RHS is a full expression, not just a literal
      "console.log(b);",
      "let c = 2;",
      "c **= 3;",
      "c **= 2;",       // applied twice: (2**3)**2 = 64, NOT 2**(3*2)... which is also 64,
      "console.log(c);",// so the next case is the one that distinguishes them
      "let d = 3;",
      "d **= 2;",
      "d **= 3;",       // (3**2)**3 = 729
      "console.log(d);",
      "",
    ].join("\n"))).toBe("9\n4\n64\n729\n");
  });

  /*
   * THE ES SEMANTICS, not C's. `js_pow` exists because C `pow` answers `1` for a unit base
   * with an infinite exponent where ES 6.1.6.1.3 says `NaN`. `**=` must reach the SAME
   * routine `**` does — if it were lowered as any LLVM arithmetic instruction these lines
   * would diverge, and silently.
   */
  test("Number::exponentiate, not C pow", async () => {
    expect(await matchesNode([
      "let a = -1;",
      "a **= Infinity;",
      "console.log(a);",            // NaN — C pow says 1
      "let b = 1;",
      "b **= Infinity;",
      "console.log(b);",            // NaN — C pow says 1
      "let c = NaN;",
      "c **= 0;",
      "console.log(c);",            // 1 — the one case where a NaN base is not NaN
      "let d = -8;",
      "d **= 1 / 3;",
      "console.log(d);",            // NaN — negative base, fractional exponent
      "let e = 0;",
      "e **= -1;",
      "console.log(e);",            // Infinity
      "",
    ].join("\n"))).toBe("NaN\nNaN\n1\nNaN\nInfinity\n");
  });

  // `**=` must agree with the two-step spelling on every one of those, exactly.
  test("it agrees with `x = x ** v` term for term", async () => {
    expect(await matchesNode([
      "const bases = [2, -1, 1, 0, -8, 0.5];",
      "const exps = [3, Infinity, Infinity, -1, 2, -2];",
      "for (let i = 0; i < bases.length; i++) {",
      "  let lhs = bases[i]!;",
      "  lhs **= exps[i]!;",
      "  const rhs = bases[i]! ** exps[i]!;",
      "  console.log(lhs, rhs, Object.is(lhs, rhs));",
      "}",
      "",
    ].join("\n"))).toBe([
      "8 8 true",
      "NaN NaN true",
      "NaN NaN true",
      "Infinity Infinity true",
      "64 64 true",
      "4 4 true",
      "",
    ].join("\n"));
  });

  // It mixes with the compound assignments that already worked; none of them may shift.
  test("it mixes with the other compound assignments", async () => {
    expect(await matchesNode([
      "let f = 2;",
      "f *= 3;",   // 6
      "f **= 2;",  // 36
      "f -= 6;",   // 30
      "f /= 2;",   // 15
      "f %= 7;",   // 1
      "f += 4;",   // 5
      "console.log(f);",
      "let g = 3;",
      "g <<= 2;",  // 12  — the BITFN family, the `else` arm `**=` used to fall into
      "g **= 2;",  // 144
      "g >>= 3;",  // 18
      "g |= 1;",   // 19
      "console.log(g);",
      "",
    ].join("\n"))).toBe("5\n19\n");
  });

  // A CAPTURED binding takes a different lowering path (readCapture/writeCapture) with its
  // own copy of the ARITH/BITFN choice — the second of the three sites. The counter's state
  // has to live ONLY in the closure: a captured binding that is also read outside it is
  // refused (NT1013, closures capture by value here), which is a separate, deliberate rule
  // and not this one's business.
  test("a binding captured by a closure", async () => {
    expect(await matchesNode([
      "let n = 2;",
      "const bump = (): void => { n **= 3; console.log(n); };",
      "bump();",
      "bump();",
      "",
    ].join("\n"))).toBe("8\n512\n");
  });

  // A `@@mutable` record field: the parser DESUGARS `o.f **= v` into `o.f = o.f ** v`, so
  // this goes through the ordinary BinaryExpr `**`. Pinned so the desugar cannot regress
  // into the compound path without a test noticing.
  test("a mutable record field", async () => {
    expect(await matchesNode([
      "//@@mutable",
      "type Box = { v: number };",
      "const box: Box = { v: 3 };",
      "box.v **= 2;",
      "console.log(box.v);",
      "box.v **= 0.5;",
      "console.log(box.v);",
      "",
    ].join("\n"))).toBe("9\n3\n");
  });

  // A `Uint8Array` element — the third site, which reads through `nt_bytes_index` and
  // writes back through `nt_bytes_index_set`. Note the store TRUNCATES to a byte, exactly
  // as node does, so `3 **= 5` (243) fits and `4 **= 5` (1024) wraps to 0.
  test("a Uint8Array element", async () => {
    expect(await matchesNode([
      "const u = new Uint8Array(3);",
      "u[0] = 3;",
      "u[0] **= 5;",
      "console.log(u[0]);",
      "u[1] = 4;",
      "u[1] **= 5;",
      "console.log(u[1]);",
      "u[2] = 2;",
      "u[2] **= 3;",
      "console.log(u[2]);",
      "",
    ].join("\n"))).toBe("243\n0\n8\n");
  });

  // It is an EXPRESSION: its value is the new value, and it is right-associative through
  // a chain, like every other assignment.
  test("the value of the assignment is the new value", async () => {
    expect(await matchesNode([
      "let a = 2;",
      "console.log(a **= 3);",
      "console.log(a);",
      "let b = 2;",
      "let c = 3;",
      "b **= c **= 2;",  // c becomes 9, then b becomes 2 ** 9
      "console.log(b, c);",
      "",
    ].join("\n"))).toBe("8\n8\n512 9\n");
  });

  /*
   * MUTATION GUARD, and the reason it is a source assertion rather than a program.
   *
   * The bug this file closes is that the ARITH/BITFN choice was written out THREE times,
   * so a fourth operator has to be remembered three times. It is one function now; assert
   * that, or a later edit re-inlines it and the next operator repeats this exactly. Read
   * with `readFileSync`, never a shell `grep` (project memory: the shimmed grep silently
   * drops matching lines, which would make this vacuous).
   */
  test("the compound-assign lowering exists once, and knows `**`", () => {
    const src = readFileSync(new URL("../src/codegen.ts", import.meta.url), "utf8");
    // Exactly one definition, and it names js_pow.
    const defs = src.split("\n").filter((l) => l.includes("private compoundArith("));
    expect(defs.length).toBe(1);
    const at = src.indexOf("private compoundArith(");
    const body = src.slice(at, src.indexOf("\n  }", at));
    expect(body.includes("js_pow")).toBe(true);
    // Every compound-assign site DELEGATES to it — three of them, and no site re-inlines
    // the old two-way `ARITH.has(bare) ? … : BITFN.get(bare)!` choice that missed `**`.
    const calls = src.split("\n").filter((l) => l.includes("this.compoundArith(")).length;
    expect(calls).toBe(3);
    // CODE lines only — the helper's own comment quotes the old shape, deliberately.
    const code = src.split("\n").filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(code.filter((l) => l.includes("ARITH.has(")).length).toBe(1); // inside compoundArith
    expect(code.filter((l) => l.includes("BITFN.get(")).length).toBe(2); // compoundArith + the plain binary arm
  });
});
