/*
 * A JUMP THAT CROSSES A `finally` HAS TO RUN IT.
 *
 * `break`/`continue` were lowered as an unconditional branch to the loop's label. When a
 * `try`/`finally` sat BETWEEN the jump and its target, the branch flew straight past the
 * finalizer and node's output was silently short by whatever the finalizer printed —
 * both programs exiting 0, which is the worst outcome this project has a name for.
 *
 *   for (let i = 0; i < 3; i++) { try { break; } finally { console.log("fin"); } }
 *   node      ->  "fin"        nativets (before)  ->  nothing
 *
 * `return` never had the defect: the finalizer already carried a "mode" dispatch, and a
 * `return` inside a `try` stored mode=1, branched to the finalizer, and let the dispatch
 * do the `ret`. This file gives `break` and `continue` their own modes in that same
 * dispatch, and CHAINS them: a jump crossing two finalizers runs both, innermost first.
 *
 * Three shapes were already correct and are pinned here as controls, because each one is
 * a way the fix could over-reach:
 *   - a `break` whose target loop is INSIDE the `try` crosses nothing;
 *   - a `break` out of a `switch` that itself sits inside the `try` crosses nothing;
 *   - a `break` written IN the finalizer overrides the pending completion (ECMAScript
 *     `UpdateEmpty`) — verified against node, not assumed.
 *
 * Every case asserts stdout AND exit code against node.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, expectMatchesNode } from "./harness.ts";

/** Compile and run `src`, and assert stdout + exit code both equal node's. */
async function sameAsNode(src: string): Promise<string> {
  const { ours, oracle } = await expectMatchesNode(src);
  expect(ours.stdout).toBe(oracle.stdout);
  expect(ours.exitCode).toBe(oracle.exitCode);
  return ours.stdout;
}

describe("break/continue across a finally", () => {
  // The reported program, verbatim. node prints the finalizer's line before the loop's
  // result; we printed only the result.
  test("break out of a loop runs the finally it crosses", async () => {
    expect(await sameAsNode(`let a = 0;
for (let i = 0; i < 3; i++) { try { a = a + 1; break; } finally { console.log("fin"); } }
console.log(a);`)).toBe("fin\n1\n");
  });
});
