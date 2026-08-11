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
});
