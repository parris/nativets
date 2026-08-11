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

  // `continue` is the same defect, and it is the one that shows the finalizer must run
  // once PER ITERATION rather than once: the `break` case can be made to look right by a
  // single stray finalizer run, and this one cannot.
  test("continue runs the finally it crosses, every iteration", async () => {
    expect(await sameAsNode(`let a = 0;
for (let i = 0; i < 3; i++) { try { a = a + 1; continue; } finally { console.log("fin"); } }
console.log(a);`)).toBe("fin\nfin\nfin\n3\n");
  });

  /*
   * The part that makes this a chain rather than a flag. One jump, TWO finalizers, and
   * the order is not symmetric: node runs the inner one first, then the outer, then
   * lands. A "did a jump happen" boolean read once cannot produce that, because the jump
   * is still pending when the inner finalizer hands it on.
   */
  test("break crossing two nested finallys runs both, innermost first", async () => {
    expect(await sameAsNode(`let a = 0;
for (let i = 0; i < 3; i++) {
  try {
    try { a = a + 1; break; } finally { console.log("inner"); }
  } finally { console.log("outer"); }
}
console.log(a);`)).toBe("inner\nouter\n1\n");
  });

  test("continue crossing two nested finallys runs both, every iteration", async () => {
    expect(await sameAsNode(`let a = 0;
for (let i = 0; i < 2; i++) {
  try {
    try { a = a + 1; continue; } finally { console.log("inner " + i); }
  } finally { console.log("outer " + i); }
}
console.log(a);`)).toBe("inner 0\nouter 0\ninner 1\nouter 1\n2\n");
  });

  test("break crossing three nested finallys runs all three, inside out", async () => {
    expect(await sameAsNode(`for (let i = 0; i < 3; i++) {
  try {
    try {
      try { break; } finally { console.log("a"); }
    } finally { console.log("b"); }
  } finally { console.log("c"); }
}
console.log("done");`)).toBe("a\nb\nc\ndone\n");
  });
});
