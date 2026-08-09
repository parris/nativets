/*
 * Drops for locals declared INSIDE an inlined HOF callback.
 *
 * `.map`/`.filter`/`.reduce`/… are inlined: the arrow body's statements are emitted
 * straight into the enclosing function, once per element. The ownership pass walked
 * that body with `seq()` in the ENCLOSING scope, so a linear local the body declared
 * never entered `linear` and `scoped()` computed an empty drop set for every nested
 * block inside it — the array was allocated per iteration and never freed. The same
 * shape in a plain function frees correctly, which is what makes it a defect and not
 * a documented boundary.
 *
 * Observed through `__arrLive()` (arrays allocated − freed), NOT stdout: stdout is
 * correct throughout this bug, so it proves nothing either way. macOS cannot see the
 * leak at all; Linux LeakSanitizer can.
 *
 * `__arrLive()` ALONE was a measurement hole, and it hid a bigger leak than the one this
 * file was written for: every arrow BOUND to a value allocates a closure env, which is an
 * OBJECT (`nt_obj_new`), and none of them were ever freed. Zero arrays, so nothing here
 * moved. Every counter assertion below now reads BOTH — see
 * `test/closure-env-drops.test.ts` for the envs themselves.
 *
 * The mirror-image hazard is worse than the leak, so the CONTROLS come first and are
 * the load-bearing part of this file: a value the callback RETURNS escapes into the
 * result array and must not be freed, a value the callback CAPTURES belongs to the
 * enclosing scope, and an ALIAS inside the body (`const b = a.reverse()` hands back
 * its receiver) names an allocation that already has an owner. Freeing any of those
 * is a use-after-free or a double free.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { compileAndRun, emitIR } from "./harness.ts";
import { ownershipCheck } from "../src/driver.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The NT codes the ownership pass refuses a program with (`[]` if it compiles). */
function ownCodes(source: string): string[] {
  return ownershipCheck(source).map((d) => d.code);
}

/** The three inlined HOFs that take a BLOCK body, each with a nested-block local, all
 *  inside a function so a correct program ends with nothing live. node prints 16. */
const HOF_CHURN = `
function run(): number {
  const src: number[] = [1, 2, 3, 4];
  const mapped: number[] = src.map((x) => { let n = 0; if (x > 1) { const a: number[] = [x, x, x]; n = a[0] + a.length; } return n; });
  const kept: number[] = src.filter((x) => { let k = false; if (x > 2) { const b: number[] = [x, x]; k = b.length > 1; } return k; });
  const sum: number = src.reduce((acc: number, x: number) => { let s = acc; if (x > 0) { const c: number[] = [x]; s = acc + c[0]; } return s; }, 0);
  return mapped.length + kept.length + sum;
}
console.log(run());
console.log(__arrLive());
console.log(__objLive());`;

describe("HOF callback drops", () => {
  // CONTROL. The baseline shape: an expression-bodied callback declares nothing, so
  // the only array alive at exit is `map`'s own result.
  test("control: an expression-bodied callback leaves only the result array", async () => {
    const r = await compileAndRun(`
const r = [1, 2, 3].map((x) => x + 1);
console.log(r.join(","));
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("2,3,4\n1\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // CONTROL, and the reason this is a bug at all: the IDENTICAL body in a plain
  // function frees its nested-block local every call.
  test("control: the same nested-block shape in a plain function frees everything", async () => {
    const r = await compileAndRun(`
function f(x: number): number { let n = 0; if (x > 1) { const a: number[] = [x, x]; n = a[0]; } return n; }
console.log(f(1) + "," + f(2) + "," + f(3));
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("0,2,3\n0\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // CONTROL — the use-after-free hazard. The callback's array ESCAPES into the result
  // array, which owns it. Freeing it at the callback's exit would leave `map`'s output
  // holding three dangling pointers. 4 = the result array + the three it holds.
  test("control: an array the callback RETURNS escapes and is not freed", async () => {
    const r = await compileAndRun(`
const r = [1, 2, 3].map((x) => { const a: number[] = [x, x]; return a; });
console.log(r.length + "," + r[0][0] + "," + r[2][1]);
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("3,1,3\n4\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // CONTROL — the same hazard on a CONDITIONAL path, and the boundary of the fix.
  // `a` escapes into the result for x>1 and dies for x=1. A name that is moved on
  // only some paths is normally still dropped, with the move nulling its slot as the
  // drop flag (`condDrops`/`nullOnMove`) — but `droppable` refuses that for a name a
  // closure body mentions, because the env holds a second pointer it cannot null, and
  // every name in an arrow body is such a name by construction. So this one stays a
  // LEAK on the dying path: 5 = the result array + the three it holds + the x=1 `a`.
  //
  // Deliberately conservative, and pinned here so it stays that way: the alternative
  // is freeing a pointer `r` still holds. Freeing `a` unconditionally would read 2
  // here and hand `r` three dangling elements.
  test("control: an array returned on only ONE path is never freed (conservative, not dropped)", async () => {
    const r = await compileAndRun(`
const r = [1, 2, 3].map((x) => { const a: number[] = [x, x]; if (x > 1) { return a; } return [0]; });
console.log(r.length + "," + r[0][0] + "," + r[1][0] + "," + r[2][1]);
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("3,0,2,3\n5\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // CONTROL — the enclosing scope owns what the callback only READS. `base` is not
  // declared by the body, so it is not the body's to free; it dies at module exit.
  test("control: an array CAPTURED from the enclosing scope is not freed by the callback", async () => {
    const r = await compileAndRun(`
const base: number[] = [10, 20];
const r = [1, 2].map((x) => { const n = base[0] + x; return n; });
console.log(r.join(",") + "," + base[1]);
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("11,12,20\n2\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // THE BUG. Compare with the plain-function control above: same body, same array, and
  // node prints "0,2,3" either way — only `__arrLive()` can see the difference. Was 3
  // (the result array, plus one leaked `a` per iteration that entered the branch).
  test("a linear local in a NESTED BLOCK inside a callback is freed per iteration", async () => {
    const r = await compileAndRun(`
const r = [1, 2, 3].map((x) => { let n = 0; if (x > 1) { const a: number[] = [x, x]; n = a[0]; } return n; });
console.log(r.join(","));
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("0,2,3\n1\n0\n");
    expect(r.exitCode).toBe(0);
  });

  // The same fix across the other inlined HOFs, and the shape the sanitizer gate below
  // runs: everything is scoped inside a function, so a correct program ends at ZERO
  // live arrays. Was 9 — three from `map`, two from `filter`, four from `reduce`.
  test("map, filter and reduce callbacks all free their nested-block locals", async () => {
    const r = await compileAndRun(HOF_CHURN);
    expect(r.stdout).toBe("16\n0\n0\n"); // 16 is node's answer for the same file
    expect(r.exitCode).toBe(0);
  });

  /*
   * The boundary that made the drops safe to add at all, and the one behavior change
   * in this lane: a `.map` callback is a LOOP BODY. `const a: number[] = base` MOVES a
   * captured array into a body-local; dropping that local at the block's exit frees
   * `base` on the first element and again on every element after it.
   *
   * Walking the body once could not see that — the pass has no idea the callback runs
   * N times — so the naive fix compiled this into a double free (exit 255, no output,
   * against node's "11,12,13"). Running the body through the same `loop()` fixpoint a
   * `for-of` body gets catches the re-move on the second walk and REFUSES it, which is
   * exactly what the identical body written as a `for-of` already did.
   */
  test("a captured array MOVED into a callback local is refused, as in the for-of it inlines to", () => {
    const viaMap = `
const base: number[] = [10, 20];
const r = [1, 2, 3].map((x) => { let n = 0; if (x > 0) { const a: number[] = base; n = a[0] + x; } return n; });
console.log(r.join(","));`;
    const viaForOf = `
const base: number[] = [10, 20];
let total = 0;
for (const x of [1, 2, 3]) { let n = 0; if (x > 0) { const a: number[] = base; n = a[0] + x; } total = total + n; }
console.log(total);`;
    expect(ownCodes(viaForOf)).toContain("NT1601"); // the reference, refused before and after
    expect(ownCodes(viaMap)).toEqual(ownCodes(viaForOf));
  });

  /*
   * A REMAINING leak, pinned so the next lane sees the number rather than rediscovering
   * it. `scoped()` puts its drop marker LAST in the statement list, so a block that
   * ends in `return` never reaches it — and codegen's inlined-callback `return` path
   * stores the per-element result and branches to the join without emitting any drops
   * at all (a function `return` emits `s.drops` there; a callback `return` cannot,
   * because that list names the ENCLOSING scope's locals too and freeing those per
   * element would be a double free).
   *
   * So a callback whose body top-level allocates and then returns still leaks: 4 = the
   * result array + one `a` per element. Freeing this needs a drop set scoped to the
   * callback alone, which is a codegen change, not an ownership one. Leaking is the
   * safe side of that boundary and it is unchanged by this lane.
   */
  test("KNOWN GAP: a callback body that RETURNS does not reach its drop marker", async () => {
    const r = await compileAndRun(`
const r = [1, 2, 3].map((x) => { const a: number[] = [x, x]; return a[0]; });
console.log(r.join(","));
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("1,2,3\n4\n0\n");
    expect(r.exitCode).toBe(0);
  });

  /*
   * THE SAME GAP, in the shape the object counter exists to see: an arrow BOUND inside a
   * callback body. `test/closure-env-drops.test.ts` frees exactly this binding when it is
   * only ever called — and it is here — but the drop marker sits after the callback's
   * `return`, so it is never reached and one env leaks per element. Nothing here is an
   * array, so `__arrLive()` reads 0 and this file could not have seen it before.
   *
   * Closing it is the same codegen change the gap above needs (a drop set scoped to the
   * callback), not a widening of the ownership rule — the ownership pass already marked
   * this binding droppable.
   */
  test("KNOWN GAP: an arrow BOUND inside a callback body leaks one env per element", async () => {
    const r = await compileAndRun(`
function run(): number {
  const src: number[] = [1, 2, 3];
  const out: number[] = src.map((x) => { const g = (y: number): number => y * 2; return g(x); });
  return out[2];
}
console.log(run());
console.log(__arrLive());
console.log(__objLive());`);
    expect(r.stdout).toBe("6\n0\n3\n"); // node prints 6
    expect(r.exitCode).toBe(0);
  });

  /*
   * The sanitizer gate, and the only assertion here that can see a double free or a
   * use-after-free — the live counters above would balance to zero just as happily
   * while the program read freed memory. Same construction as
   * test/transients.test.ts: ASan + UBSan, `-fno-sanitize-recover` so every finding is
   * fatal, and LSan left OFF (it does not exist on macOS, and nativets leaks
   * deliberately at the boundaries docs/divergences.md records). The leak half is
   * gated precisely by `__arrLive()` AND `__objLive()` in the tests above.
   */
  test("ASan + UBSan: the callback drop paths are free of double frees and use-after-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "nativets-hofasan-"));
    try {
      const ll = join(dir, "module.ll");
      writeFileSync(ll, emitIR(HOF_CHURN));
      const bin = join(dir, "prog");
      const built = spawnSync("clang", [
        "-O1", "-g", "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
        ll, join(ROOT, "runtime/runtime.c"), "-lm", "-o", bin,
      ], { encoding: "utf8" });
      expect(built.status).toBe(0);
      const run = spawnSync(bin, [], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
      expect(run.stderr).not.toContain("AddressSanitizer");
      expect(run.stderr).not.toContain("runtime error");
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("16\n0\n0\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
