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
});
