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

/** Compile `src(N)` at two scales and return the trailing `__arrLive()` of each, plus
 *  the output above it at the small scale. Same instrument as test/break-drops.test.ts,
 *  and for the same reason: a fixed residue is not a leak, growth with work is. */
async function liveAtTwoScales(src: (n: number) => string): Promise<{ small: number; large: number; stdout: string }> {
  const runs: number[] = [];
  let firstOut = "";
  for (const n of [200, 2000]) {
    const r = await compileAndRun(`${src(n)}\nconsole.log(__arrLive());`);
    expect(r.exitCode).toBe(0); // a double free aborts, and would land here first
    const lines = r.stdout.trim().split("\n");
    if (n === 200) firstOut = lines.slice(0, -1).join("\n");
    runs.push(Number(lines[lines.length - 1]));
  }
  return { small: runs[0]!, large: runs[1]!, stdout: firstOut };
}

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

/*
 * The two fixes have to COMPOSE. The lane before this one gave `break`/`continue` their
 * block-scope unwinding — a jump frees the linear locals of every scope between itself
 * and its target. Routing the jump through a finalizer could have bypassed that entirely
 * (drops emitted into a block the jump no longer reaches), and getting BOTH to happen in
 * the wrong ORDER is the other failure: a local declared inside the `try` is still live
 * while that `try`'s finalizer runs, so its drop belongs before the finalizer, and a
 * local declared outside belongs after.
 *
 * The lowering therefore INTERLEAVES: unwind down to the finalizer, run it, unwind the
 * next segment, run the next finalizer, land. These measure the result, at two scales,
 * because a single leaked array reads as a harmless constant at one.
 */
describe("drops still happen, and in the right order", () => {
  test("a jump through a finally frees the try block's locals", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  try { const ws: number[] = [1, 2, 3]; acc = acc + ws.length; continue; } finally { acc = acc + 1; }
}
console.log(acc);`);
    expect(stdout).toBe("800");
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  test("a jump through TWO finallys frees every scope it unwinds", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  const outerLocal: number[] = [1];
  try {
    const midLocal: number[] = [1, 2];
    try {
      const innerLocal: number[] = [1, 2, 3];
      acc = acc + innerLocal.length + midLocal.length + outerLocal.length;
      continue;
    } finally { acc = acc + 1; }
  } finally { acc = acc + 1; }
}
console.log(acc);`);
    expect(stdout).toBe("1600");
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  // ORDER, observably: the finalizer READS a local declared in the `try` after the jump
  // has already begun. If the drop were hoisted in front of the branch to the finalizer,
  // this would be a use-after-free rather than a leak — the louder half of the same bug.
  test("the try block's locals are still live inside its own finalizer", async () => {
    expect(await sameAsNode(`for (let i = 0; i < 2; i++) {
  const ws: number[] = [1, 2, 3];
  try {
    const xs: number[] = [4, 5];
    if (i === 1) { break; }
    console.log("body " + xs.length);
  } finally {
    console.log("fin " + ws.length);
  }
}
console.log("done");`)).toBe("body 2\nfin 3\nfin 3\ndone\n");
  });
});

/*
 * ONE finalizer, SEVERAL pending completions. The mode slot is a single `double`, so
 * every exit that can reach a given finalizer needs its own id in that finalizer's
 * dispatch — a design that stored "a jump is pending" as one bit would compile the first
 * of these and silently mis-route the second.
 */
describe("several completions through one finalizer", () => {
  test("break, continue, return and fall-through all through the same finally", async () => {
    expect(await sameAsNode(`function f(): number {
  let acc = 0;
  for (let i = 0; i < 5; i++) {
    try {
      if (i === 1) { continue; }
      if (i === 2) { return acc + 100; }
      if (i === 3) { break; }
      acc = acc + 1;
    } finally { console.log("fin " + i); }
  }
  return acc;
}
console.log(f());`)).toBe("fin 0\nfin 1\nfin 2\n101\n");
  });

  // The `catch` clause is also a path into the finalizer, and a jump written INSIDE it
  // crosses the finalizer exactly as one in the `try` block does.
  test("a break inside the catch clause still runs the finally", async () => {
    expect(await sameAsNode(`for (let i = 0; i < 3; i++) {
  try {
    throw "boom";
  } catch (e) {
    console.log("caught " + e);
    break;
  } finally {
    console.log("fin " + i);
  }
}
console.log("done");`)).toBe("caught boom\nfin 0\ndone\n");
  });
});

/*
 * ============================================================================
 * THE PRE-EXISTING BUG THIS LANE FOUND — `return` ACROSS TWO FINALIZERS
 * ============================================================================
 *
 * `return` was believed correct because it already went through the mode dispatch, and
 * with ONE finalizer it is. With two it was the same silent wrong answer `break` had:
 *
 *   function f() { try { try { return 7; } finally { log("inner"); } } finally { log("outer"); } }
 *   node -> "inner" "outer" 7        nativets (before) -> "inner" 7
 *
 * The inner finalizer's dispatch did the `ret` ITSELF, from a basic block sitting inside
 * the outer `try` — so the outer finalizer was jumped clean over, and the program exited
 * 0 with output short by one line. It is the identical defect one stack over, and it is
 * why the mode-1 arm now forwards to the next live finalizer instead of returning, in
 * the same shape `break` and `continue` forward.
 */
describe("return across nested finallys", () => {
  test("a return crossing two finallys runs both, innermost first", async () => {
    expect(await sameAsNode(`function f(): number {
  try {
    try { return 7; } finally { console.log("inner"); }
  } finally { console.log("outer"); }
}
console.log(f());`)).toBe("inner\nouter\n7\n");
  });

  test("a return crossing three finallys runs all three", async () => {
    expect(await sameAsNode(`function f(): string {
  try {
    try {
      try { return "v"; } finally { console.log("a"); }
    } finally { console.log("b"); }
  } finally { console.log("c"); }
}
console.log(f());`)).toBe("a\nb\nc\nv\n");
  });

  // A `void` function has no return slot at all, so the forwarding must not assume one.
  test("a void return crossing two finallys runs both", async () => {
    expect(await sameAsNode(`function f(): void {
  try {
    try { console.log("body"); return; } finally { console.log("inner"); }
  } finally { console.log("outer"); }
}
f();
console.log("done");`)).toBe("body\ninner\nouter\ndone\n");
  });

  // The forwarded value has to survive the hand-off: the outer finalizer runs BETWEEN
  // the inner dispatch and the `ret`, and it writes to the same locals.
  test("the returned value survives the outer finalizer", async () => {
    expect(await sameAsNode(`function f(): number {
  let v = 1;
  try {
    try { v = 7; return v; } finally { v = 8; console.log("inner " + v); }
  } finally { v = 9; console.log("outer " + v); }
}
console.log(f());`)).toBe("inner 8\nouter 9\n7\n");
  });

  // And the two mechanisms have to share a finalizer: a `return` and a `break` both
  // crossing the same pair, each resumed under its own dispatch id.
  test("a return and a break cross the same two finallys", async () => {
    expect(await sameAsNode(`function f(): number {
  for (let i = 0; i < 4; i++) {
    try {
      try {
        if (i === 1) { return 7; }
        if (i === 0) { continue; }
      } finally { console.log("inner " + i); }
    } finally { console.log("outer " + i); }
  }
  return 9;
}
console.log(f());`)).toBe("inner 0\nouter 0\ninner 1\nouter 1\n7\n");
  });
});

/* Every loop form pushes its own `break`/`continue` target, so every loop form is its own
 * chance to have forgotten the finalizer depth on the entry. */
describe("every loop form", () => {
  test("while", async () => {
    expect(await sameAsNode(`let i = 0;
while (i < 3) { i = i + 1; try { continue; } finally { console.log("fin " + i); } }
console.log(i);`)).toBe("fin 1\nfin 2\nfin 3\n3\n");
  });

  test("do/while", async () => {
    expect(await sameAsNode(`let i = 0;
do { i = i + 1; try { continue; } finally { console.log("fin " + i); } } while (i < 3);
console.log(i);`)).toBe("fin 1\nfin 2\nfin 3\n3\n");
  });

  test("for-of", async () => {
    expect(await sameAsNode(`const xs: number[] = [1, 2, 3];
let acc = 0;
for (const x of xs) { try { acc = acc + x; continue; } finally { console.log("fin " + x); } }
console.log(acc);`)).toBe("fin 1\nfin 2\nfin 3\n6\n");
  });

  test("for-in", async () => {
    expect(await sameAsNode(`const o = { a: 1, b: 2 };
for (const k in o) { try { break; } finally { console.log("fin " + k); } }
console.log("done");`)).toBe("fin a\ndone\n");
  });
});
