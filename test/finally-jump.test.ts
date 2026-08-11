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

describe("what the finalizer itself does to a pending completion", () => {
  /*
   * ECMAScript `UpdateEmpty`: if the finalizer completes abruptly, ITS completion is the
   * one that wins and the pending one is discarded. This was checked against node rather
   * than assumed — the `return 7` never happens, and the function falls out of the loop
   * to `return 9`.
   *
   * It falls out of the lowering for free: the finalizer's `break` TERMINATES the block,
   * so the mode dispatch that would have done the `return` is never emitted. Pinned here
   * because the fix could easily have broken it by emitting the dispatch unconditionally.
   */
  test("a break IN the finalizer overrides a pending return", async () => {
    expect(await sameAsNode(`function f(): number {
  for (let i = 0; i < 3; i++) {
    try { return 7; } finally { console.log("fin " + i); break; }
  }
  return 9;
}
console.log(f());`)).toBe("fin 0\n9\n");
  });

  // The same rule the other way round: a `return` in the finalizer beats a pending
  // `break`, and the loop's remaining iterations never happen.
  test("a return IN the finalizer overrides a pending break", async () => {
    expect(await sameAsNode(`function f(): number {
  for (let i = 0; i < 3; i++) {
    try { break; } finally { console.log("fin " + i); return 7; }
  }
  return 9;
}
console.log(f());`)).toBe("fin 0\n7\n");
  });

  // ...and a finalizer that jumps on only SOME paths still has to resume the pending
  // completion on the others, which is the half a "terminated?" test alone would lose.
  test("a CONDITIONAL break in the finalizer only overrides on that path", async () => {
    expect(await sameAsNode(`function f(): number {
  let seen = 0;
  for (let i = 0; i < 5; i++) {
    try { seen = seen + 1; continue; } finally { console.log("fin " + i); if (i === 2) { break; } }
  }
  return seen;
}
console.log(f());`)).toBe("fin 0\nfin 1\nfin 2\n3\n");
  });

  // A `break` written in an INNER finalizer still has to cross the OUTER one on its way
  // out — the override discards the pending return, and then becomes a pending jump of
  // its own with a finalizer left to run.
  test("a break in an inner finalizer still runs the outer finalizer", async () => {
    expect(await sameAsNode(`function f(): number {
  for (let i = 0; i < 3; i++) {
    try {
      try { return 7; } finally { console.log("inner"); break; }
    } finally { console.log("outer"); }
  }
  return 9;
}
console.log(f());`)).toBe("inner\nouter\n9\n");
  });
});

describe("switch, and the jumps that cross nothing", () => {
  /*
   * CONTROL. A `break` out of a `switch` that itself sits inside the `try` leaves the
   * switch and stays inside the `try` — it crosses no finalizer, and the finalizer then
   * runs once, on the ordinary fall-through out of the block. This was already correct
   * and is the shape the fix could most easily have double-run.
   */
  test("break out of a switch INSIDE the try crosses nothing", async () => {
    expect(await sameAsNode(`let n = 0;
for (let i = 0; i < 3; i++) {
  try {
    switch (i) { case 1: n = n + 10; break; default: n = n + 1; }
    n = n + 100;
  } finally { console.log("fin " + i); }
}
console.log(n);`)).toBe("fin 0\nfin 1\nfin 2\n312\n");
  });

  // The mirror image, and it WAS wrong: the `break` targets the switch, which is outside
  // the `try`, so the finalizer is crossed. `switch` is a `break` target but not a
  // `continue` target, so this is the one place the two finalizer depths differ.
  test("break out of a try/finally that sits inside a switch case runs the finally", async () => {
    expect(await sameAsNode(`let n = 0;
for (let i = 0; i < 3; i++) {
  switch (i) {
    case 1:
      try { n = n + 10; break; } finally { console.log("fin " + i); }
    default:
      n = n + 1;
  }
  n = n + 100;
}
console.log(n);`)).toBe("fin 1\n312\n");
  });

  // A `continue` at the same spot is NOT stopped by the switch: it leaves the case, the
  // switch and the try, so it crosses the finalizer and lands on the loop's update.
  test("continue out of a try inside a switch inside a loop runs the finally", async () => {
    expect(await sameAsNode(`let n = 0;
for (let i = 0; i < 3; i++) {
  switch (i) {
    case 1:
      try { n = n + 10; continue; } finally { console.log("fin " + i); }
    default:
      n = n + 1;
  }
  n = n + 100;
}
console.log(n);`)).toBe("fin 1\n212\n");
  });

  /*
   * CONTROL. The loop is INSIDE the `try`, so the `break` never leaves it and the
   * finalizer runs exactly once, after the loop. If the fix keyed off "is any finalizer
   * live" rather than "is any finalizer live ABOVE the target", this program would print
   * the finalizer's line on every iteration.
   */
  test("break whose target loop is inside the try crosses nothing", async () => {
    expect(await sameAsNode(`try {
  for (let i = 0; i < 3; i++) { if (i === 1) { break; } console.log("i " + i); }
} finally { console.log("fin"); }
console.log("done");`)).toBe("i 0\nfin\ndone\n");
  });
});
