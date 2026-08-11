/*
 * A HOF CALLBACK THAT RESIZES THE ARRAY IT IS WALKING.
 *
 * `.map`/`.filter`/`.forEach`/`.flatMap`/`.reduce` lower to an inlined loop whose bound is
 * the receiver's length read ONCE, before the first callback runs (`hofLen`). node
 * snapshots the length too, so the bound itself is right. What is NOT right is what
 * happens when the callback then SHRINKS the receiver: every index from the new length up
 * to the snapshot is now absent.
 *
 *   node        skips an absent index entirely — the callback is never invoked for it.
 *               `.filter`/`.forEach`/`.flatMap`/`.reduce` simply visit fewer elements;
 *               `.map` pre-sizes its result to the SNAPSHOT and leaves HOLES, which is why
 *               `[1,2,3,4].map(cb)` with a cb that pops twice gives `[1,2,null,null]`.
 *   nativets    ran the callback anyway, on whatever `nt_arr_get` returned for an index
 *               past the end — which was 0. `[1,2,0,0]`, exit 0. A silent wrong answer.
 *
 * WHY IT IS ALSO A HOLE IN STAGE 41. `a[5]` on a 3-element array panics (test/panic.test.ts);
 * the identical read from inside a HOF loop returned 0, because the loop read through
 * `nt_arr_get`, whose return-0-on-OOB contract was justified by a comment claiming only
 * "compiler-generated IN-BOUNDS loops" reach it. A snapshot bound is not in-bounds once the
 * callback resizes the receiver, so that assumption was false and Stage 41's "an
 * out-of-bounds index panics" guarantee had a hole exactly here.
 *
 * THE FIX IS A PANIC, NOT node's ANSWER, and the reason is that node's answer needs
 * ARRAY HOLES. `.map` must return something of the snapshot length whose absent slots
 * stringify as `null` and read as `undefined`; nativets arrays are dense `int64` slots
 * with no absent-ness to represent, and giving `.map` the type `T | undefined` would push
 * a union through every downstream consumer of every `.map` in the language. The panic is
 * the same trade Stage 41 already made for `a[i]` — loud and consistent beats a wrong
 * answer — and it costs nothing: `nt_arr_get` ALREADY evaluated `i >= a->len` on every
 * iteration, so this only changes what the taken branch does.
 *
 * GROWTH IS NOT A PANIC and must not become one: node visits only the original length, and
 * so does the snapshot bound. Those programs already agree with node and keep working.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildBinary } from "../src/driver.ts";
import { runWithNodeAttrs } from "./harness.ts";

/**
 * Compile + run, reporting the exit code AS A SHELL SEES IT. Copied from
 * test/panic.test.ts for the same reason it exists there: a signal death (abort) is
 * 128+signo, and `spawnSync` alone reports `status: null` for a signalled process, so the
 * panic's 134 is invisible through the ordinary harness (and `cli.ts run` remaps it to 255).
 */
async function run(source: string, file = "case.ts"): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "nativets-hofresize-"));
  try {
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const bin = join(dir, "prog");
    await buildBinary(source, bin, { target: "host", entryPath: entry });
    const proc = spawnSync("/bin/sh", ["-c", `"${bin}"; echo "__exit:$?"`], { encoding: "utf8" });
    const out = proc.stdout ?? "";
    const m = out.match(/__exit:(\d+)\n?$/);
    return {
      stdout: out.replace(/__exit:\d+\n?$/, ""),
      stderr: proc.stderr ?? "",
      exitCode: m ? Number(m[1]) : -1,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a callback that SHRINKS the receiver panics instead of reading 0", () => {
  test(".map — the shape that used to print [1,2,0,0]", async () => {
    const src = `//@@mutable
const a: number[] = [1, 2, 3, 4];
const out = a.map((x, i) => { if (i === 0) { a.pop(); a.pop(); } return x; });
console.log(JSON.stringify(out), a.length);
`;
    // node's answer, for the record: it does NOT panic, it leaves holes.
    const oracle = runWithNodeAttrs(src);
    expect(oracle.stdout).toBe("[1,2,null,null] 2\n");
    expect(oracle.exitCode).toBe(0);

    const r = await run(src);
    // The old wrong answer must not come back.
    expect(r.stdout).not.toContain("[1,2,0,0]");
    expect(r.stderr).toContain("resized the array it is walking");
    expect(r.exitCode).toBe(134);
  }, 60000);

  // The rest of the family. All five share ONE element read (`hofElem`), so these are
  // guarding that the choke point stays the choke point — a future lowering that grew its
  // own read would slip straight back through.
  const SHRINKERS: [string, string, string][] = [
    // [method, program, node's answer — measured, not assumed]
    [".filter", `const out = a.filter((x, i) => { if (i === 0) { a.pop(); a.pop(); } return true; });
console.log(JSON.stringify(out), a.length);`, "[1,2] 2\n"],
    [".forEach", `a.forEach((x, i) => { if (i === 0) { a.pop(); a.pop(); } console.log(x); });
console.log(a.length);`, "1\n2\n2\n"],
    [".flatMap", `const out = a.flatMap((x, i) => { if (i === 0) { a.pop(); a.pop(); } return [x]; });
console.log(JSON.stringify(out), a.length);`, "[1,2] 2\n"],
    [".reduce", `const s = a.reduce((acc, x, i) => { if (i === 0) { a.pop(); a.pop(); } return acc + x; }, 0);
console.log(s, a.length);`, "3 2\n"],
  ];
  for (const [method, body, expected] of SHRINKERS) {
    test(`${method} — the callback pops twice`, async () => {
      const src = `//@@mutable
const a: number[] = [1, 2, 3, 4];
${body}
`;
      const oracle = runWithNodeAttrs(src);
      expect(oracle.stdout).toBe(expected); // node visits [0,1] only, and never sees a hole
      expect(oracle.exitCode).toBe(0);

      const r = await run(src);
      expect(r.stderr).toContain(`\`${method}\` callback resized the array it is walking`);
      expect(r.exitCode).toBe(134);
    }, 60000);
  }
});

/*
 * GROWTH IS THE CONTROL, and it is the reason "re-read the length each iteration" was
 * rejected rather than adopted as the cheap fix. node reads `length` ONCE: a callback that
 * pushes is visited for the ORIGINAL count and no more. The snapshot bound already does
 * exactly that, so these programs agree with node today — and a per-iteration re-read
 * would have walked into the growth and broken every one of them.
 */
describe("a callback that GROWS the receiver keeps agreeing with node", () => {
  const GROWERS: [string, string][] = [
    [".map", `const out = a.map((x, i) => { if (i === 0) { a.push(99); a.push(98); } return x; });
console.log(JSON.stringify(out), a.length);`],
    [".filter", `const out = a.filter((x, i) => { if (i === 0) { a.push(99); } return true; });
console.log(JSON.stringify(out), a.length);`],
    [".forEach", `a.forEach((x, i) => { if (i === 0) { a.push(99); } console.log(x); });
console.log(a.length);`],
    [".flatMap", `const out = a.flatMap((x, i) => { if (i === 0) { a.push(99); } return [x]; });
console.log(JSON.stringify(out), a.length);`],
    [".reduce", `const s = a.reduce((acc, x, i) => { if (i === 0) { a.push(99); } return acc + x; }, 0);
console.log(s, a.length);`],
  ];
  for (const [method, body] of GROWERS) {
    test(`${method} — the callback pushes, and only the original elements are visited`, async () => {
      const src = `//@@mutable
const a: number[] = [1, 2, 3];
${body}
`;
      const oracle = runWithNodeAttrs(src);
      const r = await run(src);
      expect(r.stdout).toBe(oracle.stdout);
      expect(r.exitCode).toBe(oracle.exitCode);
      expect(r.exitCode).toBe(0); // NOT a panic: growth was never the bug
    }, 60000);
  }
});

/*
 * THE HINT'S ADVICE, COMPILED. The panic tells the programmer to do the removal AFTER the
 * walk. That advice is worthless if it does not itself agree with node, so it is spelled
 * out here as a program and run against the oracle — the same rule this project applies to
 * a refusal's hint.
 */
describe("the advice the panic gives", () => {
  test("collect inside the walk, `.pop()` after it — and node agrees", async () => {
    const src = `//@@mutable
const a: number[] = [1, 2, 3, 4];
//@@mutable
const out: number[] = [];
let drop = 0;
a.forEach((x, i) => { if (i === 0) { drop = 2; } out.push(x); });
for (let k = 0; k < drop; k++) { a.pop(); }
console.log(JSON.stringify(out), a.length);
`;
    const oracle = runWithNodeAttrs(src);
    expect(oracle.stdout).toBe("[1,2,3,4] 2\n");
    const r = await run(src);
    expect(r.stdout).toBe(oracle.stdout);
    expect(r.exitCode).toBe(oracle.exitCode);
    expect(r.exitCode).toBe(0);
  }, 60000);
});

/*
 * THE SEARCH HOFs — the same defect, in a DIFFERENT GENERATOR, found while fixing the
 * first one and not previously reported.
 *
 * `.some`/`.every`/`.find`/`.findIndex`/`.findLast`/`.findLastIndex` do not go through
 * `hofElem`: `genSearchHof` builds its own loop, takes its own `nt_arr_len` snapshot, and
 * had its own two `nt_arr_get` reads (a forward scan and a backward one for the `Last`
 * pair). So fixing `hofElem` alone left half the family miscompiling.
 *
 * It is the sharper half, because the phantom is a VALUE fed to a PREDICATE rather than a
 * value copied into an output array. `nt_arr_get` answered 0, so a predicate that tests
 * for 0 matches an element that does not exist and the BOOLEAN FLIPS:
 *
 *     [1,2,3,4].some((x, i) => { if (i === 0) { a.pop(); a.pop(); } return x === 0; })
 *     node: false      nativets (before): true      both exit 0
 *
 * MEASURING node here also split the family in two, which is worth writing down because
 * the two halves are not interchangeable and the ES spec is the reason:
 *
 *   `.some` / `.every`                                  guard each step with HasProperty,
 *                                                       so they SKIP an absent index —
 *                                                       visited [0,1] of a 4-snapshot.
 *   `.find` / `.findIndex` / `.findLast` / `.findLastIndex`
 *                                                       use a plain Get, so they visit
 *                                                       EVERY snapshot index and hand the
 *                                                       callback `undefined` for the ones
 *                                                       that are gone — visited [0,1,2,3]
 *                                                       (and [3,2,1,0] backwards).
 *
 * Neither half is reproducible: one needs "skip", the other needs `undefined`. So all six
 * panic, and the trigger index differs only because the `Last` pair counts DOWN — the
 * shrink has to happen on the FIRST element each direction visits to get past the end.
 */
describe("the search HOFs have the same snapshot bound", () => {
  // [method, the index the callback shrinks at, node's answer — all measured]
  const SEARCHES: [string, string, string][] = [
    [".some", `const r = a.some((x, i) => { if (i === 0) { a.pop(); a.pop(); } return x === 0; });`, "false 2\n"],
    [".every", `const r = a.every((x, i) => { if (i === 0) { a.pop(); a.pop(); } return x !== 0; });`, "true 2\n"],
    [".findIndex", `const r = a.findIndex((x, i) => { if (i === 0) { a.pop(); a.pop(); } return x === 0; });`, "-1 2\n"],
    [".findLastIndex", `const r = a.findLastIndex((x, i) => { if (i === 3) { a.pop(); a.pop(); } return x === 0; });`, "-1 2\n"],
  ];
  for (const [method, body, expected] of SEARCHES) {
    test(`${method} — the phantom element used to reach the predicate`, async () => {
      const src = `//@@mutable
const a: number[] = [1, 2, 3, 4];
${body}
console.log(r, a.length);
`;
      const oracle = runWithNodeAttrs(src);
      expect(oracle.stdout).toBe(expected);
      expect(oracle.exitCode).toBe(0);

      const r = await run(src);
      expect(r.stderr).toContain(`\`${method}\` callback resized the array it is walking`);
      expect(r.exitCode).toBe(134);
    }, 60000);
  }

  /*
   * A THIRD instance, and the only one where node can be MATCHED rather than refused.
   *
   * `.find`/`.findLast` return an ELEMENT, and `genSearchHof` produced it by re-reading
   * `src[hit]` AFTER the loop. If the matching callback shrinks the array on the very
   * iteration that matches, the loop's own read was in bounds (it happened first) but the
   * re-read is not — and `nt_arr_get` answered 0.
   *
   *     a.find((x, i) => { const m = i === 3; if (m) { a.pop(); a.pop(); } return m; })
   *     node: 4      nativets (before): 0      both exit 0
   *
   * node holds `kValue` from before the shrink, so the right answer is available and no
   * panic is warranted: keep the element the loop already read instead of re-reading it.
   * That is strictly better than the other two fixes — same answer as node, exit 0.
   */
  test(".find returns the element it saw, not a re-read after the shrink", async () => {
    const src = `//@@mutable
const a: number[] = [1, 2, 3, 4];
const r = a.find((x, i) => { const m = i === 3; if (m) { a.pop(); a.pop(); } return m; });
console.log(r, a.length);
`;
    const oracle = runWithNodeAttrs(src);
    expect(oracle.stdout).toBe("4 2\n");
    const r = await run(src);
    expect(r.stdout).toBe(oracle.stdout); // NOT a panic: node's answer is reachable here
    expect(r.exitCode).toBe(oracle.exitCode);
    expect(r.exitCode).toBe(0);
  }, 60000);

  test(".find that matches nothing still yields undefined, not a panic", async () => {
    const src = `const a: number[] = [1, 2, 3];
const r = a.find((x) => x > 99);
console.log(r);
`;
    const oracle = runWithNodeAttrs(src);
    expect(oracle.stdout).toBe("undefined\n");
    const r = await run(src);
    expect(r.stdout).toBe(oracle.stdout);
    expect(r.exitCode).toBe(0);
  }, 60000);

  test("a search callback that only READS the receiver is untouched", async () => {
    const src = `const a: number[] = [1, 2, 3, 4];
console.log(a.some((x) => x === a.length), a.findIndex((x) => x > 2), a.every((x) => x <= 4));
`;
    const oracle = runWithNodeAttrs(src);
    const r = await run(src);
    expect(r.stdout).toBe(oracle.stdout);
    expect(r.exitCode).toBe(oracle.exitCode);
    expect(r.exitCode).toBe(0);
  }, 60000);
});

/*
 * THE SHRINK ONE CALL DEEP — the shape that decides where the fix belongs.
 *
 * The obvious alternative was to refuse the program: the receiver is `@@mutable` and the
 * callback shrinks it, which is the hazard `NT1603` already reports for the `for-of` this
 * HOF desugars to (`for (const x of a) a.pop()` IS refused today). Worth stating precisely,
 * because the naive version of that argument is wrong in BOTH directions:
 *
 *   - `ownership.ts` is stronger than it looks. The `for-of` form is refused even when the
 *     shrink is one call deep — `checkMutableArgs` catches the hand-off at the CALL SITE
 *     ("cannot pass `a` to the `@@mutable` parameter of `drop` while it is borrowed").
 *     So a refusal for HOFs is viable and would cover the program below.
 *   - But the HOF form has no such rule today, so this program COMPILES, and until one
 *     exists the runtime check is the only thing between it and a wrong answer.
 *
 * The two are complements: a refusal fires on every program shaped like the hazard, the
 * runtime check stops only the ones that hit it. Since the Stage 41 guarantee is about run
 * time, this is where the hole had to be closed; `ownership.ts` belongs to other lanes.
 */
describe("the shrink happens inside a callee", () => {
  test("a `@@mutable` parameter popped by a helper still panics", async () => {
    const src = `function drop(
  //@@mutable
  xs: number[],
): void { xs.pop(); }
//@@mutable
const a: number[] = [1, 2, 3, 4];
const out = a.map((x, i) => { if (i === 0) { drop(a); drop(a); } return x; });
console.log(JSON.stringify(out), a.length);
`;
    const oracle = runWithNodeAttrs(src);
    expect(oracle.stdout).toBe("[1,2,null,null] 2\n");

    const r = await run(src);
    expect(r.stdout).not.toContain("[1,2,0,0]"); // the wrong answer this shape used to give
    expect(r.stderr).toContain("`.map` callback resized the array it is walking");
    expect(r.exitCode).toBe(134);
  }, 60000);
});
