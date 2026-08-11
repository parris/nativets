/*
 * CROSS-FRAME `throw` — NT1004's second relaxation, and the self-hosting gate.
 *
 * A `throw` is lowered as a BRANCH to the enclosing `try`'s catch block, so it has always
 * had to sit inside a `try` IN THE SAME FUNCTION. The ordinary "raise in the callee,
 * handle at the call site" idiom — which `src/parser.ts::tokenize` (catches `lex`) and
 * `src/coverage.ts` (catches `parse`/`link`/`check`) both use for real — was refused.
 *
 * WHAT MAKES IT POSSIBLE WITHOUT AN UNWINDER. The pending-exception protocol already in
 * the runtime (`nt_exc_raise_msg` / `nt_exc_pending` / `nt_exc_message` / `nt_exc_clear`)
 * already carries a raise ACROSS a frame boundary — that is how a failing `JSON.parse`
 * or `readFileSync` reaches a `catch`. Nothing about it is specific to the runtime being
 * the raiser. So a `throw` that escapes its frame raises on the SAME flag and returns;
 * the caller checks the flag after the call, exactly as it already does after a fallible
 * host call.
 *
 * WHAT MAKES IT SOUND. Two things, and both are refusals rather than cleverness:
 *
 *   1. THE DROP SET. An escaping frame must free what it owns before it returns, or the
 *      unwind leaks — and this compiler has linear ownership with refcounted strings. The
 *      set to free is exactly the one a `return` at that point would free, which the
 *      ownership pass already computes (`ownedInScope`); `ThrowStmt.drops` is the same
 *      annotation `ReturnStmt.drops` already carries. Pinned by the leak probes below,
 *      SCALED — a leak proportional to work is invisible at n=3.
 *   2. ONE FRAME, PROVED. Propagation is allowed only when EVERY call site that can reach
 *      the escaping function is inside a `try`/`catch` in its caller, so no intermediate
 *      frame has to propagate. A deeper chain, or a callee reached indirectly (through a
 *      function value, where the call graph cannot be proved), keeps the NT1004 refusal.
 *      That is what makes "the caller checks the flag" a complete story rather than a
 *      hole through which a set flag escapes into a garbage default value.
 *
 * node is the oracle for stdout AND the exit code.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

async function differential(src: string): Promise<void> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("a throw crosses one frame into the caller's catch", () => {
  // THE self-hosting shape, reduced: `lex` raises, `tokenize` handles.
  test("callee throws a string, caller catches it", async () => {
    await differential([
      `function lex(s: string): number {`,
      `  if (s === "bad") throw "LexError: bad input";`,
      `  return s.length;`,
      `}`,
      `function tokenize(s: string): number {`,
      `  try {`,
      `    return lex(s);`,
      `  } catch (e) {`,
      `    console.log("caught:", e);`,
      `    return -1;`,
      `  }`,
      `}`,
      `console.log(tokenize("ok"));`,
      `console.log(tokenize("bad"));`,
      ``,
    ].join("\n"));
  });

  // The frame that raises must still be able to leave NORMALLY, many times over.
  test("the escaping function also returns normally", async () => {
    await differential([
      `function lex(n: number): number {`,
      `  if (n % 3 === 0) throw "bad";`,
      `  return n * 2;`,
      `}`,
      `function run(n: number): number {`,
      `  try { return lex(n); } catch (e) { return e.length; }`,
      `}`,
      `let acc = 0;`,
      `for (let i = 0; i < 20; i++) acc = acc + run(i);`,
      `console.log(acc);`,
      ``,
    ].join("\n"));
  });

  test("a void escaping function", async () => {
    await differential([
      `function emit(s: string): void {`,
      `  if (s === "") throw "empty";`,
      `  console.log("emit", s);`,
      `}`,
      `function safe(s: string): void {`,
      `  try { emit(s); } catch (e) { console.log("skip", e); }`,
      `}`,
      `safe("a");`,
      `safe("");`,
      `safe("b");`,
      ``,
    ].join("\n"));
  });

  // The call site is covered by a `try` that ALSO has a `finally`: node runs the
  // finalizer on the way out of the handler, and so must we.
  test("the covering try has a finally too", async () => {
    await differential([
      `function lex(s: string): number {`,
      `  if (s === "bad") throw "boom";`,
      `  return s.length;`,
      `}`,
      `function run(s: string): number {`,
      `  try { return lex(s); }`,
      `  catch (e) { console.log("caught", e); return -1; }`,
      `  finally { console.log("finally", s); }`,
      `}`,
      `console.log(run("ok"));`,
      `console.log(run("bad"));`,
      ``,
    ].join("\n"));
  });

  // Covered NOWHERE, but the only frame above it is `main` — which is node's uncaught
  // exception: everything already printed survives, and the exit code is 1. This shape
  // was refused before (the program has a `try`, so `uncatchable()` said no).
  test("uncovered call from main, in a program that HAS a try elsewhere", async () => {
    await differential([
      `function check(n: number): number {`,
      `  if (n < 0) throw "negative";`,
      `  return n;`,
      `}`,
      `function unrelated(): number {`,
      `  try { return 1; } catch (e) { return e.length; }`,
      `}`,
      `console.log(unrelated());`,
      `console.log(check(3));`,
      `console.log(check(-1));`,
      `console.log("never");`,
      ``,
    ].join("\n"));
  });
});

/*
 * THE REFUSALS THAT MAKE IT SOUND. Each of these is a way for a raise to reach a call
 * site that does not check the flag — which would carry on with a zeroed default, the
 * silent wrong answer this compiler exists to avoid. They stay NT1004.
 */
describe("propagation is refused wherever the call graph is not proved", () => {
  test("TWO frames: the middle one would have to propagate as well", () => {
    expect(() => emitIR([
      `function lex(s: string): number { if (s === "bad") throw "boom"; return s.length; }`,
      `function mid(s: string): number { return lex(s); }`,
      `function top(s: string): number { try { return mid(s); } catch (e) { return -1; } }`,
      `console.log(top("bad"));`,
      ``,
    ].join("\n"))).toThrow(/not inside a `try` in the same function/);
  });

  test("the throwing function is used as a VALUE, so a call can dodge the check", () => {
    expect(() => emitIR([
      `function lex(s: string): number { if (s === "bad") throw "boom"; return s.length; }`,
      `function top(s: string): number { try { return lex(s); } catch (e) { return -1; } }`,
      `const alias: (s: string) => number = lex;`,
      `console.log(top("ok"), alias("ok"));`,
      ``,
    ].join("\n"))).toThrow(/not inside a `try` in the same function/);
  });

  // THE HINT MUST NOT LIE. Its three recommendations, each applied to the two-frame
  // program above, each compiled and each matched node. This is the NEW one — "put every
  // call in a `try`/`catch`" — which is the whole rule the refusal is enforcing; the
  // other two ("wrap the throwing code", "return `T | undefined`") are pinned in the
  // uncaught-throw file's sibling cases and were re-run against node for this change.
  test("the hint's own fix compiles: every call site covered", async () => {
    await differential([
      `function lex(s: string): number { if (s === "bad") throw "boom"; return s.length; }`,
      `function mid(s: string): number { try { return lex(s); } catch (e) { return -1; } }`,
      `function top(s: string): number { return mid(s); }`,
      `console.log(top("ok"), top("bad"));`,
      ``,
    ].join("\n"));
  });

  test("a call site inside an ARROW body is not a frame this scan describes", () => {
    expect(() => emitIR([
      `function lex(s: string): number { if (s === "bad") throw "boom"; return s.length; }`,
      `function top(xs: string[]): number[] {`,
      `  try { return xs.map((x: string): number => lex(x)); } catch (e) { return [-1]; }`,
      `}`,
      `console.log(top(["a", "bad"]).length);`,
      ``,
    ].join("\n"))).toThrow(/not inside a `try` in the same function/);
  });
});
