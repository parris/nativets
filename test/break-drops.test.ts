/*
 * JUMPS OUT OF A BLOCK, and the drops they used to skip.
 *
 * `BlockDrops` is a synthesized marker statement, and it is LAST in the block's
 * statement list (`setBlockDrops`, test/block-drops.test.ts). `genStmts` stops at the
 * first terminated basic block, so a `break` or a `continue` branched to the loop label
 * and the marker was simply never reached — the block's linear locals were allocated and
 * never freed. `codegen.ts` said so in a comment, and called it "a leak, never a double
 * free", which is true and is still a leak.
 *
 * `return` was never affected: the ownership pass stamps `ReturnStmt.drops` with
 * `ownedInScope`, so a return carries its OWN drop list and codegen emits it before the
 * `ret`. `break`/`continue` had no such stamp. This file gives them the same property
 * from the codegen side: a scope stack that mirrors the markers, and a jump that unwinds
 * every scope between itself and its target.
 *
 * MEASURED AT TWO SCALES throughout. A single `break` out of a loop leaks exactly one
 * allocation, so at one scale it reads as a harmless constant — put that same loop
 * inside another loop and the same defect is linear. Only growth-with-work distinguishes
 * a leak from a fixed residue, and every test here therefore runs N and 10N.
 */

import { test, expect, describe } from "bun:test";
import { compileAndRun, expectMatchesNode } from "./harness.ts";

/** Compile `src(N)` at two scales and return the trailing `__arrLive()`/`__objLive()`
 *  of each. Residue that does not grow with work is not a leak; residue that grows is. */
async function liveAtTwoScales(
  src: (n: number) => string,
  probe: string = "__arrLive()",
): Promise<{ small: number; large: number; stdout: string }> {
  const runs: number[] = [];
  let firstOut = "";
  for (const n of [200, 2000]) {
    const r = await compileAndRun(`${src(n)}\nconsole.log(${probe});`);
    expect(r.exitCode).toBe(0); // a double free aborts, and would land here first
    const lines = r.stdout.trim().split("\n");
    if (n === 200) firstOut = lines.slice(0, -1).join("\n");
    runs.push(Number(lines[lines.length - 1]));
  }
  return { small: runs[0]!, large: runs[1]!, stdout: firstOut };
}

describe("drops on a jump out of a block", () => {
  /*
   * The reported shape, and the reason the severity is higher than "an edge case":
   * `break` is the MANDATORY terminator of a switch case in this language, so every case
   * that declares a heap local leaked it on every execution.
   *
   *   200 iterations -> __arrLive() 100      2000 iterations -> 1000
   *
   * The control is in the same file: the identical switch with the `break`s removed
   * (fall-through) was always clean, which is what isolated the defect to the jump
   * rather than to `switch`.
   */
  test("break out of a switch case frees the case's linear locals", async () => {
    const src = (n: number) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  switch (i % 2) {
    case 0: { const ws: number[] = [1, 2, 3]; acc = acc + ws.length; break; }
    default: { acc = acc + 1; break; }
  }
}
console.log(acc);`;
    const { small, large, stdout } = await liveAtTwoScales(src);
    expect(stdout).toBe("400");
    expect(small).toBe(0);
    expect(large).toBe(0); // it was 100 / 1000 — one array per case execution, unbounded

    const { ours, oracle } = await expectMatchesNode(src(200));
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
  });

  // A case body needs no braces to be a scope — the ownership pass calls `scoped()` on
  // `c.body` itself. Both spellings have to unwind, and the braced one has TWO nested
  // scopes to unwind (the case list, then the block).
  test("break out of a BRACELESS switch case frees them too", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  switch (i % 2) {
    case 0:
      const ws: number[] = [1, 2, 3];
      acc = acc + ws.length;
      break;
    default:
      acc = acc + 1;
      break;
  }
}
console.log(acc);`);
    expect(stdout).toBe("400");
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  // The control that isolated the defect to the jump. This one was always green, and it
  // is here so that a future change to `switch` lowering cannot quietly take it away.
  test("a switch case that FALLS THROUGH was, and stays, clean", async () => {
    const { small, large } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  switch (i % 2) {
    case 0: { const ws: number[] = [1, 2, 3]; acc = acc + ws.length; }
    default: { acc = acc + 1; }
  }
}
console.log(acc);`);
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  /*
   * `break` out of a LOOP has the identical defect, and this is the test shape that
   * proves it. Measured unnested it leaks exactly 1 — the loop breaks once — and reads
   * as a fixed residue at any scale. Nested inside an outer loop the same single leak
   * happens once per outer iteration: 200 -> 2000.
   */
  test("break out of a loop frees the loop body's linear locals", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  for (let j = 0; j < 4; j++) {
    const ws: number[] = [1, 2, 3];
    acc = acc + ws.length;
    if (j === 1) { break; }
  }
}
console.log(acc);`);
    expect(stdout).toBe("1200");
    expect(small).toBe(0);
    expect(large).toBe(0); // was 200 / 2000
  });

  /*
   * `continue` was NOT in the original report and shares the defect exactly — it leaves
   * the block too. It is worse than `break` in practice: a `break` runs once per loop,
   * a `continue` runs once per ITERATION, so it is linear without any nesting at all.
   */
  test("continue frees the loop body's linear locals", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  const ws: number[] = [1, 2, 3];
  acc = acc + ws.length;
  if (i % 2 === 0) { continue; }
  acc = acc + 1;
}
console.log(acc);`);
    expect(stdout).toBe("700");
    expect(small).toBe(0);
    expect(large).toBe(0); // was 100 / 1000
  });

  // Every loop form pushes its own `{brk, cont}` pair, so every loop form is a separate
  // chance to get the depth wrong. `while` and `for-of` are the two whose bodies are
  // reached differently from `for`'s.
  test("continue out of a while and a for-of frees them as well", async () => {
    const w = await liveAtTwoScales((n) => `let acc = 0;
let i = 0;
while (i < ${n}) {
  i = i + 1;
  const ws: number[] = [1, 2, 3];
  acc = acc + ws.length;
  if (i % 2 === 0) { continue; }
  acc = acc + 1;
}
console.log(acc);`);
    expect(w.stdout).toBe("700");
    expect(w.small).toBe(0);
    expect(w.large).toBe(0); // was 100 / 1000

    // The iterable is a FUNCTION-LOCAL const, not a module-level one, so that the
    // assertion can be a clean 0. A module-level `const xs = [...]` is promoted to an
    // LLVM global and never freed — measured at 1 with no loop and no jump anywhere in
    // the program — which is a separate, pre-existing, non-growing residue that would
    // otherwise sit on top of this number and obscure it.
    const f = await liveAtTwoScales((n) => `function g(): number {
  const xs: number[] = [0, 1, 2, 3];
  let acc = 0;
  for (let i = 0; i < ${n}; i++) {
    for (const x of xs) {
      const ws: number[] = [1, 2, 3];
      acc = acc + ws.length;
      if (x % 2 === 0) { continue; }
      acc = acc + 1;
    }
  }
  return acc;
}
console.log(g());`);
    expect(f.stdout).toBe("2800");
    expect(f.small).toBe(0);
    expect(f.large).toBe(0); // was 400 / 4000 above the module-global residue
  });

  /*
   * The case that makes `break` and `continue` need SEPARATE unwind depths.
   *
   * A `switch` pushes a loop entry so that `break` finds it — but its `cont` is
   * INHERITED from the enclosing loop (`outerCont`). So a `continue` inside a switch
   * inside a loop jumps clean past two scopes at once: the switch case's, and the loop
   * body's. Unwinding only to the switch would fix half of it and leave the other half
   * leaking, which is exactly the failure mode this lane was told to avoid.
   *
   * Two arrays per iteration, and the pre-fix numbers were 200 / 2000 — both of them.
   */
  test("continue out of a switch inside a loop unwinds BOTH scopes", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  const outer: number[] = [9];
  acc = acc + outer.length;
  switch (i % 2) {
    case 0: { const ws: number[] = [1, 2, 3]; acc = acc + ws.length; continue; }
    default: { acc = acc + 1; break; }
  }
}
console.log(acc);`);
    expect(stdout).toBe("600");
    expect(small).toBe(0);
    expect(large).toBe(0); // was 200 / 2000 — one `outer` AND one `ws` per iteration
  });

  // Depth arithmetic, not a special case: a jump unwinds EVERY scope between itself and
  // its target, however many there are. Two here, and both leaked before (400 / 4000).
  test("break unwinds every nested block between itself and the loop", async () => {
    const { small, large, stdout } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  for (let j = 0; j < 4; j++) {
    const outer: number[] = [9];
    acc = acc + outer.length;
    {
      const inner: number[] = [1, 2];
      acc = acc + inner.length;
      if (j === 1) { break; }
    }
  }
}
console.log(acc);`);
    expect(stdout).toBe("1200");
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  // Nothing here is array-specific: `emitDrops` picks `nt_obj_free` from the declared
  // type. An object local in a switch case leaked at exactly the same rate.
  test("objects leak the same way and are freed the same way", async () => {
    const { small, large } = await liveAtTwoScales((n) => `let acc = 0;
for (let i = 0; i < ${n}; i++) {
  switch (i % 2) {
    case 0: { const o: { a: number } = { a: 1 }; acc = acc + o.a; break; }
    default: { acc = acc + 1; break; }
  }
}
console.log(acc);`, "__objLive()");
    expect(small).toBe(0);
    expect(large).toBe(0);
  });

  /*
   * THE DOUBLE-FREE DIRECTION, which is the error this fix could plausibly introduce.
   *
   * A local moved out before the jump must NOT be freed by the jump. Nothing new
   * defends this: the drop flag IS the pointer. `droppable` puts a maybe-moved name in
   * `condDrops`, `nullOnMove` stores null into its slot at the move site, and
   * `nt_arr_free(NULL)` is a no-op — so the unconditional drop the jump emits is
   * already safe, for the same reason the fall-through drop is. A name moved on EVERY
   * path is not in the list at all.
   *
   * Exit code 0 is half the assertion: a double free aborts on a signal and takes the
   * buffered stdout with it.
   *
   * The move goes LAST in the body deliberately. A use of `ws` placed AFTER the
   * `if (…) { move; break; }` is refused NT1601 today, because a branch containing a
   * jump does not `escape` the join (`hasJump`) and so merges its moved state into the
   * fall-through — the conservative half of "`break` is not `return`". That refusal is
   * pre-existing and is a different lane's question; this test is about the drop.
   */
  test("a local moved out before the break is not freed by the break", async () => {
    // A rebind is the move (`const b: number[] = ws`), chosen over a constructor
    // parameter property because node's type stripping cannot run one — the oracle came
    // back with empty stdout, which is the harness telling the truth about node, not
    // about us. `b` is the if-arm block's own local and IS freed by the unwind; `ws` is
    // the loop body's, is moved on this path, and must NOT be.
    const src = `let acc = 0;
let last = 0;
for (let i = 0; i < 200; i++) {
  for (let j = 0; j < 4; j++) {
    const ws: number[] = [1, 2, 3];
    acc = acc + ws.length;
    if (j === 1) { const b: number[] = ws; last = b.length; break; }
  }
}
console.log(acc);
console.log(last);`;
    const { ours, oracle } = await expectMatchesNode(src);
    expect(ours.stdout).toBe(oracle.stdout);
    expect(ours.exitCode).toBe(oracle.exitCode);
    expect(ours.exitCode).toBe(0); // a double free aborts before it can print

    // ...and the value the move handed to `b` is freed exactly once, by `b`'s scope.
    const r = await compileAndRun(`${src}\nconsole.log(__arrLive());`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("1200\n3\n0\n");
  });

  // The same question for a name a nested block declares and the jump's own scope does
  // not: two scopes, one name each, one free each. If the two shared a frame slot the
  // unwind would free one pointer twice and this would abort.
  test("shadowed names in nested scopes are each freed exactly once", async () => {
    const r = await compileAndRun(`function f(): number {
  const a: number[] = [1];
  let t = a.length;
  for (let i = 0; i < 3; i++) {
    const a: number[] = [1, 2];
    t = t + a.length;
    if (i === 1) { break; }
  }
  return t;
}
console.log(f());
console.log(__arrLive());`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("5\n0\n");
  });

  // `return` already carried its own drops (`ReturnStmt.drops`) and must keep doing so
  // — the scope stack must not double up with it.
  test("return out of a loop body stays correct", async () => {
    const r = await compileAndRun(`function f(): number {
  let acc = 0;
  for (let i = 0; i < 200; i++) {
    const ws: number[] = [1, 2, 3];
    acc = acc + ws.length;
    if (i === 5) { return acc; }
  }
  return acc;
}
console.log(f());
console.log(__arrLive());`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("18\n0\n");
  });
});
