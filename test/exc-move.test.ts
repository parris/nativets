/*
 * THE PENDING EXCEPTION CARRIES AN OBJECT, BY MOVE.
 *
 * Cross-frame `throw` (test/cross-frame-throw.test.ts) rides the runtime's pending-
 * exception slot, and that slot was ONE `const char *`. So a raise could only cross a
 * frame carrying a `string`, or the single-field `{message:string}` that `new Error(m)`
 * is in this subset and `emitExcCheck` rebuilt by boxing the message. Anything richer —
 * and `src/` throws `NTError{message,name,diag:{…}}` at 145 sites — was NT1004.
 *
 * FLATTENING WAS MEASURED AND DEAD. A previous lane priced four payload rules against the
 * linked stage-1 tree: today's rule clears 7 of the 129 NT1004 seed functions, N flat
 * scalar fields clears 20, and a DEEP recursive flatten clears 20 as well — literally
 * zero more, because `NTError.diag` carries `spans?: DiagSpan[]`, an optional ARRAY that
 * no flattening carries. Moving the whole object by POINTER clears 82.
 *
 * THE OWNERSHIP STORY, which is the entire correctness argument:
 *
 *   raise   `nt_exc_raise_obj` TAKES the pointer. The raising frame must NOT drop it, so
 *           the thrown name is subtracted from `ThrowStmt.drops` (ownership.ts).
 *   catch   `nt_exc_take_object` returns it AND NULLS THE SLOT, so the catch binding
 *           becomes the one owner and the handler's existing drop set frees it.
 *   clear   `nt_exc_clear` frees only what nobody took — `catch { }` with no binding.
 *   abort   uncaught → `exit(1)`, nothing to free.
 *   re-raise a raise while one is already pending CLEARS first; that silently leaked.
 *
 * Exactly one owner and exactly one free, and NOTHING IS COPIED — so a nested `diag` is
 * never walked and sharing can never double-free. The `const char *` fast path stays:
 * the runtime itself raises strings (`JSON.parse`, `fs`) and cannot build a typed object.
 *
 * node is the oracle for stdout AND the exit code. The leak probes are SCALED — a
 * fixture whose frame exits proves nothing about a leak proportional to work.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, runWithNode, emitIR } from "./harness.ts";

async function differential(src: string): Promise<void> {
  const oracle = runWithNode(src);
  const ours = await compileAndRun(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
}

describe("a raise carries an object across a frame", () => {
  // THE self-hosting shape: `lex` raises a record with more than one field, `tokenize`
  // handles it. The try block also throws the same type itself, so the catch binding's
  // type is inferred today — the checker half is the next describe block.
  test("two fields — one more than the boxed-message shape could hold", async () => {
    await differential([
      `function lex(s: string): number {`,
      `  if (s === "bad") throw { message: "LexError: bad", code: 7 };`,
      `  return s.length;`,
      `}`,
      `function tokenize(s: string): number {`,
      `  try {`,
      `    if (s === "x") throw { message: "direct", code: 1 };`,
      `    return lex(s);`,
      `  } catch (e) {`,
      `    console.log("caught:", e.message, e.code);`,
      `    return -1;`,
      `  }`,
      `}`,
      `console.log(tokenize("ok"));`,
      `console.log(tokenize("bad"));`,
      `console.log(tokenize("x"));`,
      ``,
    ].join("\n"));
  });
});
